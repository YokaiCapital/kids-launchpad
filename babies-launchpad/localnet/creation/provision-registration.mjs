import {publishCreatorProfile} from './creator-profile.mjs';
// Register verified creator setup for private discovery only. This deliberately
// grants no signer capability, spends no operational budget and schedules no
// financial jobs: those require a separately qualified funding/activation policy.
import {mintIntentHash} from './mint-packet.mjs';
import {createInstruction} from '../protocol-v2/client.mjs';
import {provisionIntentHash,provisionTerms,provisionTermsHash} from './provision-packet.mjs';
import {provisionIntentFromMint,expectedSealedTerms} from './mint-packet.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const conflict=()=>Object.assign(Error('Provisioning registration differs from durable evidence'),{code:'IDEMPOTENCY_CONFLICT'});
export function createProvisionRegistrar({registry,config,loadIntent,executor,publisher=null,loadMintIntent=null,mintApprovals=null}){
 if(registry?.driver!=='postgres'||typeof loadIntent!=='function'||!executor?.resume)throw Error('Registration needs shared verified provisioning');
 if(!creationMode(config?.mode)||config.programVersion!==3)throw Error('Registration is isolated v3 pilot only');
 const scope=structuredClone(config);if(scope.profilePublication===true&&typeof publisher?.publish!=='function')throw Error('Creator profiles require the durable publisher');
 const scoped=(intent,requestId,owner)=>{const m=intent.mint;if(m.requestId!==requestId||m.creator!==owner||m.genesisHash!==scope.genesisHash||m.programId!==scope.programId||intent.treasury!==scope.treasury)throw conflict();};
 const service={
  /** One creation transaction: the finalized mint journal proved the campaign (sealed bytes, terms hash, custody, budget). */
  async registerFromCreation(owner,requestId){
   if(owner!==scope.pilotCreator)throw conflict();
   if(typeof loadMintIntent!=='function'||typeof mintApprovals?.read!=='function')throw Error('Creation registration needs the mint plan and its journal');
   const mint=structuredClone(await loadMintIntent(requestId));
   if(![2,3].includes(mint.version)||mint.requestId!==requestId||mint.creator!==owner||mint.genesisHash!==scope.genesisHash||mint.programId!==scope.programId||mint.launch.treasury!==scope.treasury)throw conflict();
   const row=await mintApprovals.read(requestId);
   if(row?.status!=='finalized')return {status:'pending',reason:'awaiting-creation',requestId};
   const e=row.result?.mintEvidence;
   if(e?.version!==1||e.intentHash!==mintIntentHash(mint)||e.campaign!==mint.campaign||!/^[1-9][0-9]*$/.test(e.opensAt??'')||typeof e.termsHash!=='string'||typeof e.sealedTermsBase64!=='string'||!Number.isSafeInteger(e.slot)||e.slot<1||!row.signature)throw conflict();
   const sealed=Buffer.from(e.sealedTermsBase64,'base64');if(!sealed.equals(expectedSealedTerms(mint,e.opensAt)))throw conflict();
   const intent=provisionIntentFromMint(mint,e.opensAt);scoped(intent,requestId,owner);
   if(provisionTermsHash(intent)!==e.termsHash)throw conflict();
   if(mint.version===3&&(e.accountingVersion!==2||e.feeNft!==mint.fundingFirst.feeNft||e.tokenCreated!==false))throw conflict();
   return finish({owner,requestId,intent,evidence:{termsHash:e.termsHash,slot:e.slot,mintIntentHash:e.intentHash,sealed,...(mint.version===3?{accountingVersion:2,feeNft:e.feeNft}:{})},signature:row.signature});
  },
  async register(owner,requestId){
  if(owner!==scope.pilotCreator)throw conflict();
  const intent=structuredClone(await loadIntent(requestId)),m=intent.mint;provisionIntentHash(intent);scoped(intent,requestId,owner);
  const verified=await executor.resume(requestId,'create-campaign');
  if(verified.status!=='complete')return {status:verified.status,reason:verified.reason??'awaiting-setup',requestId};
  const e=verified.evidence;
  if(e?.version!==1||e.intentHash!==provisionIntentHash(intent)||e.termsHash!==provisionTermsHash(intent)||e.stage!=='create-campaign'||e.mintEvidence?.intentHash!==mintIntentHash(m)||e.campaign!==m.campaign||!Number.isSafeInteger(e.slot)||e.slot<1||!verified.signature)throw conflict();
  return finish({owner,requestId,intent,evidence:{termsHash:e.termsHash,slot:e.slot,mintIntentHash:e.mintEvidence.intentHash,sealed:createInstruction(m.programId,provisionTerms(intent)).sealed},signature:verified.signature});
  },
  async completeProfile(owner,requestId){
   if(owner!==scope.pilotCreator)throw conflict();
   const publication=await publisher.publish(owner,requestId);
   if(!['published','sealed'].includes(publication.status))return publication;
   return service.registerFromCreation(owner,requestId);
  }};
 return service;
 async function finish({owner,requestId,intent,evidence:e,signature}){
  const m=intent.mint;const verified={signature};
  // A previously sealed mint may predate supplemental banner publication. Resume
  // that idempotent stage before a short registry transaction, never while holding its lock.
  if(scope.profilePublication===true){const publication=await (publisher.publishCore||publisher.publish)(owner,requestId);if(!['published','sealed'].includes(publication.status))return {status:'pending',reason:'awaiting-profile-publication',requestId};}
  const terms=provisionTerms(intent),deadline=Number(terms.deadline),launchDeadline=Number(terms.launchDeadline),opens=Number(intent.opensAt);
  if(![opens,deadline,launchDeadline].every(Number.isSafeInteger)||opens>8640000000000)throw Error('Opening time cannot be represented by the directory');
  const identity={genesisHash:m.genesisHash,programId:m.programId,campaign:m.campaign};
  return registry.transaction(async()=>{
   const existing=await registry.campaigns.get(identity);
   const discover=async()=>{if(scope.profilePublication===true)await publishCreatorProfile({registry,id:identity,intent,signature:verified.signature,allowPendingMedia:typeof publisher.publishCore==='function'});if(scope.discoveryIndex===true){await registry.jobs.enqueue({...identity,jobClass:'campaign-index',operationKey:'campaign:0'});await registry.jobs.enqueue({...identity,jobClass:'position-index',operationKey:'positions:0'});await registry.jobs.enqueue({...identity,jobClass:'activity-index',operationKey:'activity-live:0'});}};
   const binding={creator:owner,nonce:m.nonce,mint:m.mint,dev:owner,treasury:intent.treasury,termsHash:e.termsHash,softCapLamports:terms.soft,hardCapLamports:terms.hard,supplyRaw:m.supply,deadlineUnix:deadline,launchDeadlineUnix:launchDeadline};
   if(existing){
    if(existing.campaignVersion!==3||existing.mode!=='standard'||existing.terms?.provisionIntentHash!==provisionIntentHash(intent)||Object.entries(binding).some(([key,value])=>existing[key]!==value))throw conflict();
    // Re-registration must not regress a campaign that the chain reader has since
    // advanced to open/live/failed, nor overwrite moderated display properties.
    await discover();return {status:'registered',requestId,campaign:identity,workerActivation:false};
   }
   const result=await registry.campaigns.upsert({...identity,...binding,network:config.network??'localnet',mode:'standard',campaignVersion:3,registryStatus:'planned',sourceSlot:e.slot,sourceCommitment:'finalized',name:m.metadata.name,symbol:m.metadata.symbol,opensAt:new Date(opens*1000).toISOString(),parentMints:[],
    terms:{sealedTermsBase64:Buffer.from(e.sealed).toString('base64'),creationSignature:verified.signature,provisionIntentHash:provisionIntentHash(intent),mintIntentHash:e.mintIntentHash,policyHash:intent.policy.policyHash,planHash:intent.policy.planHash,...(e.accountingVersion===2?{accountingVersion:2,feeNft:e.feeNft}:{})}});
   if(result.conflicts.length)throw conflict();
   await discover();return {status:'registered',requestId,campaign:identity,workerActivation:false};
  },{lockKey:'campaign:'+identity.genesisHash+':'+identity.programId+':'+identity.campaign});
 }
}
