// Per-campaign signer capabilities (plan section 7, P3). The legacy signer serves "the campaigns listed in the plan
// file" with one tag set for all of them. The new path loads an explicit, expiring grant per campaign from the registry
// (or a JSON file when there is no registry) and evaluates a signing request against that grant only:
//   * the request names the campaign and carries the job's fencing token and an operation id;
//   * the message is decoded by the existing policy (evaluateOperatorMessage) with the capability's program id, its
//     one campaign and its (never higher than default) lamport limits;
//   * every launch-program tag must be in the grant; tags that set recipients or authorities (create, configure
//     parents) and user tags can never be granted; provisioning templates (set-authority, transfers, account creation,
//     mint-to, metadata) are refused whatever the grant says;
//   * an operation id already bound to a different message is refused (replay registry, one id = one message);
//   * the fencing token is monotonic per (campaign, operation key): the signer keeps the highest token it has signed
//     for in its own durable state and refuses a lower one, so an older token is refused after a newer one was observed. This alone does NOT prove a lease is still live;
//     version-2 requests additionally require the registry active-lease check in signer-service.mjs.
// The keeper kind carries no recipients: it cannot sponsor a token account for anyone but the campaign's own
// authorities. Legacy behaviour (DEFAULT_LIMITS, USER_TAGS, KEEPER_TAGS, the served-campaign set) is untouched.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PublicKey} from '@solana/web3.js';
import {evaluateOperatorMessage,NEVER_GRANTABLE_TAGS,DEFAULT_LIMITS,PROGRAMS,BASE_FEE_LAMPORTS} from '../signer-policy.mjs';
import {isAddress,CAPABILITY_KINDS} from '../registry/registry.mjs';
import {evaluateCpiRent} from './cpi-costs.mjs';
export {NEVER_GRANTABLE_TAGS};
export const CAPABILITY_FILE_VERSION=1;
/** A job's operation key as the registry stores it (registry KEY rule); the fence key of a request is campaign|operationKey. */
export const OPERATION_KEY=/^[A-Za-z0-9_.:-]{1,128}$/;
export const STALE_FENCING_TOKEN='stale fencing token';
/** Keeper tags of programs/kids-launch-v2 a capability may carry: finalize, refund, settle, assert-ready, launch and the fee
 * cycle (20 init, 21 collect, 22 rotate operator, 23 distribute, 25 buy-and-burn, 26 burn). Tag 24 does not exist in
 * version 2; 0 (create), 1 (commit), 7 and 8 (claims) are never grantable. A grant that names programVersion 2 is
 * checked against this set on load and on every request; the legacy policy (signer-policy.mjs KEEPER_TAGS) is untouched. */
export const KEEPER_TAGS_V2=Object.freeze(new Set([2,3,4,5,6,20,21,22,23,25,26]));
// Program version 3 adds the funding-first launch (tag 42: version-2 record, mint and fee NFT co-sign). Never a v2 tag.
/** Version 3 adds the funding-first keeper tags: 42 launch, 44 refund, 45 close, 46 account, 47 collateral return (43 claims are the holders' own). */
export const KEEPER_TAGS_V3=Object.freeze(new Set([...KEEPER_TAGS_V2,42,44,45,46,47]));
export const keeperTagsFor=programVersion=>programVersion>=3?KEEPER_TAGS_V3:KEEPER_TAGS_V2;
// v3 inherits these exact keeper rights. Setup-return tag 27 remains wallet-only
// until a separate keeper capability/payer policy is qualified.
export const PROGRAM_VERSIONS=Object.freeze([1,2,3]);
/** One high-water mark per (campaign, operation key). Without an operation key the operation id itself is the key, so a
 * stale runner re-posting the same operation with an older token is still refused. */
export const fenceKey=(campaign,operationKey,operationId)=>campaign+'|'+(operationKey??operationId);
/** Durable fencing-token marks: `seen` is Map fenceKey -> highest token signed for; `persist` runs after every raise. */
export function createFenceRegistry({seen=new Map(),persist=()=>{}}={}){
 return {
  seen,
  /** 'stale' when the token is below the mark, else 'ok' (equal is a retry of the same lease, higher is a newer lease). */
  check(key,token){const prior=seen.get(key);return prior!==undefined&&token<prior?'stale':'ok';},
  record(key,token){if(!Number.isSafeInteger(token)||token<1)throw Error('fencing token must be a positive integer');const prior=seen.get(key);if(prior===undefined||token>prior){seen.set(key,token);persist();}},
 };
}
/** Operations the legacy decoder can approve in provisioning mode; a capability path never runs in that mode, and refuses them on sight. */
export const MUTATING_OPERATIONS=new Set(['set-authority','transfer','create-account','init-mint','mint-to','metadata']);
export const LIMIT_KEYS=Object.freeze(Object.keys(DEFAULT_LIMITS));
const b58=v=>{try{const k=new PublicKey(v);return k.toBase58()===v?v:null;}catch{return null;}};
/** Validates one grant and computes its effective limits: a grant can lower a default limit, never raise it. */
export function normalizeCapability(c,{now=Date.now}={}){
 if(!c||typeof c!=='object')throw Error('Capability must be an object');
 const campaign=b58(c.campaign),programId=b58(c.programId);if(!campaign||!programId)throw Error('Capability needs campaign and programId addresses');
 const genesisHash=c.genesisHash==null?null:b58(c.genesisHash);if(c.genesisHash!=null&&!genesisHash)throw Error('Capability genesisHash must be an address');
 const kind=c.kind??'keeper';if(!CAPABILITY_KINDS.includes(kind))throw Error('Capability kind must be one of '+CAPABILITY_KINDS.join(', '));
 if(!Array.isArray(c.tags)||(!c.tags.length&&kind!=='operating-return'))throw Error('Capability needs at least one tag');
 const programVersion=c.programVersion??1;if(!PROGRAM_VERSIONS.includes(programVersion))throw Error('Capability programVersion must be one of '+PROGRAM_VERSIONS.join(', '));
 const tags=new Set();for(const t of c.tags){if(!Number.isInteger(t)||t<0||t>255)throw Error('Capability tags must be 0..255');if(NEVER_GRANTABLE_TAGS.has(t))throw Error('Tag '+t+' can never be granted: it sets recipients, authorities or parents, or is user-signed');if(programVersion>=2&&!keeperTagsFor(programVersion).has(t))throw Error('Tag '+t+' is not a keeper tag of program version '+programVersion);tags.add(t);}
 const recipients=c.recipients??[];if(!Array.isArray(recipients)||recipients.some(r=>!isAddress(r)))throw Error('Capability recipients must be addresses');
 if(kind==='keeper'&&recipients.length)throw Error('A keeper capability carries no recipients');
 if(kind==='fee-setup'&&(programVersion!==3||tags.size!==1||!tags.has(20)||recipients.length<1||recipients.length>2||new Set(recipients).size!==recipients.length))throw Error('Fee setup requires v3, tag 20 and sealed recipients');
 if(kind==='operating-return'&&(programVersion!==3||tags.size!==0||recipients.length!==1))throw Error('Operating return requires v3, no tags and exactly one recipient');
 const limits={...DEFAULT_LIMITS};
 for(const [k,v] of Object.entries(c.limits??{})){if(!LIMIT_KEYS.includes(k))throw Error('Unknown limit '+k);if(!Number.isSafeInteger(v)||v<0)throw Error('Limit '+k+' must be a non-negative integer');limits[k]=Math.min(DEFAULT_LIMITS[k],v);}
 const expiresAt=Date.parse(c.expiresAt);if(!Number.isFinite(expiresAt))throw Error('Capability needs an ISO expiresAt');
 return {capabilityId:c.capabilityId??null,campaign,programId,genesisHash,kind,programVersion,tags,recipients,limits,expiresAt:new Date(expiresAt).toISOString(),expired:expiresAt<=now(),revoked:!!c.revokedAt};
}
/** Loads the live grants: from the registry (signer_capabilities) or from a JSON file {version:1, capabilities:[...]}.
 * Returns Map campaign -> capability (the latest grant wins) plus the skipped ones with a reason. Refuses to run with no source. */
export async function loadCapabilities({registry=null,file=null,now=Date.now}={}){
 let list;
 if(registry)list=await registry.capabilities.list({includeExpired:true});
 else if(file){const j=JSON.parse(readFileSync(file,'utf8'));if(j?.version!==CAPABILITY_FILE_VERSION||!Array.isArray(j.capabilities))throw Error('Capability file must be {version:1, capabilities:[...]}');list=j.capabilities;}
 else throw Error('Capabilities need a registry or a file: a signer with no capability source signs nothing on this path');
 const capabilities=new Map(),skipped=[];
 // The ordered source declares the latest grant. Expiration/revocation must not
 // resurrect an older grant. A campaign address on two ledgers is ambiguous in
 // this wire protocol and is refused until an explicitly scoped source is used.
 const latest=new Map(),scopes=new Map();
 for(const raw of list){
  const campaign=raw?.campaign;if(typeof campaign!=='string')continue;
  if(!scopes.has(campaign))scopes.set(campaign,new Set());
  scopes.get(campaign).add(String(raw?.genesisHash)+':'+String(raw?.programId));latest.set(campaign,raw);
 }
 for(const raw of latest.values()){
  if(scopes.get(raw.campaign).size>1){skipped.push({campaign:raw.campaign,reason:'ambiguous ledger or program'});continue;}
  let c;try{c=normalizeCapability(raw,{now});}catch(e){skipped.push({campaign:raw?.campaign??null,reason:String(e.message).slice(0,160)});continue;}
  if(c.revoked){skipped.push({campaign:c.campaign,reason:'revoked'});continue;}
  if(c.expired){skipped.push({campaign:c.campaign,reason:'expired'});continue;}
  capabilities.set(c.campaign,c);
 }
 return {capabilities,skipped};
}
export const messageHash=message=>createHash('sha256').update(Buffer.from(message.serialize())).digest('hex');
export const MEMO_PROGRAM='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const u32=(b,at)=>b.length>=at+4?b.readUInt32LE(at):null,u64=(b,at)=>b.length>=at+8?b.readBigUInt64LE(at):null;
/** The return of a terminally refunded campaign's unused operating reserve (option 1): exactly one system transfer from the
 * operator to the capability's single recipient (the sealed creator) plus one memo, optional compute budget, nothing else.
 * The transfer amount counts fully against the signer's spend ceilings and the campaign's operating hold. */
export function evaluateReturnMessage(message,{operator,recipient,limits=DEFAULT_LIMITS}){
 const fail=reason=>({ok:false,reason});
 const op=new PublicKey(operator).toBase58(),to=b58(recipient);if(!to||to===op)return fail('return recipient invalid');
 if(message.addressTableLookups?.length)return fail('lookup tables not allowed for a return');
 const keys=message.staticAccountKeys.map(k=>k.toBase58());
 if(keys[0]!==op||message.header.numRequiredSignatures!==1)return fail('fee payer is not the sole operator signer');
 const ixs=message.compiledInstructions;if(!ixs.length||ixs.length>4)return fail('instruction count out of bounds');
 let cuLimit=null,cuPrice=0n,transfers=0,memos=0,lamports=0n;const operations=[];
 for(const ix of ixs){
  const pid=keys[ix.programIdIndex],data=Buffer.from(ix.data),acc=ix.accountKeyIndexes.map(i=>keys[i]);if(!pid||acc.some(a=>!a))return fail('instruction references an unknown account');
  if(pid===PROGRAMS.compute){
   const kind=data[0];
   if(kind===2){const v=u32(data,1);if(v===null||v>limits.maxComputeUnits)return fail('compute unit limit out of bounds');cuLimit=v;operations.push('cu-limit');continue;}
   if(kind===3){const v=u64(data,1);if(v===null)return fail('bad compute price');cuPrice=v;operations.push('cu-price');continue;}
   return fail('compute budget instruction not allowed');
  }
  if(pid===PROGRAMS.system){
   if(u32(data,0)!==2||data.length!==12)return fail('only a system transfer may return operating reserve');
   const amount=u64(data,4);if(amount===null||amount<=0n||amount>BigInt(limits.maxTransferLamports))return fail('transfer amount out of bounds');
   if(acc.length!==2||acc[0]!==op||acc[1]!==to)return fail('return transfer must go from the operator to the sealed creator');
   transfers++;lamports+=amount;operations.push('operating-return');continue;
  }
  if(pid===MEMO_PROGRAM){if(acc.length||data.length>128)return fail('memo out of bounds');memos++;operations.push('memo');continue;}
  return fail('program not allowed in a return');
 }
 if(transfers!==1||memos!==1)return fail('a return carries exactly one transfer and one memo');
 const units=BigInt(cuLimit??Math.min(limits.maxComputeUnits,200_000*ixs.length));
 const priorityFeeLamports=(units*cuPrice+999_999n)/1_000_000n;
 if(priorityFeeLamports>BigInt(limits.maxPriorityFeeLamports))return fail('priority fee out of bounds');
 return {ok:true,spendLamports:lamports+priorityFeeLamports+BASE_FEE_LAMPORTS,priorityFeeLamports,baseFeeLamports:BASE_FEE_LAMPORTS,operations,returnLamports:lamports};
}
/**
 * Evaluates one capability-scoped signing request. `replay` is the signer's operation registry and `fences` its fencing
 * marks (both check only; the service approves and records after charging). Returns {ok:true, capability, spendLamports,
 * priorityFeeLamports, operations, hash, replay, fenceKey} or {ok:false, reason}.
 */
export function evaluateCapabilityRequest({message,campaign,fencingToken,operationId,operationKey=null,capabilities,operator,loadedAddresses=null,distributionProgram=null,replay=null,fences=null,cpiRentEvidence=null,now=Date.now()}){
 const fail=reason=>({ok:false,reason});
 if(!(capabilities instanceof Map))return fail('capabilities not loaded');
 if(typeof campaign!=='string'||!b58(campaign))return fail('campaign required');
 const cap=capabilities.get(campaign);if(!cap)return fail('campaign not served by any capability');
 if(cap.revoked)return fail('capability revoked');if(Date.parse(cap.expiresAt)<=now)return fail('capability expired');
 if(!Number.isSafeInteger(fencingToken)||fencingToken<1)return fail('fencing token required');
 if(typeof operationId!=='string'||!operationId||operationId.length>120)return fail('operation id required');
 if(operationKey!=null&&(typeof operationKey!=='string'||!OPERATION_KEY.test(operationKey)))return fail('operation key malformed');
 const fence=fenceKey(campaign,operationKey,operationId);
 if(fences&&fences.check(fence,fencingToken)==='stale')return fail(STALE_FENCING_TOKEN);
 if(cap.kind==='operating-return'){
  // No launch-program instruction: the grant itself names the one recipient. The signer's operating budget then holds
  // the whole amount and the accounting lane proves the finalized balances before the ledger records the return.
  const verdict=evaluateReturnMessage(message,{operator,recipient:cap.recipients[0],limits:cap.limits});
  if(!verdict.ok)return verdict;
  const hash=messageHash(message),seen=replay?replay.check(operationId,hash,now):'new';
  if(seen===false)return fail('operation id reused for a different message');
  return {ok:true,capability:cap,spendLamports:verdict.spendLamports,priorityFeeLamports:verdict.priorityFeeLamports,baseFeeLamports:verdict.baseFeeLamports,operations:verdict.operations,hash,replay:seen,fenceKey:fence};
 }
 const verdict=evaluateOperatorMessage(message,{operator,programId:cap.programId,campaigns:new Set([cap.campaign]),limits:cap.limits,loadedAddresses,provisioning:false,recipients:cap.recipients.length?cap.recipients:null,unrestricted:false,distributionProgram});
 if(!verdict.ok)return verdict;
 for(const op of verdict.operations){
  if(MUTATING_OPERATIONS.has(op))return fail('capability cannot change recipients, supply or authorities');
  if(op.startsWith('kids:')){const tag=Number(op.slice(5));if(!cap.tags.has(tag))return fail('tag '+tag+' outside capability');if(cap.programVersion>=2&&!keeperTagsFor(cap.programVersion).has(tag))return fail('tag '+tag+' is not a keeper tag of program version '+cap.programVersion);}
 }
 if(!verdict.operations.some(op=>op.startsWith('kids:'))){
  // Version 3 only: the keeper's lookup-table setup for a funding-first launch (tag 42 grant), made of nothing but
  // create/extend instructions with the operator as authority and payer (signer-policy.mjs bounds them and charges the
  // rent); the cost reader then enforces the exact table contents against the sealed record. Nothing else skips the program.
  const real=verdict.operations.filter(o=>!o.startsWith('cu-')&&o!=='heap'&&o!=='loaded-data-limit');
  if(cap.programVersion!==3||!real.length||!real.every(o=>o==='alt-create'||o==='alt-extend'))return fail('capability request does not invoke the launch program');
  if(!cap.tags.has(42))return fail('lookup table setup needs the funding-first launch tag');
 }
 const cpi=evaluateCpiRent({message,cap,operator,loadedAddresses,evidence:cpiRentEvidence,now});if(!cpi.ok)return cpi;
 const cpiFee=cpi.feeLamports??0n,spendLamports=verdict.spendLamports+cpi.lamports+cpiFee;
 // In v3, aggregate top-level setup rent and CPI rent against the same ceiling; a CPI protocol fee has its own bound (cpi-costs).
 if(cap.programVersion===3&&spendLamports-verdict.priorityFeeLamports-verdict.baseFeeLamports-cpiFee>BigInt(cap.limits.maxRentLamports))return fail('Combined rent exceeds capability limit');
 const hash=messageHash(message);
 const seen=replay?replay.check(operationId,hash,now):'new';
 if(seen===false)return fail('operation id reused for a different message');
 return {ok:true,capability:cap,spendLamports,priorityFeeLamports:verdict.priorityFeeLamports,baseFeeLamports:verdict.baseFeeLamports,operations:verdict.operations,hash,replay:seen,fenceKey:fence,...(cpi.validUntil?{costEvidenceValidUntil:cpi.validUntil}:{})};
}
