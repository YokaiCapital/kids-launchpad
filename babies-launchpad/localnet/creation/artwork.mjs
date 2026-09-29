// Internal v3 pilot service. Compose only behind wallet auth, origin/CSRF and a
// bounded binary request parser. Separate media replicas from financial workers.
import {randomUUID,createHash} from 'node:crypto';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {IMAGE_POLICY_VERSION,MAX_OUTPUT_BYTES,IMAGE_SHAPES,validateImageInput} from './image-policy.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),key=/^[A-Za-z0-9_.:-]{1,128}$/,LEASE_MS=90000;
const error=(message,code='MEDIA_CONFLICT')=>Object.assign(Error(message),{code});
export function createArtworkService({registry,config,storage,sanitize,limits,log=()=>{}}){
 if(registry?.driver!=='postgres'||!creationMode(config?.mode)||config.programVersion!==3||!config.pilotCreator||!storage?.read||!storage?.put||!storage?.verifyPrivacy||typeof sanitize!=='function'||!/^[a-f0-9]{64}$/.test(storage.storageId??''))throw Error('Private shared artwork needs an isolated v3 pilot');
 const ownerAllowed=config.pilotCreator,caps=structuredClone(limits);
 for(const k of ['ownerAttempts','globalAttempts','ownerBytes','globalBytes','ownerActive','globalActive'])if(!Number.isSafeInteger(caps?.[k])||caps[k]<1)throw Error('Explicit media quotas required');
 if(caps.ownerActive>caps.globalActive||caps.globalActive>32)throw Error('Invalid media concurrency');
 const fixed={storageId:storage.storageId,version:IMAGE_POLICY_VERSION},policy=canonicalJson({caps,...fixed}),q=(s,p=[])=>registry.query(s,p);
 const owned=async(owner,assetId)=>{if(owner!==ownerAllowed||!key.test(assetId??''))throw error('Artwork unavailable');return (await q('SELECT * FROM creation_artwork WHERE owner=? AND asset_id=?',[owner,assetId])).rows[0];};
 const describe=r=>({assetId:r.asset_id,kind:r.kind,status:r.state,sha256:r.sha256??null,size:r.byte_count==null?null:Number(r.byte_count),width:r.width,height:r.height,contentType:r.state==='ready'?'image/png':null});
 async function assertPolicy(){
  await q('INSERT INTO creation_artwork_policy(singleton,body) VALUES(1,?) ON CONFLICT(singleton) DO NOTHING',[policy]);
  const stored=(await q('SELECT body FROM creation_artwork_policy WHERE singleton=1')).rows[0].body;if(stored===policy)return;
  // The storage identity and the image policy version decide what stored bytes mean and stay pinned across services.
  // Quotas and concurrency are operational and ship with the code: a deploy with new caps replaces the stored ones
  // (28 September 2026: a caps change alone refused every upload with 'policy differs').
  let previous=null;try{previous=JSON.parse(stored);}catch{previous=null;}
  if(!previous||previous.storageId!==fixed.storageId||previous.version!==fixed.version)throw error('Artwork policy differs across services','MEDIA_POLICY_CONFLICT');
  await q('UPDATE creation_artwork_policy SET body=? WHERE singleton=1 AND body=?',[policy,stored]);
  log({event:'artwork-policy-caps-updated',previous:previous.caps,caps});
 }
 // Short cache and single flight for readiness, with failures never cached.
 let checked=0,checking=null;
 async function privacy(){if(Date.now()-checked<30000)return;if(!checking)checking=storage.verifyPrivacy().then(ok=>{if(ok!==true)throw error('Private storage not verified');checked=Date.now();}).finally(()=>checking=null);await checking;}
 return {
  async upload(owner,{requestId,kind,contentType,bytes}){
   if(owner!==ownerAllowed||!key.test(requestId??''))throw error('Artwork unavailable');
   validateImageInput(bytes,contentType,kind);bytes=Buffer.from(bytes);
   const sourceHash=hash(bytes);await privacy();
   const admission=await registry.transaction(async()=>{
    await assertPolicy();
    const previous=(await q('SELECT * FROM creation_artwork WHERE owner=? AND request_key=?',[owner,requestId])).rows[0];
    if(previous&&(previous.source_hash!==sourceHash||previous.kind!==kind||previous.source_type!==contentType||previous.policy_version!==IMAGE_POLICY_VERSION))throw error('Artwork request changed');
    const time=(await q("SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms,TO_CHAR(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day")).rows[0],now=Number(time.ms);
    if(previous&&(previous.state==='ready'||previous.state==='failed'||Number(previous.lease_until)>now))return {perform:false,row:previous};
    if(previous&&previous.attempts>=3){await q("UPDATE creation_artwork SET state='failed',lease_token=NULL,lease_until=0,updated_at=? WHERE asset_id=?",[now,previous.asset_id]);return {perform:false,row:{...previous,state:'failed'}};}
    const active=(await q("SELECT owner,COUNT(*) AS n FROM creation_artwork WHERE state='processing' AND lease_until>? GROUP BY owner",[now])).rows;
    if(active.reduce((sum,r)=>sum+Number(r.n),0)>=caps.globalActive||Number(active.find(r=>r.owner===owner)?.n??0)>=caps.ownerActive)throw error('Artwork processing is busy','MEDIA_BUSY');
    const chargedBytes=bytes.length+MAX_OUTPUT_BYTES;
    for(const [scope,attempts,maxBytes] of [['global',caps.globalAttempts,caps.globalBytes],['owner:'+owner,caps.ownerAttempts,caps.ownerBytes]]){
     const used=(await q('SELECT * FROM creation_artwork_usage WHERE day=? AND scope=?',[time.day,scope])).rows[0];
     if(Number(used?.attempts??0)+1>attempts||Number(used?.bytes??0)+chargedBytes>maxBytes)throw error('Artwork daily allowance reached','MEDIA_QUOTA');
     await q('INSERT INTO creation_artwork_usage(day,scope,attempts,bytes) VALUES(?,?,1,?) ON CONFLICT(day,scope) DO UPDATE SET attempts=creation_artwork_usage.attempts+1,bytes=creation_artwork_usage.bytes+excluded.bytes',[time.day,scope,chargedBytes]);
    }
    const assetId=previous?.asset_id??randomUUID(),token=randomUUID();
    if(previous)await q("UPDATE creation_artwork SET state='processing',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE asset_id=?",[token,now+LEASE_MS,now,assetId]);
    else await q("INSERT INTO creation_artwork(asset_id,owner,request_key,source_hash,source_bytes,source_type,kind,policy_version,state,attempts,lease_token,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'processing',1,?,?,?,?)",[assetId,owner,requestId,sourceHash,bytes.length,contentType,kind,IMAGE_POLICY_VERSION,token,now+LEASE_MS,now,now]);
    return {perform:true,assetId,token};
   },{lockKey:'creation-artwork-admission'});
   if(!admission.perform)return describe(admission.row);
   const {assetId,token}=admission;
   try{
    const image=await sanitize({bytes,contentType,kind}),shape=IMAGE_SHAPES[kind];
    if(image?.sanitized!==true||image.policyVersion!==IMAGE_POLICY_VERSION||!Buffer.isBuffer(image.bytes)||image.bytes.length>MAX_OUTPUT_BYTES||image.bytes.length<24||hash(image.bytes)!==image.sha256||image.contentType!=='image/png'||image.width!==image.height*shape.ratio||image.width>shape.width||image.height>shape.height||image.width<32||image.height<32)throw error('Artwork sanitizer result invalid');
    const objectKey='creator-artwork/'+canonicalHash({owner,assetId,sha256:image.sha256,policy:IMAGE_POLICY_VERSION})+'.png';
    const saved=await storage.put(objectKey,image);
    if(saved?.sha256!==image.sha256||saved.byteCount!==image.bytes.length)throw error('Private artwork receipt differs');
    await q("UPDATE creation_artwork SET state='ready',object_key=?,sha256=?,byte_count=?,width=?,height=?,lease_token=NULL,lease_until=0,updated_at=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) WHERE asset_id=? AND state='processing' AND lease_token=? AND lease_until>CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)",[objectKey,image.sha256,image.bytes.length,image.width,image.height,assetId,token]);
   }catch(e){
    await q("UPDATE creation_artwork SET state='pending',lease_token=NULL,lease_until=0,updated_at=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) WHERE asset_id=? AND state='processing' AND lease_token=?",[assetId,token]);
    // No provider error bodies/credentials or decoder internals reach the client.
    throw error(e?.code==='MEDIA_BUSY'?'Artwork processing is busy':'Artwork processing did not complete. Retry the same upload.',e?.code==='MEDIA_BUSY'?'MEDIA_BUSY':'MEDIA_PENDING');
   }
   return describe(await owned(owner,assetId));
  },
  async status(owner,assetId){await assertPolicy();const row=await owned(owner,assetId);return row?describe(row):null;},
  async loadOwnedImage({owner,assetId}){
   const row=await owned(owner,assetId);if(!row||row.state!=='ready')throw error('Artwork unavailable');
   await assertPolicy();await privacy();const image=await storage.read(row.object_key);
   if(!image||image.sha256!==row.sha256||image.policyVersion!==IMAGE_POLICY_VERSION||image.bytes.length!==Number(row.byte_count)||hash(image.bytes)!==row.sha256)throw error('Artwork integrity check failed');
   return {...image,owner,assetId,kind:row.kind,width:row.width,height:row.height,sanitized:true};
  },
 };
}
