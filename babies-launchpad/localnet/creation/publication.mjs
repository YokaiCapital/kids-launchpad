// Internal worker, disabled unless composed explicitly for the v3 local pilot.
// loadOwnedImage reads a private, sanitized object by assetId; it must enforce
// owner binding in the object store. Never implement it by fetching a draft URL.
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {metadataDocument,PINATA_GATEWAY} from '../token-metadata.mjs';
import {contentHash,validCid} from './pinata.mjs';
import {cidV0,IPFS_CHUNK_BYTES} from './ipfs-cid.mjs';
import {VIDEO_POLICY_VERSION,VIDEO_MAX_OUTPUT_BYTES,VIDEO_POSTER_MAX_BYTES,VIDEO_MAX_SECONDS} from './video-policy.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const conflict=()=>Object.assign(Error('Publication differs from accepted creator artwork'),{code:'PUBLICATION_CONFLICT'});
const keyId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const text=(s,n)=>typeof s==='string'&&s.trim()&&Buffer.byteLength(s)<=n&&!/[\x00-\x1f\x7f]/.test(s);
const RECEIPT_COLUMNS='operation_id,request_id,owner,stage,descriptor_hash,input_hash,byte_count,state,cid,created_at,updated_at';
const DB_NOW='CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)';
// Background pin of a sealed receipt: exponential backoff capped at thirty seconds (a short funding round must never outlive
// the backoff: the launch waits for these pins); an unresolved alert at the fourth attempt (about half a minute after the
// seal) and then every tenth (about every five minutes). The receipt stays 'sealed' (explicitly unresolved), never
// 'published' by exhaustion.
const PIN_BACKOFF_MS=attempts=>Math.min(5000*2**Math.min(attempts,10),30000),PIN_ALERT_AT=4,PIN_ALERT_EVERY=10;

export function createMetadataPublisher({registry,config,loadOwnedImage,loadOwnedVideo=null,provider,limits,maxActive=2,log=()=>{}}){
 if(registry?.driver!=='postgres'||typeof loadOwnedImage!=='function'||!provider?.publish||!provider?.recover)throw Error('Publication needs shared storage and an owned-image reader');
 if(!creationMode(config?.mode)||config.programVersion!==3||!config.pilotCreator)throw Error('Publication is an isolated v3 pilot only');
 if(!Number.isInteger(maxActive)||maxActive<1||maxActive>4)throw Error('Bounded publication concurrency required');const inFlight=new Map();
 const scope=structuredClone(config),caps=structuredClone(limits);
 for(const key of ['ownerPins','globalPins','ownerBytes','globalBytes'])if(!Number.isSafeInteger(caps?.[key])||caps[key]<1)throw Error('Explicit positive shared publication quotas required');
 // Funding-first creations seal the metadata document (and a token image of at most one IPFS chunk) with the content id
 // computed from the exact bytes (ipfs-cid.mjs): the URI is final at once, the provider pin runs in the background
 // (tickSealed) and must answer the same id. The first receipt that contradicts the local computation turns sealing off
 // for this process and is logged; a contradiction is never hidden behind the provider's id.
 let sealing=scope.fundingFirst===true,sealConfirmed=false;
 const sealable=(input,preflight)=>sealing&&!preflight&&['image','document'].includes(input.stage)&&Buffer.isBuffer(input.bytes)&&input.bytes.length<=IPFS_CHUNK_BYTES;
 const distrust=(event,detail)=>{log({event,...detail});if(sealing){sealing=false;log({event:'publication-sealing-disabled',reason:event,requestId:detail.requestId??null});}};
 const table=(stage,preflight=false)=>preflight?'creation_prepublication_receipts':['banner','video','poster'].includes(stage)?'creation_media_publications':['image','document'].includes(stage)?'creation_publications':(()=>{throw conflict();})();
 const query=(s,p=[])=>registry.query(s,p),raw=async(id,stage,preflight=false)=>(await query('SELECT * FROM '+table(stage,preflight)+' WHERE request_id=? AND stage=?',[id,stage])).rows[0];
 async function source(owner,requestId,coreOnly=false,preflight=false){
  if(owner!==scope.pilotCreator||!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId||''))throw conflict();
  const r=(await query('SELECT * FROM '+(preflight?'creation_prepublications':'creation_requests')+' WHERE request_id=? AND owner=?',[requestId,owner])).rows[0];
  if(!r||(!preflight&&r.state!=='accepted'))throw conflict();const accepted=JSON.parse(r.body),draft=accepted.draft,q=accepted.quote;
  if(canonicalHash(draft)!==accepted.draftHash||preflight&&(draft.publicationConsent!==true||draft.mode!=='standard')||!preflight&&(q?.genesisHash!==scope.genesisHash||q.programId!==scope.programId||q.terms?.mode!=='standard'||q.fundingEnabled!==false||q.publicationConsent!==true))throw conflict();
  if(!text(draft?.name,32)||!text(draft.symbol,10)||/\s/.test(draft.symbol)||typeof draft.description!=='string'||Buffer.byteLength(draft.description)>600||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(draft.description))throw conflict();
  const p=draft.pfp;if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(p?.assetId||'')||!/^[a-f0-9]{64}$/.test(p.sha256||''))throw conflict();
  const owned=await loadOwnedImage({owner,assetId:p.assetId});
  if(owned?.owner!==owner||owned.assetId!==p.assetId||owned.sanitized!==true||owned.sha256!==p.sha256||!Buffer.isBuffer(owned.bytes)||owned.bytes.length<8||owned.bytes.length>2_000_000||contentHash(owned.bytes)!==p.sha256)throw conflict();
  const bytes=Buffer.from(owned.bytes),type=owned.contentType;
  if(type==='image/png'?!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):type==='image/jpeg'?!bytes.subarray(0,3).equals(Buffer.from([255,216,255])):true)throw conflict();
  let banner=null;if(!coreOnly&&draft.banner){const b=draft.banner;if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(b.assetId||'')||!/^[a-f0-9]{64}$/.test(b.sha256||''))throw conflict();const image=await loadOwnedImage({owner,assetId:b.assetId});if(image?.owner!==owner||image.assetId!==b.assetId||image.kind!=='banner'||image.sanitized!==true||image.sha256!==b.sha256||!Buffer.isBuffer(image.bytes)||image.bytes.length<8||image.bytes.length>2_000_000||contentHash(image.bytes)!==b.sha256||image.contentType!=='image/png'||!image.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw conflict();banner={bytes:Buffer.from(image.bytes),contentType:image.contentType,inputHash:b.sha256};}
  let video=null,poster=null;if(!coreOnly&&draft.video){
   const v=draft.video;if(typeof loadOwnedVideo!=='function'||!keyId(v.assetId)||!/^[a-f0-9]{64}$/.test(v.sha256??'')||!/^[a-f0-9]{64}$/.test(v.posterHash??''))throw conflict();
   const item=await loadOwnedVideo({owner,assetId:v.assetId}),p=item?.poster;
   if(item?.owner!==owner||item.assetId!==v.assetId||item.sanitized!==true||item.policyVersion!==VIDEO_POLICY_VERSION||item.sha256!==v.sha256||!Buffer.isBuffer(item.bytes)||item.bytes.length<24||item.bytes.length>VIDEO_MAX_OUTPUT_BYTES||contentHash(item.bytes)!==v.sha256||item.contentType!=='video/mp4'||item.width!==1280||item.height!==720||!Number.isSafeInteger(item.durationMs)||item.durationMs<1||item.durationMs>VIDEO_MAX_SECONDS*1000||!p||p.sha256!==v.posterHash||!Buffer.isBuffer(p.bytes)||p.bytes.length>VIDEO_POSTER_MAX_BYTES||contentHash(p.bytes)!==v.posterHash||p.contentType!=='image/png')throw conflict();
   video={bytes:Buffer.from(item.bytes),contentType:'video/mp4',inputHash:v.sha256};poster={bytes:Buffer.from(p.bytes),contentType:'image/png',inputHash:v.posterHash};
  }
  return {draft,bytes,type,banner,video,poster,descriptor:canonicalHash({accepted,owner,requestId,assetId:p.assetId,imageHash:p.sha256})};
 }
 async function stage(owner,requestId,descriptor,input,preflight=false){
  const operationId=canonicalHash({kind:preflight?'creation-prepublication-v1':'creation-publication-v1',requestId,stage:input.stage,descriptor,inputHash:input.inputHash});
  const sealedCid=sealable(input,preflight)?cidV0(input.bytes):null;
  // Both the attempted provider write and its billable quota are committed first.
  // The global daily row serializes only this short DB admission, never HTTP work.
  const admission=await registry.transaction(async()=>{
   const policy=canonicalJson(caps);
   await query('INSERT INTO creation_publication_policy(singleton,body) VALUES(1,?) ON CONFLICT(singleton) DO NOTHING',[policy]);
   // Quotas ship with the code: a deploy with new caps replaces the stored ones (logged) instead of refusing every
   // publication (28 September 2026). A body that is not a quota record at all is a conflict.
   const stored=(await query('SELECT body FROM creation_publication_policy WHERE singleton=1')).rows[0].body;
   if(stored!==policy){let previous=null;try{previous=JSON.parse(stored);}catch{previous=null;}
    if(!previous||typeof previous!=='object')throw Object.assign(Error('Publication quotas differ across services'),{code:'PUBLICATION_POLICY_CONFLICT'});
    await query('UPDATE creation_publication_policy SET body=? WHERE singleton=1 AND body=?',[policy,stored]);log({event:'publication-quotas-updated',previous,caps});}
   const previous=await raw(requestId,input.stage,preflight);
   if(previous){if(previous.operation_id!==operationId||previous.descriptor_hash!==descriptor)throw conflict();return {row:previous,perform:false};}
   // A prepared receipt is reusable only for this owner and the exact content hash.
   // A still-uncertain provider write is reconciled under its original operation ID (a sealed input needs no reconciliation:
   // its id is fixed by the bytes, so it is sealed now and pinned in the background).
   if(['image','document'].includes(input.stage)){
    const receiptQuery="SELECT "+RECEIPT_COLUMNS+", 'creation_prepublication_receipts' AS receipt_table FROM creation_prepublication_receipts WHERE owner=? AND stage=? AND input_hash=?";
    const prepared=(await query(receiptQuery+(preflight?" UNION ALL SELECT "+RECEIPT_COLUMNS+", 'creation_publications' AS receipt_table FROM creation_publications WHERE owner=? AND stage=? AND input_hash=? AND state IN ('publishing','published')":"")+' ORDER BY created_at LIMIT 1',[owner,input.stage,input.inputHash,...(preflight?[owner,input.stage,input.inputHash]:[])])).rows[0];
    if(prepared&&prepared.state!=='published'){if(!sealedCid)return {prepared};}
    else if(prepared){
     if(!validCid(prepared.cid))throw conflict();
     // The provider's verified id for the same bytes checks the local computation: an equal id confirms it, a different
     // id disproves it. The verified id is the one reused either way.
     if(sealedCid&&prepared.cid!==sealedCid)distrust('publication-seal-contradicted',{requestId,stage:input.stage,cid:sealedCid,providerCid:prepared.cid});
     else if(sealedCid&&!sealConfirmed){sealConfirmed=true;log({event:'publication-seal-confirmed',requestId,stage:input.stage,cid:sealedCid});}
     await query("INSERT INTO "+table(input.stage,preflight)+"(operation_id,request_id,owner,stage,descriptor_hash,input_hash,byte_count,state,cid,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'published',?, ?, ?)",[operationId,requestId,owner,input.stage,descriptor,input.inputHash,input.byteCount,prepared.cid,prepared.created_at,prepared.updated_at]);
     return {row:await raw(requestId,input.stage,preflight),perform:false};
    }
   }
   const time=(await query("SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms,TO_CHAR(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day")).rows[0];
   for(const [bucket,pins,bytes] of [['global',caps.globalPins,caps.globalBytes],['owner:'+owner,caps.ownerPins,caps.ownerBytes]]){
    const used=(await query('SELECT * FROM creation_publication_usage WHERE day=? AND scope=?',[time.day,bucket])).rows[0];
    if(Number(used?.pins??0)+1>pins||Number(used?.bytes??0)+input.byteCount>bytes)throw Object.assign(Error('Publication daily quota reached'),{code:'PUBLICATION_QUOTA'});
    await query('INSERT INTO creation_publication_usage(day,scope,pins,bytes) VALUES(?,?,1,?) ON CONFLICT(day,scope) DO UPDATE SET pins=creation_publication_usage.pins+1,bytes=creation_publication_usage.bytes+excluded.bytes',[time.day,bucket,input.byteCount]);
   }
   if(sealedCid){
    await query("INSERT INTO creation_publications("+RECEIPT_COLUMNS+",attempts,next_attempt_at) VALUES(?,?,?,?,?,?,?,'sealed',?,?,?,0,?)",[operationId,requestId,owner,input.stage,descriptor,input.inputHash,input.byteCount,sealedCid,time.ms,time.ms,time.ms]);
    return {row:await raw(requestId,input.stage,false),perform:false,sealed:true};
   }
   await query("INSERT INTO "+table(input.stage,preflight)+"(operation_id,request_id,owner,stage,descriptor_hash,input_hash,byte_count,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'publishing',?,?)",[operationId,requestId,owner,input.stage,descriptor,input.inputHash,input.byteCount,time.ms,time.ms]);
   return {row:await raw(requestId,input.stage,preflight),perform:true};
  },{lockKey:'creation-publication-admission'});
  if(admission.prepared){
   let receipt;try{receipt=await provider.recover({...input,operationId:admission.prepared.operation_id});}catch{return null;}
   if(!receipt)return null;
   if(!validCid(receipt.cid)||receipt.uri!==PINATA_GATEWAY+receipt.cid||receipt.inputHash!==input.inputHash)throw conflict();
   await query("UPDATE "+admission.prepared.receipt_table+" SET state='published',cid=?,updated_at=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) WHERE operation_id=? AND state='publishing'",[receipt.cid,admission.prepared.operation_id]);
   return stage(owner,requestId,descriptor,input,preflight);
  }
  const row=admission.row;
  if(admission.sealed)log({event:'publication-sealed',requestId,stage:input.stage,cid:row.cid,byteCount:input.byteCount});
  if(row.state==='published')return {cid:row.cid,uri:PINATA_GATEWAY+row.cid};
  if(row.state==='sealed'){if(sealedCid&&row.cid!==sealedCid)throw conflict();return {cid:row.cid,uri:PINATA_GATEWAY+row.cid,sealed:true};}
  if(row.state==='attention')return {attention:true};
  let receipt;
  try{receipt=await provider[admission.perform?'publish':'recover']({...input,operationId});}catch{return null;}
  if(!receipt)return null;
  if(!validCid(receipt.cid)||receipt.uri!==PINATA_GATEWAY+receipt.cid||receipt.inputHash!==input.inputHash)throw conflict();
  await query("UPDATE "+table(input.stage,preflight)+" SET state='published',cid=?,updated_at=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) WHERE operation_id=? AND state='publishing'",[receipt.cid,operationId]);
  const saved=await raw(requestId,input.stage,preflight);if(saved.cid!==receipt.cid||saved.state!=='published')throw conflict();
  return receipt;
 }
 async function perform(owner,requestId,coreOnly,preflight=false){
  const s=await source(owner,requestId,coreOnly,preflight);
  // Independent media uploads share the request's bounded admission. Metadata alone
  // depends on the image URI; a banner or video must not delay that dependency.
  const token=async()=>{
   const image=await stage(owner,requestId,s.descriptor,{stage:'image',bytes:s.bytes,contentType:s.type,inputHash:contentHash(s.bytes),byteCount:s.bytes.length},preflight);
   if(!image)return {pending:'image'};if(image.attention)return {pending:'image',reason:'publication-attention'};
   // The document is one exact byte sequence (canonical JSON): what is hashed, what is sealed and what is pinned.
   const document=metadataDocument(s.draft,image.uri,{imageType:s.type}),documentHash=canonicalHash(document),documentBytes=Buffer.from(canonicalJson(document));
   const published=await stage(owner,requestId,s.descriptor,{stage:'document',document,bytes:documentBytes,inputHash:documentHash,byteCount:documentBytes.length},preflight);
   if(!published)return {pending:'document'};if(published.attention)return {pending:'document',reason:'publication-attention'};
   return {image,document,documentHash,published};
  };
  const kinds=['banner','video','poster'];
  const results=await Promise.allSettled([token(),...kinds.map(kind=>s[kind]?stage(owner,requestId,s.descriptor,{stage:kind,...s[kind],byteCount:s[kind].bytes.length}):null)]);
  const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
  const [{value:core},...media]=results;if(core.pending)return {status:'pending',stage:core.pending,reason:core.reason??'publication-unresolved'};
  for(let i=0;i<kinds.length;i++)if(s[kinds[i]]&&!media[i].value)return {status:'pending',stage:kinds[i],reason:'publication-unresolved'};
  const {image,document,documentHash,published}=core,[banner,video,poster]=media.map(result=>result.value);

  // 'sealed': every URI is final, at least one pin is still being confirmed in the background (identity, not availability);
  // 'published': both pins are confirmed. Consumers that create the token must see 'published' (publication-readiness.mjs).
  const pins={image:image.sealed?'sealed':'published',document:published.sealed?'sealed':'published'};
  return {status:pins.image==='sealed'||pins.document==='sealed'?'sealed':'published',requestId,owner,videoUri:video?.uri??null,posterUri:poster?.uri??null,bannerUri:banner?.uri??null,imageUri:image.uri,document,metadata:{name:s.draft.name,symbol:s.draft.symbol,uri:published.uri,documentHash},pins};
 }
 async function publish(owner,requestId,coreOnly=false,preflight=false){
  if(owner!==scope.pilotCreator||!keyId(requestId))throw conflict();
  // Identical immutable requests share their source buffers and result. Different
  // requests are admitted only while bounded processing capacity is available.
  const key=canonicalHash({owner,requestId,coreOnly,preflight});
  if(inFlight.has(key))return inFlight.get(key);
  if(inFlight.size>=maxActive)return {status:'pending',stage:'publication',reason:'publication-busy'};
  const pending=perform(owner,requestId,coreOnly,preflight).finally(()=>inFlight.delete(key));
  inFlight.set(key,pending);return pending;
 }
 let preTimer=null,preRunning=null,sealRunning=null,closed=false;
 async function tickPrepublication(){
  if(closed||preRunning)return preRunning;
  preRunning=(async()=>{
   const row=(await query("SELECT * FROM creation_prepublications WHERE owner=? AND state='pending' AND next_run<=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) ORDER BY next_run,created_at LIMIT 1",[scope.pilotCreator])).rows[0];if(!row)return;
   try{const result=await publish(row.owner,row.request_id,true,true);
    await query("UPDATE creation_prepublications SET state=?,failures=0,next_run=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)+2000 WHERE request_id=?",[result.status==='published'?'published':'pending',row.request_id]);
   }catch{await query("UPDATE creation_prepublications SET failures=failures+1,state=CASE WHEN failures>=9 THEN 'attention' ELSE 'pending' END,next_run=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)+5000 WHERE request_id=?",[row.request_id]);}
  })().finally(()=>{preRunning=null;});return preRunning;
 }
 // The exact bytes of a sealed receipt, rebuilt from the accepted request and the owned artwork (no blob is stored): they
 // must hash to the receipt's input hash and compute to its sealed id, or the receipt cannot be pinned at all.
 async function sealedInput(row){
  const s=await source(row.owner,row.request_id,true);
  if(s.descriptor!==row.descriptor_hash)throw conflict();
  if(row.stage==='image'){
   if(contentHash(s.bytes)!==row.input_hash||cidV0(s.bytes)!==row.cid)throw conflict();
   return {stage:'image',operationId:row.operation_id,inputHash:row.input_hash,bytes:s.bytes,contentType:s.type,cid:row.cid};
  }
  const image=await raw(row.request_id,'image');if(!image||!validCid(image.cid))throw conflict();
  const document=metadataDocument(s.draft,PINATA_GATEWAY+image.cid,{imageType:s.type}),bytes=Buffer.from(canonicalJson(document));
  if(canonicalHash(document)!==row.input_hash||cidV0(bytes)!==row.cid)throw conflict();
  return {stage:'document',operationId:row.operation_id,inputHash:row.input_hash,document,bytes,cid:row.cid};
 }
 const attention=row=>query("UPDATE creation_publications SET state='attention',updated_at="+DB_NOW+" WHERE operation_id=? AND state='sealed'",[row.operation_id]);
 /** Pins one due sealed receipt (returns true when a receipt was due). The attempt is journaled before the provider is
  * asked; a lost answer is recovered under the same operation first. The provider must answer the sealed id exactly. */
 async function tickSealed(){
  if(closed||sealRunning)return sealRunning;
  sealRunning=(async()=>{
   const row=(await query("SELECT * FROM creation_publications WHERE owner=? AND state='sealed' AND next_attempt_at<="+DB_NOW+" ORDER BY next_attempt_at,created_at LIMIT 1",[scope.pilotCreator])).rows[0];if(!row)return false;
   const attempts=Number(row.attempts),attempt=attempts+1,detail={requestId:row.request_id,stage:row.stage,operationId:row.operation_id,cid:row.cid,attempt};
   const claimed=(await query("UPDATE creation_publications SET attempts=attempts+1,next_attempt_at="+DB_NOW+"+? WHERE operation_id=? AND state='sealed' AND attempts=? RETURNING operation_id",[PIN_BACKOFF_MS(attempt),row.operation_id,attempts])).rows.length;
   if(!claimed)return true;
   let input;
   try{input=await sealedInput(row);}
   catch(error){if(error?.code==='PUBLICATION_CONFLICT'){await attention(row);log({event:'publication-seal-rebuild-mismatch',...detail});}return true;}
   let receipt=null;
   try{
    if(attempts>0)receipt=await provider.recover(input);
    // A sealed id is fixed by the bytes, so a second post of the same bytes after an unrecoverable answer pins the same
    // content again (the provider keeps one copy per id); it is never a different pin.
    if(!receipt)receipt=await provider.publish(input);
   }catch(error){
    if(error?.code==='PUBLICATION_CID_MISMATCH'){await attention(row);distrust('publication-cid-mismatch',{...detail,providerCid:error.providerCid??null});return true;}
    if(attempt===PIN_ALERT_AT||attempt>PIN_ALERT_AT&&(attempt-PIN_ALERT_AT)%PIN_ALERT_EVERY===0)log({event:'publication-pin-unresolved',...detail,category:error?.code??'provider'});
    return true;
   }
   if(!validCid(receipt?.cid)||receipt.cid!==row.cid||receipt.uri!==PINATA_GATEWAY+row.cid||receipt.inputHash!==row.input_hash){await attention(row);distrust('publication-cid-mismatch',{...detail,providerCid:validCid(receipt?.cid)?receipt.cid:null});return true;}
   await query("UPDATE creation_publications SET state='published',updated_at="+DB_NOW+" WHERE operation_id=? AND state='sealed'",[row.operation_id]);
   log({event:'publication-pinned',...detail});return true;
  })().finally(()=>{sealRunning=null;});return sealRunning;
 }
 async function prepareDraft(owner,{draftId,revision}){
  if(owner!==scope.pilotCreator||!keyId(draftId)||!Number.isSafeInteger(revision)||revision<1)throw conflict();
  const saved=await registry.drafts.get(owner,draftId);
  if(!saved||saved.revision!==revision||saved.status!=='draft'||saved.body.publicationConsent!==true||saved.body.mode!=='standard')throw conflict();
  const draft=saved.body;if(!text(draft.name,32)||!text(draft.symbol,10)||/\s/.test(draft.symbol)||!keyId(draft.pfp?.assetId))throw conflict();
  const draftHash=canonicalHash(draft),requestId=canonicalHash({owner,draftId,revision,draftHash});
  // Saving the consent and content first makes the preparation recoverable after process loss.
  await query("INSERT INTO creation_prepublications(request_id,owner,draft_id,revision,body,created_at) VALUES(?,?,?,?,?,CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)) ON CONFLICT(request_id) DO NOTHING",[requestId,owner,draftId,revision,canonicalJson({draft,draftHash})]);
  void tickPrepublication().catch(()=>{});
  const row=(await query('SELECT state FROM creation_prepublications WHERE request_id=?',[requestId])).rows[0];
  return {draftId,revision,status:row.state};
 }
 const tick=()=>{void tickPrepublication().catch(()=>{});void tickSealed().catch(()=>{});};
 return {publish,publishCore:(owner,requestId)=>publish(owner,requestId,true),prepareDraft,tickPrepublication,tickSealed,
  start(){preTimer=setInterval(tick,1000);preTimer.unref?.();tick();},
  async close(){closed=true;clearInterval(preTimer);await Promise.allSettled([preRunning,sealRunning,...inFlight.values()]);}
 };

}
