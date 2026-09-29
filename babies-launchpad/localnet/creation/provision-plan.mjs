// Shared immutable setup plan. HTTP callers can select neither a recipient nor
// a transfer amount. Mint finality and the accepted, itemized cost review bind it.
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
import {mintIntentHash} from './mint-packet.mjs';
import {mintResultAddresses,verifyMintResult} from './mint-result.mjs';
import {quoteAuthorityFunding} from './setup-funding.mjs';
import {createProvisionIntent,provisionIntentHash,reviewedProvisionPolicy} from './provision-packet.mjs';
import {parseUtcInput} from '../../interaction-review/src/public/launch-draft.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const conflict=()=>Object.assign(Error('Setup plan differs from the accepted creator review'),{code:'IDEMPOTENCY_CONFLICT'});
import {acceptedScope} from './accepted-scope.mjs';
export function createProvisionPlanService({registry,connection,config,mintPlans,mintApprovals}){
 if(registry?.driver!=='postgres'||!mintPlans?.load||!mintApprovals?.find)throw Error('Setup plan requires shared mint and approval storage');
 if(!creationMode(config?.mode)||config.programVersion!==3)throw Error('Setup plan is restricted to isolated v3 localnet');
 const scope=structuredClone(config),u=new URL(scope.rpcUrl);
 if(!creationRpc(u,scope.mode)||connection.rpcEndpoint!==scope.rpcUrl)throw Error('Setup plan requires the configured loopback RPC');
 const treasury=new PublicKey(scope.treasury).toBase58(),query=(s,p=[])=>registry.query(s,p);
 const raw=async id=>(await query('SELECT * FROM creation_provision_plans WHERE request_id=?',[id])).rows[0];
 async function source(requestId){
  if(typeof requestId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId))throw conflict();
  const r=(await query('SELECT * FROM creation_requests WHERE request_id=? AND owner=?',[requestId,scope.pilotCreator])).rows[0];
  if(!r||r.state!=='accepted')throw conflict();const body=JSON.parse(r.body),q=body.quote;
  if(canonicalHash(body.draft)!==body.draftHash||!acceptedScope(scope,q)||q.fundingEnabled!==false||q.publicationConsent!==true)throw conflict();
  if(q.treasury!==undefined&&q.treasury!==treasury)throw conflict();
  const funding=quoteAuthorityFunding(q.costs);if(canonicalHash(funding)!==canonicalHash(q.authorityFunding))throw conflict();
  const policy=reviewedProvisionPolicy(q),mint=await mintPlans.load(requestId),mintHash=mintIntentHash(mint),approved=await mintApprovals.find(requestId);
  // One creation transaction (version 2) and the funding-first opening (version 3) have no provisioning stages: their
  // evidence is the creation packet's own (registerFromCreation), never the token-only evidence these stages verify.
  if(mint.version>=2)throw Error('One-transaction creation has no provisioning stages');
  if(mint.requestId!==requestId||mint.creator!==scope.pilotCreator||mint.programId!==scope.programId||mint.genesisHash!==scope.genesisHash||approved?.status!=='finalized'||approved.result?.mintEvidence?.intentHash!==mintHash||!Number.isSafeInteger(approved.result.mintEvidence.slot))throw Error('Finalized mint custody is required before setup');
  return {r,body,policy,mint,mintHash,funding,mintSlot:approved.result.mintEvidence.slot,requestHash:canonicalHash(body)};
 }
 function checked(row,s){
  if(row.owner!==scope.pilotCreator||row.request_hash!==s.requestHash||row.mint_intent_hash!==s.mintHash)throw conflict();
  const intent=JSON.parse(row.intent_json);
  if(provisionIntentHash(intent)!==row.intent_hash||mintIntentHash(intent.mint)!==s.mintHash||canonicalHash(intent.policy)!==canonicalHash(s.policy)||intent.treasury!==treasury||intent.authorityBudgetLamports!==s.funding.amountLamports)throw conflict();
  if(s.body.draft.start==='scheduled'&&intent.opensAt!==String(parseUtcInput(s.body.draft.startUtc)))throw conflict();
  return intent;
 }
 async function base(requestId){const s=await source(requestId),row=await raw(requestId);if(!row)throw Error('Setup plan is not sealed');return {intent:checked(row,s),start:s.body.draft.start,requestHash:s.requestHash};}
 async function current(requestId,stage='create-campaign'){
  if(!['native-custody','create-campaign'].includes(stage))throw conflict();
  const original=await base(requestId),table=stage==='native-custody'?'creation_native_setup_revisions':'creation_provision_revisions';
  const row=(await query('SELECT * FROM '+table+' WHERE request_id=? ORDER BY generation DESC LIMIT 1',[requestId])).rows[0];
  if(!row)return original.intent;
  const intent=JSON.parse(row.intent_json),expected={...original.intent,version:2,generation:Number(row.generation),opensAt:intent.opensAt};
  if(!['after-creation','scheduled'].includes(original.start)||((original.start==='scheduled'||stage==='native-custody')&&intent.opensAt!==original.intent.opensAt)||row.owner!==scope.pilotCreator||row.base_intent_hash!==provisionIntentHash(original.intent)||row.intent_hash!==provisionIntentHash(intent)||canonicalHash(expected)!==canonicalHash(intent))throw conflict();
  return intent;
 }
 return {
  base,
  async load(requestId,stage){return current(requestId,stage);},
  async seal(owner,requestId){
   if(owner!==scope.pilotCreator)throw conflict();if(await registry.schemaVersion()!==REGISTRY_SCHEMA_VERSION)throw Error('Setup plan schema unavailable');
   const s=await source(requestId),prior=await raw(requestId);if(prior)return {status:'sealed',intent:await current(requestId)};
   if(await connection.getGenesisHash()!==scope.genesisHash)throw Error('Setup ledger changed');
   const r=await connection.getMultipleAccountsInfoAndContext([...mintResultAddresses(s.mint),SYSVAR_CLOCK_PUBKEY],{commitment:'finalized',minContextSlot:s.mintSlot});
   verifyMintResult(s.mint,{context:r.context,value:r.value.slice(0,3)},{minSlot:s.mintSlot});
   const clock=r.value[3];if(!clock||clock.data.length!==40)throw Error('Setup clock unavailable');const now=clock.data.readBigInt64LE(32);
   const start=s.body.draft.start;
   if(!['scheduled','after-creation'].includes(start))throw Error('Unsupported start rule');
   const parsed=start==='scheduled'?parseUtcInput(s.body.draft.startUtc):null;
   if(start==='scheduled'&&(!Number.isSafeInteger(parsed)||BigInt(parsed)<=now+180n))throw Error('Scheduled start is too close; do not fund this setup');
   const intent=createProvisionIntent({mint:s.mint,policy:s.policy,treasury,opensAt:String(start==='scheduled'?BigInt(parsed):now),authorityBudgetLamports:s.funding.amountLamports});
   if(await connection.getGenesisHash()!==scope.genesisHash)throw Error('Setup ledger changed');
   return registry.transaction(async()=>{
    const request=(await query('SELECT body,state FROM creation_requests WHERE request_id=? AND owner=?',[requestId,owner])).rows[0];
    if(!request||request.state!=='accepted'||canonicalHash(JSON.parse(request.body))!==s.requestHash)throw conflict();
    const winner=await raw(requestId);if(winner)return {status:'sealed',intent:checked(winner,s)};
    await query('INSERT INTO creation_provision_plans(request_id,owner,request_hash,mint_intent_hash,intent_hash,intent_json,source_slot,created_at) VALUES(?,?,?,?,?,?,?,CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT))',[requestId,owner,s.requestHash,s.mintHash,provisionIntentHash(intent),canonicalJson(intent),r.context.slot]);
    return {status:'sealed',intent};
   },{lockKey:'creation-provision-plan:'+requestId});
  },
 };
}
