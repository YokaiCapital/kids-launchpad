// Private v3 Standard activation only. No public endpoint, arbitrary grants,
// fee policy selection or program upgrade. Reads chain evidence before one
// atomic DB transition: replace setup rights and seed three independent chains.
import {PublicKey} from '@solana/web3.js';
import {refillJobBinding} from './operating-refill.mjs';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {createOperatingLedger} from '../creation/operating-ledger.mjs';
import {seedFeeJobs} from './fee-handlers.mjs';
const key=x=>new PublicKey(x).toBase58();
const sameScope=(a,b)=>['genesisHash','programId','campaign'].every(k=>a?.[k]===b?.[k]);
const activeTags=Object.freeze([3,21,23,26]); // Retain refunds; never operator rotation or parent swaps.
const wait=category=>({outcome:'yield',category,delayMs:15000});
const refuse=reason=>({outcome:'failed-permanent',category:'fee-activation-refused',reason});
export function feeActivationPolicy(config){
 if(!['localnet-rehearsal','hosted'].includes(config?.mode))throw Error('Fee activation limited to localnet rehearsal or a verified hosted release');
 const {genesisHash,programId,payer,treasury,policy,minimumReserveLamports}=config;
 if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(policy??'')||typeof minimumReserveLamports!=='string'||! /^[1-9][0-9]{0,19}$/.test(minimumReserveLamports)||BigInt(minimumReserveLamports)>18446744073709551615n)throw Error('Explicit operating policy and positive activation reserve required');
 // The sealed treasury (the release's platform treasury, the fee recipient) and the payer (the keeper that pays rent and
 // fees) are separate keys on mainnet. Hosted mode pins the treasury from the verified release; only a legacy local fixture
 // without one keeps the payer as its treasury (the isolated ledgers of 27 September 2026 used one key for both).
 if(config.mode==='hosted'&&!treasury)throw Error('Hosted fee activation needs the release treasury');
 const pinned={genesisHash:key(genesisHash),programId:key(programId),payer:key(payer),treasury:key(treasury??payer),policy,minimumReserveLamports};
 return Object.freeze({...pinned,descriptorHash:canonicalHash({version:2,...pinned,tags:activeTags})});
}
export function createFeeActivation({registry,adapter,config}){
 const p=feeActivationPolicy(config);
 if(registry?.driver!=='postgres'||typeof adapter?.snapshot!=='function')throw Error('Fee activation requires PostgreSQL and finalized custody verification');
 const disabled=async()=>{throw Error('Activation cannot credit or spend funds');};
 const ledger=createOperatingLedger({registry,verifyFunding:disabled,verifyOutcome:disabled});
 const identity=x=>({genesisHash:x.genesisHash,programId:x.programId,campaign:key(x.campaign)});
 const bound=id=>id.genesisHash===p.genesisHash&&id.programId===p.programId;
 const select=id=>registry.query('SELECT * FROM standard_fee_activations WHERE genesis_hash=? AND program_id=? AND campaign=?',[id.genesisHash,id.programId,id.campaign]);
 async function clock(){return Number((await registry.query('SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms')).rows[0].ms);}
 const network=config.network??'localnet';
 async function eligible(id){const c=await registry.campaigns.get(id);return c?.campaignVersion===3&&c.mode==='standard'&&c.network===network?c:null;}
 async function schedule(setupJob,ctx){
  const id=identity(ctx.campaign);
  if(!bound(id)||setupJob.jobClass!=='fee-setup'||setupJob.operationKey!=='fee-setup'||!sameScope(setupJob,id))throw Error('Invalid setup activation scope');
  return registry.transaction(async()=>{
   if(!await eligible(id))throw Error('Activation campaign is not the isolated Standard issuer');
   const prior=(await select(id)).rows[0];
   // Never revive a grant after an operator revokes it, including setup retries.
   if(prior){if(prior.descriptor_hash!==p.descriptorHash)throw Error('Activation policy changed');return;}
   const cap=await registry.capabilities.latest(id),at=await clock();
   if(!cap||cap.programVersion!==3||cap.kind!=='fee-setup'||cap.revokedAt||Date.parse(cap.expiresAt)<=at||canonicalJson(cap.tags)!=='[20]')throw Error('Live explicit setup grant required');
   await registry.jobs.enqueue({...id,jobClass:'fee-activate',operationKey:'fee-activate',payload:{setupJobId:setupJob.jobId,setupCapabilityId:cap.capabilityId,descriptorHash:p.descriptorHash}});
  });
 }
 const handler={async run(job,ctx){
  const id=identity(ctx.campaign),input=job.payload;
  if(!bound(id)||!sameScope(job,id)||job.jobId!==ctx.jobId||job.jobClass!=='fee-activate'||job.operationKey!=='fee-activate'||input?.descriptorHash!==p.descriptorHash||typeof input.setupJobId!=='string'||typeof input.setupCapabilityId!=='string')return refuse('Activation scope or policy differs');
  const setup=await registry.jobs.get(input.setupJobId);
  if(!setup||!sameScope(setup,id)||setup.jobClass!=='fee-setup'||setup.operationKey!=='fee-setup')return refuse('Exact setup predecessor required');
  if(setup.state!=='done'||setup.result?.verified!==true)return wait('awaiting-verified-fee-setup');
  // This is fresh finalized chain evidence, not the predecessor's cached result.
  const evidence=await ctx.fenced('verify-fee-custody',()=>adapter.snapshot(id));
  if(evidence.status!=='ready')return wait(evidence.reason??'awaiting-fee-custody');
  if(evidence.payer!==p.payer||!Number.isSafeInteger(evidence.slot)||evidence.slot<1||!Array.isArray(evidence.recipients))return refuse('Fee custody evidence differs');
  return registry.transaction(async()=>{
   // A DB row lock plus DB time fences the entire grant+queue transaction, not
   // just a best-effort lease check before asynchronous work.
   const lease=(await registry.query("SELECT job_id FROM jobs WHERE job_id=? AND fencing_token=? AND lease_owner=? AND state='leased' AND lease_expires_at>to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FOR UPDATE",[ctx.jobId,ctx.token,ctx.owner])).rows[0];
   if(!lease)throw Object.assign(Error('Activation lease expired'),{code:'STALE_LEASE'});
   const c=await eligible(id);
   if(!c||!c.termsHash||c.termsHash!==evidence.termsHash)return refuse('Sealed campaign evidence differs');
   const cap=await registry.capabilities.latest(id),at=await clock(),prior=(await select(id)).rows[0];
   if(prior){
    if(prior.descriptor_hash!==p.descriptorHash||prior.setup_job_id!==input.setupJobId||prior.setup_capability_id!==input.setupCapabilityId)return refuse('Prior activation binding differs');
    if(!cap||cap.capabilityId!==prior.active_capability_id||cap.revokedAt||Date.parse(cap.expiresAt)<=at)return wait('fee-capability-paused');
    return {outcome:'done',category:'fees-active',capabilityId:cap.capabilityId,duplicate:true};
   }
   if(!cap||cap.capabilityId!==input.setupCapabilityId||cap.programVersion!==3||cap.kind!=='fee-setup'||canonicalJson(cap.tags)!=='[20]'||cap.revokedAt||Date.parse(cap.expiresAt)<=at)return wait('fee-capability-paused');
   if(canonicalJson([...cap.recipients].sort())!==canonicalJson([...evidence.recipients].sort()))return refuse('Sealed recipients differ from setup grant');
   const balance=await ledger.balance({...id,payer:p.payer,policy:p.policy});
   if(BigInt(balance.availableLamports)<BigInt(p.minimumReserveLamports))return wait('awaiting-operating-funding');
   // Preserve the explicit setup grant's expiry and stricter limits. No silent
   // renewal or expansion into minting, upgrades, withdrawal or operator rotation.
   const active=await registry.capabilities.grant({...id,programVersion:3,kind:'keeper',tags:activeTags,recipients:[],limits:cap.limits,expiresAt:cap.expiresAt});
   await seedFeeJobs(registry,id);
   // Option 1: from activation on, the accounting lane records what the coin's treasury share entitles this budget to.
   await registry.jobs.enqueue({...id,jobClass:'operating-refill',operationKey:'operating-refill:0',payload:{binding:refillJobBinding({...id,payer:p.payer,policy:p.policy})}});
   await registry.query('INSERT INTO standard_fee_activations(genesis_hash,program_id,campaign,descriptor_hash,setup_capability_id,active_capability_id,setup_job_id,payer,policy,minimum_reserve_lamports,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id.genesisHash,id.programId,id.campaign,p.descriptorHash,cap.capabilityId,active.capabilityId,setup.jobId,p.payer,p.policy,p.minimumReserveLamports,canonicalJson({slot:evidence.slot,termsHash:evidence.termsHash,operator:evidence.operator,recipients:evidence.recipients,availableLamports:balance.availableLamports}),new Date(at).toISOString()]);
   return {outcome:'done',category:'fees-active',capabilityId:active.capabilityId,slot:evidence.slot,duplicate:false};
  });
 }};
 return {schedule,handler,policy:p};
}
