// One private creator journey over the durable services. Status is read-only;
// every side effect is explicitly advanced and every wallet signature is distinct.
// Registration is NOT funded worker activation or permission to accept deposits.
import {canonicalHash} from '../registry/canonical.mjs';
import {mintIntentHash,provisionIntentFromMint} from './mint-packet.mjs';
import {provisionIntentHash,reviewedProvisionPolicy} from './provision-packet.mjs';
import {OPERATING_RESERVE_STAGE,acceptedReserveLamports} from './operating-reserve.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const key=/^[A-Za-z0-9_.:-]{1,128}$/;
const conflict=()=>Object.assign(Error('Creator flow differs from the accepted launch'),{code:'IDEMPOTENCY_CONFLICT'});
import {acceptedScope} from './accepted-scope.mjs';
export function createCreatorFlow({registry,config,preparation,mintPlans,mintApprovals,mintWallet,mintExecutor,signReservedMint,provisionPlans,provisionWallet,registrar,operatingReserve=null}){
 if(registry?.driver!=='postgres'||!creationMode(config?.mode)||config.programVersion!==3)throw Error('Creator flow requires isolated v3 PostgreSQL');
 const scope=structuredClone(config),url=new URL(scope.rpcUrl);
 if(!creationRpc(url,scope.mode))throw Error('Creator flow requires local RPC');
 for(const [object,methods] of [[preparation,['prepare','status']],[mintPlans,['load','seal']],[mintApprovals,['find','captureSigned','pendingRetry']],[mintWallet,['prepare','submit','recover']],[mintExecutor,['resume']],[provisionPlans,['load','seal']],[provisionWallet,['prepare','submit','status','resume','recover']],[registrar,['register']],...(operatingReserve?[[operatingReserve,['prepare','submit','status','resume','recover']]]:[])])for(const name of methods)if(typeof object?.[name]!=='function')throw Error('Incomplete creator service: '+name);
 if(typeof signReservedMint!=='function')throw Error('Existing inventory signer is required');
 const query=(sql,args=[])=>registry.query(sql,args),publishing=new Map();
 // Publication survives a short HTTP response. Repeated requests join the same work;
 // after a restart the publication journal reconciles the provider receipt.
 async function publish(owner,id){
  if(!publishing.has(id))publishing.set(id,mintPlans.seal(owner,id).finally(()=>publishing.delete(id)));
  let timer;try{return await Promise.race([publishing.get(id),new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'pending',stage:'publication'}),1500);})]);}
  finally{clearTimeout(timer);}
 }
 async function request(owner,id){
  if(owner!==scope.pilotCreator||typeof id!=='string'||!key.test(id))throw conflict();
  const r=(await query('SELECT * FROM creation_requests WHERE request_id=? AND owner=?',[id,owner])).rows[0];
  if(!r||r.state!=='accepted')throw conflict();const body=JSON.parse(r.body),q=body.quote;
  // An accepted request continues under the policy and plan it was quoted with (pinned in its accepted body; every step
  // below validates against that body, and a created campaign is sealed on chain), so a later preset change never strands
  // it. The ledger, program, treasury and operating payer must still be this service's (28 September 2026).
  if(!acceptedScope(scope,q)||(q.operatingPayer&&q.operatingPayer!==scope.operatingPayer)||q.terms?.mode!=='standard'||q.fundingEnabled!==false||q.publicationConsent!==true||canonicalHash(body.draft)!==body.draftHash)throw conflict();
  return r;
 }
 async function snapshot(owner,id){
  const r=await request(owner,id),body=JSON.parse(r.body),q=body.quote;
  const review={network:scope.network??'localnet',genesisHash:scope.genesisHash,programId:scope.programId,treasury:scope.treasury,name:body.draft.name,symbol:body.draft.symbol,...reviewedProvisionPolicy(q),mintRentLamports:q.costs?.lines?.find(l=>l.item==='mint account rent')?.lamports??null,authorityBudgetLamports:q.authorityFunding?.amountLamports??null,operatingPayer:scope.operatingPayer??null,operatingReserveLamports:acceptedReserveLamports(q),start:body.draft.start,startUtc:body.draft.startUtc??null};
  const base={requestId:id,draftId:r.draft_id,network:scope.network??'localnet',creationMode:scope.oneTransaction===true?'single':'legacy',workerActivation:false,fundingEnabled:false,signatures:{},review};
  const finish=(stage,state,action,extra={})=>({...base,stage,state,action,...extra});
  const p=await preparation.status(owner,{draftId:r.draft_id});
  if(!p||p.state!=='reserved')return finish('reservation',p?.state??'not-started',p?.state==='attention'?'support':'prepare',{reason:p?.reason??null});
  base.mint=p.mint;base.campaign=p.campaign;
  if(!(await query('SELECT request_id FROM creation_mint_plans WHERE request_id=?',[id])).rows.length)return finish('publication','not-started','prepare');
  const mint=await mintPlans.load(id);if(mint.mint!==p.mint||mint.campaign!==p.campaign)throw conflict();
  // Metadata pins: 'sealed' = the URI is final, the provider pin runs in the background; 'attention' = an operator must look.
  const pins=(await query('SELECT stage,state FROM creation_publications WHERE request_id=?',[id])).rows;
  base.publication={uri:mint.metadata?.uri??null,image:pins.find(r=>r.stage==='image')?.state??null,document:pins.find(r=>r.stage==='document')?.state??null};
  // One creation transaction (version-2 mint intent): the wallet stage is 'launch' and covers mint, custody, campaign,
  // setup budget and operating reserve; the provisioning stages below do not exist for it.
  // One creation transaction (version 2, or version 3 = funding-first accounting: the opening packet, no token yet).
  const one=mint.version>=2,walletStage=one?'launch':'mint';base.creationMode=one?'single':'legacy';base.fundingFirst=mint.version===3;
  // Funding-first: the review shows the fee NFT the sealed plan binds (the custody's reserved key, matched by the browser
  // against the offer it signs) and that no token exists at the opening.
  if(mint.version===3)Object.assign(review,{accounting:'funding-first',feeNft:mint.fundingFirst.feeNft,tokenCreatedAtOpening:false});
  const row=await mintApprovals.find(id);
  if(!row)return finish(walletStage,'awaiting-approval','prepare');
  base.signatures[walletStage]=row.signature??null;
  if(row.status!=='finalized'){
   const retry=await mintApprovals.pendingRetry(id);
   if(retry)return finish(walletStage,'review-required','prepare',{generation:retry.generation,previousSignature:retry.previousSignature});
   return finish(walletStage,row.status,['failed','expired'].includes(row.status)?row.attempt>=3?'support':'recover':'resume',{signature:row.signature??null,generation:row.attempt-1});
  }
  if(row.result?.mintEvidence?.intentHash!==mintIntentHash(mint))throw conflict();
  const lease=await registry.mintLeases.get(mint.leaseId);
  if(lease?.state!=='consumed'||lease.signature!==row.signature)return finish(walletStage,'finalized','resume',{signature:row.signature,reason:'finalize-mint-reservation'});
  if(one){
   const e=row.result.mintEvidence;if(!/^[1-9][0-9]*$/.test(e?.opensAt??''))throw conflict();
   const identity={genesisHash:scope.genesisHash,programId:scope.programId,campaign:mint.campaign},campaign=await registry.campaigns.get(identity);
   if(!campaign)return finish('registration','not-started','resume');
   if(campaign.creator!==owner||campaign.mint!==mint.mint||campaign.campaignVersion!==3||campaign.terms?.provisionIntentHash!==provisionIntentHash(provisionIntentFromMint(mint,e.opensAt)))throw conflict();
   if(operatingReserve){
    const f=await operatingReserve.status(owner,{requestId:id});base.signatures[OPERATING_RESERVE_STAGE]=f.signature??null;
    if(f.status!=='credited')return finish(OPERATING_RESERVE_STAGE,f.status==='awaiting-approval'?'pending':f.status,'resume',{signature:row.signature,lamports:f.lamports,payer:f.payer,reason:'credit-from-creation'});
    return finish('complete','funded','none',{operatingReserve:{lamports:f.lamports,payer:f.payer,signature:f.signature??null}});
   }
   return finish('complete','registered','none');
  }
  if(!(await query('SELECT request_id FROM creation_provision_plans WHERE request_id=?',[id])).rows.length)return finish('setup-plan','not-started','prepare');
  for(const stage of ['native-custody','create-campaign']){
   const intent=await provisionPlans.load(id,stage),status=await provisionWallet.status(owner,{requestId:id,stage});
   base.signatures[stage]=status.signature??null;
   if(status.status!=='finalized')return finish(stage,status.status,status.status==='awaiting-approval'?'prepare':['failed','expired'].includes(status.status)?'recover':'resume',{signature:status.signature??null,intentHash:provisionIntentHash(intent),generation:intent.generation??1});
  }
  const intent=await provisionPlans.load(id),identity={genesisHash:scope.genesisHash,programId:scope.programId,campaign:mint.campaign},campaign=await registry.campaigns.get(identity);
  if(!campaign)return finish('registration','not-started','resume');
  if(campaign.creator!==owner||campaign.mint!==mint.mint||campaign.campaignVersion!==3||campaign.terms?.provisionIntentHash!==provisionIntentHash(intent))throw conflict();
  if(operatingReserve){
   // The operating reserve (option 1) is one more explicit creator approval after registration; it never signs by itself.
   const f=await operatingReserve.status(owner,{requestId:id});base.signatures[OPERATING_RESERVE_STAGE]=f.signature??null;
   if(f.status!=='credited'){const action=['prepare','resume','recover','none'].includes(f.action)?f.action:'resume';return finish(OPERATING_RESERVE_STAGE,f.status,action,{signature:f.signature??null,lamports:f.lamports,payer:f.payer,reason:f.reason??null});}
   return finish('complete','funded','none',{operatingReserve:{lamports:f.lamports,payer:f.payer,signature:f.signature??null}});
  }
  return finish('complete','registered','none');
 }
 // A concurrent request may advance the snapshot after an offer was made. Keep
 // the offer's own stage/request binding explicit; never infer it from the new
 // snapshot stage when asking a wallet to sign.
 const attach=async(owner,id,result,stage)=>({...await snapshot(owner,id),result:{...result,requestId:id,stage}});
 return {
  async status(owner,{requestId}){return snapshot(owner,requestId);},
  async prepare(owner,{requestId}){
   const s=await snapshot(owner,requestId);if(s.action!=='prepare')return s;
   let result;
   if(s.stage==='reservation')result=await preparation.prepare(owner,{draftId:s.draftId});
   else if(s.stage==='publication')result=await publish(owner,requestId);
   else if(s.stage==='setup-plan')result=await provisionPlans.seal(owner,requestId);
   else if(s.stage==='mint'||s.stage==='launch')result=await mintWallet.prepare(owner,{requestId});
   else if(s.stage===OPERATING_RESERVE_STAGE)result=await operatingReserve.prepare(owner,{requestId});
   else result=await provisionWallet.prepare(owner,{requestId,stage:s.stage});
   return attach(owner,requestId,result,s.stage);
  },
  async submit(owner,input){
   await request(owner,input.requestId);
   // A one-transaction intent (version 2) has exactly one wallet stage; the provisioning and reserve stages of the
   // older path are refused here as well as by their services, so a stale tab cannot label a packet with them.
   const version=(await query('SELECT request_id FROM creation_mint_plans WHERE request_id=?',[input.requestId])).rows.length?(await mintPlans.load(input.requestId)).version:1;
   const allowed=version>=2?['launch']:['mint','native-custody','create-campaign',...(operatingReserve?[OPERATING_RESERVE_STAGE]:[])];
   if(!allowed.includes(input.stage))throw conflict();
   // Exact previous offer resubmission remains safe after an HTTP response loss.
   // It cannot approve a new future stage: each underlying service enforces its
   // persisted plan, offer binding and finalized predecessor requirements.
   const result=input.stage==='mint'||input.stage==='launch'?await mintWallet.submit(owner,input):input.stage===OPERATING_RESERVE_STAGE?await operatingReserve.submit(owner,input):await provisionWallet.submit(owner,input);
   return attach(owner,input.requestId,result,input.stage);
  },
  async resume(owner,{requestId},{signal}={}){
   const s=await snapshot(owner,requestId);if(s.action!=='resume')return s;
   if(signal?.aborted)return s;let result;
   if(s.stage==='mint'||s.stage==='launch'){
    const row=await mintApprovals.find(requestId);
    if(row.status==='prepared'){
     const mint=await mintPlans.load(requestId),lease=await registry.mintLeases.get(mint.leaseId);
     if(!lease||lease.state!=='signed-pending'||lease.creator!==owner||lease.mint!==mint.mint)throw conflict();
     const signed=await signReservedMint({creator:owner,draftId:'asset:'+requestId,idempotencyKey:'asset:'+requestId,reservationId:lease.signerRef});
     await mintApprovals.captureSigned(requestId,signed.transactionBase64);
    }
    result=await mintExecutor.resume(requestId,{signal});
   }else if(s.stage==='registration')result=(await mintPlans.load(requestId)).version>=2?await registrar.registerFromCreation(owner,requestId):await registrar.register(owner,requestId);
   else if(s.stage===OPERATING_RESERVE_STAGE){
    if((await mintPlans.load(requestId)).version>=2){const row=await mintApprovals.read(requestId);result=await operatingReserve.creditFromCreation(owner,{requestId,signature:row.signature,transactionBase64:row.signedBase64,block:row.prepared.block});}
    else result=await operatingReserve.resume(owner,{requestId},{signal});
   }
   else result=await provisionWallet.resume(owner,{requestId,stage:s.stage},{signal});
   return attach(owner,requestId,result,s.stage);
  },
  async recover(owner,input){
   const s=await snapshot(owner,input.requestId);
   if(input.stage!==s.stage)throw conflict();
   const result=s.stage==='mint'||s.stage==='launch'?await mintWallet.recover(owner,input):s.stage===OPERATING_RESERVE_STAGE?await operatingReserve.recover(owner,input):await provisionWallet.recover(owner,input);
   return attach(owner,input.requestId,result,input.stage);
  },
 };
}
