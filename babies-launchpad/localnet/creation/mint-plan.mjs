// Trusted shared plan source for the mint approval journal. No HTTP caller can
// choose instructions, metadata URI, custody, supply, mint or rent through it.
import {createMintIntent,mintIntentHash} from './mint-packet.mjs';
import {reviewedProvisionPolicy} from './provision-packet.mjs';
import {parseUtcInput} from '../../interaction-review/src/public/launch-draft.mjs';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {PINATA_GATEWAY} from '../token-metadata.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const conflict=()=>Object.assign(Error('Mint plan differs from accepted creation'),{code:'IDEMPOTENCY_CONFLICT'});
import {acceptedScope} from './accepted-scope.mjs';
import {acceptedReserveLamports} from './operating-reserve.mjs';
export function createMintPlanService({registry,connection,config,publisher,custody=null}){
 if(registry?.driver!=='postgres'||!publisher?.publish)throw Error('Mint plan needs shared publication storage');
 if(!creationMode(config?.mode)||config.programVersion!==3)throw Error('Mint plan is an isolated v3 pilot only');
 if(custody!==null&&(typeof custody.reserve!=='function'||typeof custody.view!=='function'))throw Error('Mint plan custody needs reserve and view');
 if(config.fundingFirst===true&&(config.oneTransaction!==true||!custody))throw Error('Funding-first creation needs the one-transaction path and the custody key reservation');
 const scope=structuredClone(config),url=new URL(scope.rpcUrl);
 if(!creationRpc(url,scope.mode)||connection.rpcEndpoint!==scope.rpcUrl)throw Error('Mint plan requires the configured loopback RPC');
 const query=(s,p=[])=>registry.query(s,p),raw=async id=>(await query('SELECT * FROM creation_mint_plans WHERE request_id=?',[id])).rows[0];
 async function accepted(requestId){
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId||''))throw conflict();
  const request=(await query('SELECT * FROM creation_requests WHERE request_id=? AND owner=?',[requestId,scope.pilotCreator])).rows[0];
  if(!request||request.state!=='accepted')throw conflict();const body=JSON.parse(request.body),q=body.quote;
  if(!acceptedScope(scope,q)||q.terms?.mode!=='standard'||q.fundingEnabled!==false||q.publicationConsent!==true||canonicalHash(body.draft)!==body.draftHash)throw conflict();
  const prep=(await query('SELECT * FROM creation_preparations WHERE request_id=?',[requestId])).rows[0];
  if(!prep||prep.state!=='reserved'||prep.program_version!==3||prep.descriptor_hash!==canonicalHash({requestId,owner:request.owner,body,programVersion:3})||prep.genesis_hash!==scope.genesisHash||prep.program_id!==scope.programId)throw conflict();
  const lease=await registry.mintLeases.get(prep.mint_lease_id);
  if(!lease||!['reserved','signed-pending','consumed'].includes(lease.state)||lease.mint!==prep.mint||lease.creator!==request.owner||lease.genesisHash!==scope.genesisHash||lease.programId!==scope.programId||lease.campaign!==prep.campaign||lease.idempotencyKey!=='asset:'+requestId||lease.draftId!=='asset:'+requestId)throw conflict();
  return {request,body,prep,lease,requestHash:canonicalHash({requestId,owner:request.owner,body,preparation:prep.descriptor_hash})};
 }
 // One creation transaction (28 September 2026): the mint plan also seals what the campaign creation, the setup budget
 // and the operating reserve need, so a single wallet approval covers them. '0' opens the campaign when it is created.
 function launchFor(source){
  if(scope.oneTransaction!==true)return null;
  const q=source.body.quote,draft=source.body.draft;
  if(!scope.operatingPayer)throw Error('One-transaction creation needs the operating payer');
  // The reserve amount is the accepted quote's (immutable), never the currently configured amount.
  const reserveLamports=acceptedReserveLamports(q);if(!reserveLamports)throw Error('Accepted quote carries no operating reserve');
  if(typeof q.authorityFunding?.amountLamports!=='string')throw Error('Accepted quote carries no setup budget');
  if(!['scheduled','after-creation'].includes(draft.start))throw Error('Unsupported start rule');
  const opensAt=draft.start==='scheduled'?String(parseUtcInput(draft.startUtc)):'0';
  if(draft.start==='scheduled'&&!/^[1-9][0-9]*$/.test(opensAt))throw Error('Scheduled start is not a time');
  return {policy:reviewedProvisionPolicy(q),treasury:scope.treasury,opensAt,authorityBudgetLamports:q.authorityFunding.amountLamports,reserve:{payer:scope.operatingPayer,lamports:reserveLamports},priorityFeeLamports:String(scope.priorityFeeLamports??'10000')};
 }
 // Funding-first accounting (29 September 2026): before the intent is sealed, the custody reserves the fee-NFT key beside the
 // reserved mint under the preparation's own binding and this campaign scope (durable in the inventory before it is shown,
 // idempotent: a re-seal after a crash gets the same key). The sealed intent then names it; the opening packet cannot be
 // offered before both key bindings exist. A mint whose custody already exists is funding-first whatever the admission
 // flag says now (the binding is durable and the asset route refuses such a mint); the flag admits NEW rounds only.
 async function fundingFirstFor(source,owner,requestId){
  if(!custody)return null;
  const p=source.prep,expected={genesisHash:scope.genesisHash,programId:scope.programId,campaign:p.campaign,requestId};
  const existing=await custody.view(p.mint);
  if(existing){if(Object.entries(expected).some(([k,v])=>existing[k]!==v)||typeof existing.feeNft!=='string')throw Error('Custody of this mint is bound to another campaign');return {feeNft:existing.feeNft};}
  if(scope.fundingFirst!==true)return null;
  const keys=await custody.reserve({creator:owner,draftId:'asset:'+requestId,idempotencyKey:'asset:'+requestId},expected);
  if(keys?.mint!==p.mint||typeof keys.feeNft!=='string'||keys.campaign!==p.campaign||keys.requestId!==requestId)throw Error('Custody reserved keys for another mint or campaign');
  return {feeNft:keys.feeNft};
 }
 async function validate(row,source){
  if(row.owner!==scope.pilotCreator||row.request_hash!==source.requestHash)throw conflict();
  const intent=JSON.parse(row.intent_json);
  if(mintIntentHash(intent)!==row.intent_hash||intent.requestId!==row.request_id||intent.creator!==scope.pilotCreator||intent.genesisHash!==scope.genesisHash||intent.programId!==scope.programId||intent.leaseId!==source.lease.leaseId||intent.mint!==source.prep.mint||intent.campaign!==source.prep.campaign||intent.authority!==source.prep.authority||intent.nonce!==source.prep.nonce||intent.metadata.name!==source.body.draft.name||intent.metadata.symbol!==source.body.draft.symbol)throw conflict();
  const receipts=(await query('SELECT * FROM creation_publications WHERE request_id=?',[row.request_id])).rows;
  const image=receipts.find(r=>r.stage==='image'),document=receipts.find(r=>r.stage==='document');
  const descriptor=canonicalHash({accepted:source.body,owner:scope.pilotCreator,requestId:row.request_id,assetId:source.body.draft.pfp.assetId,imageHash:source.body.draft.pfp.sha256});
  if(!image||!document||[image,document].some(r=>!['published','sealed'].includes(r.state)||r.owner!==scope.pilotCreator||r.descriptor_hash!==descriptor)||image.input_hash!==source.body.draft.pfp.sha256||document.input_hash!==intent.metadata.documentHash||PINATA_GATEWAY+document.cid!==intent.metadata.uri)throw conflict();
  return intent;
 }
 return {
  async load(requestId){const source=await accepted(requestId),row=await raw(requestId);if(!row)throw Error('Mint plan is not sealed');return validate(row,source);},
  async seal(owner,requestId){
   if(owner!==scope.pilotCreator)throw conflict();let source=await accepted(requestId),row=await raw(requestId);
   if(row)return {status:'sealed',intent:await validate(row,source)};
   if(source.lease.state!=='reserved')throw conflict();
   if(await connection.getGenesisHash()!==scope.genesisHash)throw Error('Mint plan ledger changed');
   const result=await (publisher.publishCore||publisher.publish)(owner,requestId);if(!['published','sealed'].includes(result.status))return result;
   if(result.owner!==owner||result.requestId!==requestId)throw conflict();
   const rent=await connection.getMinimumBalanceForRentExemption(82,'confirmed');
   if(!Number.isSafeInteger(rent)||rent<1)throw Error('Mint rent unavailable');
   if(await connection.getGenesisHash()!==scope.genesisHash)throw Error('Mint plan ledger changed');
   const p=source.prep,intent=createMintIntent({preparation:{programVersion:3,state:'reserved',fundingEnabled:false,requestId,leaseId:p.mint_lease_id,genesisHash:p.genesis_hash,programId:p.program_id,campaign:p.campaign,authority:p.authority,nonce:p.nonce,mint:p.mint},creator:owner,rentLamports:String(rent),metadata:result.metadata,launch:launchFor(source),fundingFirst:await fundingFirstFor(source,owner,requestId)});
   const candidate={request_id:requestId,owner,request_hash:source.requestHash,intent_hash:mintIntentHash(intent),intent_json:canonicalJson(intent)};
   return registry.transaction(async()=>{
    source=await accepted(requestId);await validate(candidate,source);
    if(source.lease.state!=='reserved')throw conflict();
    row=await raw(requestId);
    if(row){if(row.intent_hash!==candidate.intent_hash)throw conflict();return {status:'sealed',intent:await validate(row,source)};}
    await query('INSERT INTO creation_mint_plans(request_id,owner,request_hash,intent_hash,intent_json,created_at) VALUES(?,?,?,?,?,CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT))',[requestId,owner,candidate.request_hash,candidate.intent_hash,candidate.intent_json]);
    return {status:'sealed',intent};
   },{lockKey:'creation-mint-plan:'+requestId});
  },
 };
}
