// Mainnet parent-holder snapshot for KIDS (policy: deployment/PARENT-SNAPSHOT-POLICY.md).
// Ported from the Pairz reader (apps/api/src/community-snapshot.ts) and re-audited for KIDS:
//  - eligibility per parent, aggregated by token-account OWNER, exact integers: balance * 2000 >= supply
//    (identical to the program's threshold ceil(supply * 5 / 10000), claims.rs);
//  - the Helius DAS index only NOMINATES accounts; every kept account is read back from the chain at
//    finalized commitment and the chain reading is what is stored;
//  - both token programs, with an explicit Token-2022 extension policy that fails closed;
//  - no partial result ever leaves this module: any RPC error, slot drift, supply change or
//    inconsistency throws before evidence is written, and evidence files are create-once.
// The RPC URL carries the Helius credential: it never appears in logs, errors or evidence.
import {createHash} from 'node:crypto';
import {openSync,writeSync,fsyncSync,closeSync,mkdirSync,existsSync,constants,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackMint,unpackAccount,getExtensionTypes,ExtensionType,getTransferFeeAmount} from '@solana/spl-token';

export const MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const DAS_PAGE_SIZE=1000,DAS_MAXIMUM_PAGES=1000,DAS_MAXIMUM_CURSOR=512,DAS_TIMEOUT_MS=20000,DAS_RETRIES=5,DAS_RETRY_MS=400;
/** A full read of a 400k-account parent takes minutes; both slots are always published. */
export const MAXIMUM_SLOT_DRIFT=9000,VERIFY_BATCH=100,MAXIMUM_TOKEN_ACCOUNTS=1000000;
export const METHODOLOGY='helius-das-getTokenAccounts nominates (union of two concurrent passes); finalized getMultipleAccounts read-back at or after the last pass decides';
/** Owners that can never claim: the incinerator. Program-owned accounts and PDAs are off curve and excluded by that rule. */
export const EXCLUDED_OWNERS=new Set(['1nc1nerator11111111111111111111111111111111']);
/** Owner decision, 20 September 2026: no wallet takes more than 2% of a parent's pool; wallets above are counted at 2%. */
export const PER_OWNER_CAP_BPS=200;
/** Named exclusions (deployment/PARENT-SNAPSHOT-EXCLUSIONS.json): only entries with confirmed:true are applied;
 * proposed entries are carried in the evidence so the decision is visible. Reasons are published, never inferred silently. */
export function loadExclusions(file){ // file: JSON text or a parsed object
 const raw=typeof file==='string'?JSON.parse(file):file;check(raw&&Array.isArray(raw.owners),'Exclusion list needs an owners array');
 const active=new Map(),proposed=[];
 for(const e of raw.owners){check(typeof e.owner==='string'&&BASE58.test(e.owner)&&typeof e.reason==='string'&&e.reason.length>0,'Exclusion entries need owner and reason');if(e.confirmed===true)active.set(e.owner,e.reason);else proposed.push(e.owner);}
 return {active,proposed,version:raw.version??null};
}
/** Custodial signals on the eligible owners: FACTS (lamports, non-empty token accounts, the context slot of the
 * balance read) and, separately, a HEURISTIC (the exchange-profile rule, low confidence). Every owner ends in an
 * explicit outcome: resolved, or unresolved after bounded retries. An unresolved owner is never "safe" and never
 * "custodial"; it makes the result incomplete, and incomplete evidence is not published. Lookups are deduplicated
 * per owner within a run and run with bounded concurrency; nothing is cached across runs. */
export const CUSTODIAL_SIGNAL={minSol:1000,minTokenAccounts:100,rule:'sol >= 1000 and tokenAccounts >= 100',confidence:'low: on-chain profile only; exchange status is confirmed by the owner in the exclusion list'};
export async function custodialSignals(rpcUrl,owners,{fetchImpl=globalThis.fetch,log=()=>{},concurrency=4,policy=READ_RETRY_POLICY,deadlineAt=Date.now()+READ_RETRY_POLICY.operationDeadlineMs,sleep=pause}={}){
 const unique=[...new Set(owners)],entries=new Map();
 const lookup=async owner=>{
  try{
   const balance=await withReadRetries('getBalance '+owner.slice(0,6),()=>rpcCall(rpcUrl,'getBalance',[owner,{commitment:'finalized'}],{fetchImpl,timeoutMs:policy.requestTimeoutMs}),{policy,deadlineAt,log,sleep});
   // Lamports arrive as a JSON number; above 2^53 (about 9 million SOL, possible for an exchange) precision is lost,
   // which is harmless for a profile heuristic but must not be mistaken for a malformed answer.
   check(balance&&Number.isSafeInteger(balance.context?.slot)&&typeof balance.value==='number'&&Number.isFinite(balance.value)&&balance.value>=0,'getBalance answered without context or value');
   const page=await withReadRetries('getTokenAccounts(owner) '+owner.slice(0,6),()=>rpcCall(rpcUrl,'getTokenAccounts',{owner,limit:1000,displayOptions:{showZeroBalance:false}},{fetchImpl,timeoutMs:policy.requestTimeoutMs}),{policy,deadlineAt,log,sleep});
   const tokenAccounts=Number.isSafeInteger(page?.total)?page.total:Array.isArray(page?.token_accounts)?page.token_accounts.length:null;
   check(tokenAccounts!==null,'getTokenAccounts answered without a count');
   const sol=balance.value/1e9;
   entries.set(owner,{owner,status:'resolved',facts:{lamports:balance.value,sol:Math.round(sol*1000)/1000,tokenAccounts,contextSlot:balance.context.slot},heuristic:{rule:CUSTODIAL_SIGNAL.rule,flagged:sol>=CUSTODIAL_SIGNAL.minSol&&tokenAccounts>=CUSTODIAL_SIGNAL.minTokenAccounts,confidence:CUSTODIAL_SIGNAL.confidence},failure:null});
  }catch(error){const f=classifyFailure(error);entries.set(owner,{owner,status:'unresolved',facts:null,heuristic:null,failure:{category:f.category,attempts:error?.attempts??1,message:sanitize(f.message).slice(0,160)}});}
 };
 let next=0;await Promise.all(Array.from({length:Math.min(concurrency,unique.length)},async()=>{while(next<unique.length){const owner=unique[next++];await lookup(owner);}}));
 const list=unique.map(o=>entries.get(o));const unresolved=list.filter(e=>e.status==='unresolved').length;
 return {rule:CUSTODIAL_SIGNAL,expected:unique.length,resolved:unique.length-unresolved,unresolved,complete:unresolved===0,entries:list};
}
/** Optional per-owner cap on the COUNTED balance, so the on-chain pro-rata (allocation = reserve * balance / eligible)
 * needs no program change: an owner above `capBps` of the eligible total is counted at the cap and the rest is
 * re-split among the others, iterated until stable (the Pairz rule). Returns counted balances for the tree. */
export function applyOwnerCap(balances,capBps){
 check(Number.isInteger(capBps)&&capBps>=1&&capBps<=10000,'capBps must be an integer in [1, 10000]');
 if(capBps===10000)return {balances:balances.map(b=>({...b})),capped:0};
 // Fixed point: a capped owner is counted at c = capBps/10000 of the counted total T, with T = k*c + U
 // (k capped owners, U the uncapped sum), so c = capBps*U / (10000 - k*capBps). Cap more owners until stable.
 const sorted=[...balances].sort((a,b)=>a.balance>b.balance?-1:a.balance<b.balance?1:sortKeys(a.owner,b.owner));
 let k=0,c=null;
 for(;;){
  check(k<=sorted.length,'Cap iteration did not converge');
  // Everyone capped (fewer than 10000/capBps wallets): each is counted at the smallest original balance, and the caller
  // raises the eligible total so every wallet still receives exactly capBps of the pool; the rest stays unallocated.
  if(k===sorted.length){c=sorted.at(-1)?.balance??0n;break;}
  const U=sorted.slice(k).reduce((s,b)=>s+b.balance,0n),denominator=10000n-BigInt(k)*BigInt(capBps);
  check(denominator>0n,'Cap cannot be satisfied');
  c=BigInt(capBps)*U/denominator;
  if(sorted[k].balance>c){k+=1;continue;}
  break;
 }
 const cappedOwners=new Set(sorted.slice(0,k).map(b=>b.owner));
 return {balances:balances.map(b=>({owner:b.owner,balance:cappedOwners.has(b.owner)?c:b.balance,originalBalance:b.balance})),capped:k};
}
/** Token-2022 mint extensions a parent may carry. Anything else (transfer fee, hook, permanent delegate,
 * confidential transfer, non-transferable, default frozen, pausable, ...) refuses the snapshot. */
export const ALLOWED_MINT_EXTENSIONS=new Set([ExtensionType.MetadataPointer,ExtensionType.TokenMetadata,ExtensionType.MintCloseAuthority]);
/** Token-2022 account extensions a holder's account may carry. TransferFeeAmount is accepted only when nothing is withheld. */
export const ALLOWED_ACCOUNT_EXTENSIONS=new Set([ExtensionType.ImmutableOwner,ExtensionType.MemoTransfer,ExtensionType.CpiGuard,ExtensionType.TransferFeeAmount]);
/** Read-only retry policy (docs/RELIABILITY-RULES.md). NEVER used for commits, payouts or swaps. */
export const READ_RETRY_POLICY={attempts:4,baseMs:400,maxMs:4000,jitterMs:250,requestTimeoutMs:20000,operationDeadlineMs:15*60000};
/** Strips credentials, including keys embedded in RPC URLs, from anything that is logged or thrown. */
export const sanitize=text=>String(text).replace(/api[-_]?key=[^&\s"')]+/gi,'api-key=<redacted>').replace(/https?:\/\/[^\s"')]*helius[^\s"')]*/gi,'<helius-url>');
/** A classified failure. `retry` says whether a bounded retry is allowed. */
export class ReadFailure extends Error{constructor(category,message,{retry=false,retryAfterMs=null,status=null}={}){super(sanitize(message));this.category=category;this.retry=retry;this.retryAfterMs=retryAfterMs;this.status=status;}}
const parseRetryAfter=value=>{if(!value)return null;const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return Math.min(seconds*1000,60000);const at=Date.parse(value);return Number.isFinite(at)?Math.max(0,Math.min(at-Date.now(),60000)):null;};
/** Classifies a thrown error or an HTTP/JSON-RPC response. Transient network faults, timeouts, 429 and 5xx retry;
 * invalid requests, authentication failures, malformed responses and RPC argument errors do not. */
export function classifyFailure(error){
 if(error instanceof ReadFailure)return error;
 const name=error?.name,message=String(error?.message??error);
 if(name==='AbortError'||name==='TimeoutError'||/timed? ?out/i.test(message))return new ReadFailure('timeout',message,{retry:true});
 if(error instanceof TypeError||/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(message))return new ReadFailure('transient',message,{retry:true});
 if(/429|Too many requests/i.test(message))return new ReadFailure('rate-limited',message,{retry:true});
 if(/\b(500|502|503|504)\b|Server error|-32005|-32016|Minimum context slot has not been reached/i.test(message))return new ReadFailure('transient',message,{retry:true});
 return new ReadFailure('permanent',message,{retry:false});
}
export function classifyResponse(response){
 if(response.ok)return null;const s=response.status;const retryAfterMs=parseRetryAfter(response.headers?.get?.('retry-after'));
 if(s===429)return new ReadFailure('rate-limited','HTTP 429',{retry:true,retryAfterMs,status:s});
 if(s===500||s===502||s===503||s===504)return new ReadFailure('transient','HTTP '+s,{retry:true,retryAfterMs,status:s});
 if(s===401||s===403)return new ReadFailure('auth','HTTP '+s,{status:s});
 return new ReadFailure('permanent','HTTP '+s,{status:s});
}
/** Bounded retries: exponential backoff with jitter, Retry-After honoured, an overall deadline, and an explicit
 * `unresolved` failure when attempts run out. Every attempt is logged with a sanitized category and latency. */
export async function withReadRetries(label,fn,{policy=READ_RETRY_POLICY,deadlineAt=Date.now()+READ_RETRY_POLICY.operationDeadlineMs,log=()=>{},sleep=pause,random=Math.random}={}){
 let last=null;
 for(let attempt=1;attempt<=policy.attempts;attempt+=1){
  const started=Date.now();
  try{const value=await fn(attempt);log({event:'read-ok',label,attempt,latencyMs:Date.now()-started});return value;}
  catch(error){
   last=classifyFailure(error);log({event:'read-failed',label,attempt,category:last.category,latencyMs:Date.now()-started});
   if(!last.retry||attempt===policy.attempts)break;
   const backoff=Math.min(policy.maxMs,policy.baseMs*2**(attempt-1))+Math.floor(random()*policy.jitterMs);
   const wait=last.retryAfterMs!==null&&last.retryAfterMs!==undefined?Math.max(last.retryAfterMs,backoff):backoff;
   if(Date.now()+wait>deadlineAt){last=new ReadFailure('deadline',label+': operation deadline reached',{retry:false});break;}
   await sleep(wait);
  }
 }
 throw Object.assign(new ReadFailure(last.category,label+' unresolved ('+last.category+'): '+last.message,{retry:false}),{unresolved:true,attempts:policy.attempts});
}
/** One JSON-RPC call over the server-side URL with a real abort on timeout; classifies transport and RPC errors. */
export async function rpcCall(rpcUrl,method,params,{fetchImpl=globalThis.fetch,timeoutMs=READ_RETRY_POLICY.requestTimeoutMs,id='kids-read'}={}){
 let response;
 try{response=await fetchImpl(rpcUrl,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(timeoutMs)});}
 catch(error){throw classifyFailure(error);}
 const refusal=classifyResponse(response);if(refusal)throw refusal;
 let payload;try{payload=await response.json();}catch{throw new ReadFailure('malformed','response is not JSON');}
 if(!payload||payload.jsonrpc!=='2.0')throw new ReadFailure('malformed','response is not JSON-RPC 2.0');
 if(payload.error){const code=payload.error.code;const transient=code===-32005||code===-32016||code===-32603;throw new ReadFailure(transient?'transient':'permanent','rpc error '+(Number.isSafeInteger(code)?code:'?'),{retry:transient});}
 return payload.result;
}
const U64=(1n<<64n)-1n,BASE58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,DIGITS=/^(?:0|[1-9][0-9]{0,19})$/;
const check=(ok,message)=>{if(!ok)throw Error(message);};
const sha256=text=>createHash('sha256').update(text,'utf8').digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export const sortKeys=(a,b)=>a<b?-1:a>b?1:0;
/** Exact 0.05% rule: an owner is eligible when balance * 2000 >= supply (no division, no rounding). */
export const meetsThreshold=(balance,supply)=>balance*2000n>=supply;
/** The program's formula, ceil(supply*5/10000); exported so a test can prove both rules agree. */
export const programThreshold=supply=>(supply*5n+9999n)/10000n;
export function parseRawAmount(value,label){
 let amount;if(typeof value==='number'){check(Number.isInteger(value)&&value>=0,label+' is not a nonnegative integer amount');amount=BigInt(value);}
 else{check(typeof value==='string'&&DIGITS.test(value),label+' is not a nonnegative integer amount');amount=BigInt(value);}
 check(amount<=U64,label+' exceeds the u64 range');return amount;
}
const extensionName=type=>ExtensionType[type]??('extension#'+type);
/** Reads and classifies the mint on chain: which token program owns it decides how every account is decoded. */
export async function readParentMint(connection,mint){
 const address=new PublicKey(mint),info=await connection.getAccountInfo(address,'finalized');
 check(info,'Parent mint '+mint+' has no finalized account');
 const programId=info.owner.equals(TOKEN_2022_PROGRAM_ID)?TOKEN_2022_PROGRAM_ID:info.owner.equals(TOKEN_PROGRAM_ID)?TOKEN_PROGRAM_ID:null;
 check(programId,'Parent mint '+mint+' is not owned by a token program');
 const unpacked=unpackMint(address,info,programId);
 const extensions=programId.equals(TOKEN_2022_PROGRAM_ID)?getExtensionTypes(unpacked.tlvData):[];
 const refused=extensions.filter(t=>!ALLOWED_MINT_EXTENSIONS.has(t)).map(extensionName);
 check(!refused.length,'Parent mint '+mint+' carries unsupported Token-2022 extensions: '+refused.join(', ')+'. Balances under such extensions are not freely spendable or not decodable by this policy; refusing the snapshot.');
 return {mint:address.toBase58(),programId,tokenProgram:programId.equals(TOKEN_2022_PROGRAM_ID)?'token-2022':'spl-token',decimals:unpacked.decimals,supply:unpacked.supply,mintAuthority:unpacked.mintAuthority?.toBase58()??null,freezeAuthority:unpacked.freezeAuthority?.toBase58()??null,extensions:extensions.map(extensionName)};
}
/** Decodes one chain reading of a token account of `mint`. Returns {owner,amount,frozen} or {excluded:reason}. */
export function decodeTokenAccount(address,info,expected){
 if(!info||!info.owner.equals(expected.programId))return {excluded:'stale'};
 let account;try{account=unpackAccount(new PublicKey(address),info,expected.programId);}catch{return {excluded:'undecodable'};}
 if(account.mint.toBase58()!==expected.mint||!account.isInitialized)return {excluded:'stale'};
 if(account.isFrozen)return {excluded:'frozen'};
 if(expected.tokenProgram==='token-2022'){
  const types=getExtensionTypes(account.tlvData);
  if(types.some(t=>!ALLOWED_ACCOUNT_EXTENSIONS.has(t)))return {excluded:'unsupported-extension'};
  if(types.includes(ExtensionType.TransferFeeAmount)&&(getTransferFeeAmount(account)?.withheldAmount??0n)!==0n)return {excluded:'withheld-fee'};
 }
 return {owner:account.owner.toBase58(),amount:account.amount,frozen:false};
}
const isOnCurve=owner=>{try{return PublicKey.isOnCurve(new PublicKey(owner).toBytes());}catch{return false;}};
/** One nomination pass over a nominator (index or program-accounts read): owner totals and addresses as the
 * source served them. Nothing here decides eligibility. Throws on any inconsistency or transport error. */
export async function nominateParentHolders(connection,nominator,mint,options={}){
 const cap=options.maxTokenAccounts??MAXIMUM_TOKEN_ACCOUNTS,drift=options.maximumSlotDrift??MAXIMUM_SLOT_DRIFT;
 nominator.reset?.();
 const slotBefore=await connection.getSlot('finalized');check(Number.isSafeInteger(slotBefore)&&slotBefore>0,'No finalized slot before the read');
 const ownerTotals=new Map(),ownerAccounts=new Map(),seen=new Set(),cursors=new Set();
 let indexTotal=0n,pages=0,scanned=0,duplicateRows=0,skippedRows=0,cursor;
 for(;;){
  const page=await nominator.getTokenAccounts({mint,limit:DAS_PAGE_SIZE,...(cursor===undefined?{}:{cursor})});
  pages+=1;check(pages<=DAS_MAXIMUM_PAGES,'Token-account paging did not terminate');
  const rows=page.token_accounts;check(Array.isArray(rows)&&rows.length<=DAS_PAGE_SIZE,'Token-account page is malformed');
  skippedRows+=page.skipped??0;
  for(const row of rows){
   check(typeof row.address==='string'&&BASE58.test(row.address)&&row.mint===mint&&typeof row.owner==='string'&&BASE58.test(row.owner),'Token-account row is malformed');
   if(seen.has(row.address)){duplicateRows+=1;continue;}seen.add(row.address);
   const amount=parseRawAmount(row.amount,'Token account '+row.address);indexTotal+=amount;scanned+=1;
   ownerTotals.set(row.owner,(ownerTotals.get(row.owner)??0n)+amount);
   const list=ownerAccounts.get(row.owner);if(list)list.push(row.address);else ownerAccounts.set(row.owner,[row.address]);
  }
  check(scanned<=cap,'Parent community is too large for a snapshot (> '+cap+' token accounts)');
  options.onProgress?.({pages,accountsScanned:scanned});
  const next=page.cursor??undefined;if(next===undefined||rows.length===0)break;
  check(typeof next==='string'&&next.length>0&&next.length<=DAS_MAXIMUM_CURSOR&&!cursors.has(next),'Token-account paging did not terminate');cursors.add(next);cursor=next;
 }
 const slotAfter=await connection.getSlot('finalized');
 check(Number.isSafeInteger(slotAfter)&&slotAfter>=slotBefore&&slotAfter-slotBefore<=drift,'Nomination spanned too many slots ('+slotBefore+' to '+slotAfter+'); retry');
 return {slotBefore,slotAfter,sourceSlots:nominator.contextSlots?.()??null,pages,accountsScanned:scanned,indexTotal,duplicateRows,skippedRows,ownerTotals,ownerAccounts};
}
/** The snapshot. Nomination: `passes` (default 2) full reads of the source, taken back to back; every owner that
 * reaches the floor in ANY pass is a candidate (the union, so a live token's balance changes between passes
 * cannot drop an owner). Decision: one finalized chain read-back of every candidate account with
 * minContextSlot at or after the last pass; the chain readings are aggregated per owner and the floor is
 * applied to them. Any error anywhere throws; nothing partial is returned. */
export async function readParentSnapshot(connection,nominator,mint,options={}){
 check(typeof mint==='string'&&BASE58.test(mint),'A parent snapshot needs a base58 mint');
 const passes=options.passes??2;check(Number.isInteger(passes)&&passes>=1&&passes<=3,'Passes must be 1 to 3');
 const expectedGenesis=options.expectedGenesis??MAINNET_GENESIS,genesisHash=await connection.getGenesisHash();
 check(genesisHash===expectedGenesis,'Snapshot refused: ledger genesis '+genesisHash+' is not the expected network');
 const before=await readParentMint(connection,mint),supply=before.supply;check(supply>0n,'Parent mint has no supply');
 // Passes run concurrently by default (the DAS client is stateless); a stateful nominator must set concurrentPasses:false.
 const runs=options.concurrentPasses===false?[]:await Promise.all(Array.from({length:passes},()=>nominateParentHolders(connection,nominator,mint,options)));
 if(options.concurrentPasses===false)for(let pass=1;pass<=passes;pass+=1)runs.push(await nominateParentHolders(connection,nominator,mint,options));
 const after=await readParentMint(connection,mint);check(after.supply===supply&&after.tokenProgram===before.tokenProgram,'Parent supply or program changed during the read; retry');
 // Candidates: the union over passes of owners at or above the floor per the source, minus owners that can never claim.
 const candidateOwners=new Map();let belowFloorOwners=0,offCurveOwners=0,excludedOwners=0;const perPass=[];
 for(const run of runs){let count=0;for(const [owner,total] of run.ownerTotals){if(!meetsThreshold(total,supply))continue;count+=1;const set=candidateOwners.get(owner)??new Set();for(const a of run.ownerAccounts.get(owner))set.add(a);candidateOwners.set(owner,set);}perPass.push(count);}
 const seenOwners=new Set(runs.flatMap(r=>[...r.ownerTotals.keys()]));belowFloorOwners=seenOwners.size-candidateOwners.size;
 const candidates=[],namedExcluded=[],named=options.exclusions??{active:new Map(),proposed:[],version:null};let onlyInOnePass=0;
 for(const [owner,set] of candidateOwners){
  if(runs.length>1&&runs.filter(r=>meetsThreshold(r.ownerTotals.get(owner)??0n,supply)).length<runs.length)onlyInOnePass+=1;
  if(EXCLUDED_OWNERS.has(owner)||named.active.has(owner)){excludedOwners+=1;namedExcluded.push(owner);continue;}if(!isOnCurve(owner)){offCurveOwners+=1;continue;}
  for(const a of set)candidates.push(a);
 }
 candidates.sort(sortKeys);
 // Decision: the chain, finalized, no earlier than the end of the last pass.
 const minContextSlot=Math.max(...runs.map(r=>r.slotAfter));
 const verified=new Map();let verifiedAccounts=0,staleAccounts=0,frozenAccounts=0,unsupportedAccounts=0,contextMin=Infinity,contextMax=0;
 for(let start=0;start<candidates.length;start+=VERIFY_BATCH){
  const batch=candidates.slice(start,start+VERIFY_BATCH);
  const reply=await withReadRetries('read-back batch '+(start/VERIFY_BATCH+1),()=>connection.getMultipleAccountsInfoAndContext(batch.map(a=>new PublicKey(a)),{commitment:'finalized',minContextSlot}),{log:options.log??(()=>{}),deadlineAt:options.deadlineAt??Date.now()+READ_RETRY_POLICY.operationDeadlineMs});
  const slot=reply?.context?.slot;check(Number.isSafeInteger(slot)&&slot>=minContextSlot&&Array.isArray(reply.value)&&reply.value.length===batch.length,'Chain read-back answered out of order or below the snapshot slot');
  contextMin=Math.min(contextMin,slot);contextMax=Math.max(contextMax,slot);
  batch.forEach((address,i)=>{const r=decodeTokenAccount(address,reply.value[i],before);
   if(r.excluded==='stale'||r.excluded==='undecodable'){staleAccounts+=1;return;}if(r.excluded==='frozen'){frozenAccounts+=1;return;}if(r.excluded){unsupportedAccounts+=1;return;}
   verifiedAccounts+=1;if(!isOnCurve(r.owner)||EXCLUDED_OWNERS.has(r.owner)||named.active.has(r.owner))return;verified.set(r.owner,(verified.get(r.owner)??0n)+r.amount);});
 }
 const balances=[...verified].filter(([,balance])=>meetsThreshold(balance,supply)).sort(([a],[b])=>sortKeys(a,b)).map(([owner,balance])=>({owner,balance}));
 const eligibleBalance=balances.reduce((s,b)=>s+b.balance,0n);check(eligibleBalance<=supply,'Verified balances exceed the supply');
 const signals=options.custodialSignals?await custodialSignals(options.custodialSignals.rpcUrl,balances.map(b=>b.owner),{...options.custodialSignals,log:options.log}):null;
 const complete=signals?signals.complete:true;
 const csv=['owner,balance',...balances.map(b=>b.owner+','+b.balance),''].join('\n');
 const last=runs.at(-1);
 const result={network:'mainnet',genesisHash,mint,tokenProgram:before.tokenProgram,decimals:before.decimals,supply,mintAuthority:before.mintAuthority,freezeAuthority:before.freezeAuthority,mintExtensions:before.extensions,
  threshold:programThreshold(supply),thresholdRule:'balance * 2000 >= supply',methodology:nominator.methodology??METHODOLOGY,
  passes,nominationPasses:runs.map((r,i)=>({slotBefore:r.slotBefore,slotAfter:r.slotAfter,sourceSlots:r.sourceSlots,pages:r.pages,accountsScanned:r.accountsScanned,indexTotalRaw:r.indexTotal,indexOverSupplyRaw:r.indexTotal>supply?r.indexTotal-supply:0n,duplicateRows:r.duplicateRows,skippedRows:r.skippedRows,candidateOwners:perPass[i]})),
  slotBefore:runs[0].slotBefore,slotAfter:last.slotAfter,readBackMinContextSlot:minContextSlot,readBackContextSlots:candidates.length?{min:contextMin,max:contextMax}:null,
  pages:runs.reduce((n,r)=>n+r.pages,0),accountsScanned:last.accountsScanned,indexTotalRaw:last.indexTotal,indexOverSupplyRaw:last.indexTotal>supply?last.indexTotal-supply:0n,duplicateRows:last.duplicateRows,skippedRows:last.skippedRows,
  complete,exclusions:{version:named.version,applied:namedExcluded.sort(sortKeys).map(o=>({owner:o,reason:named.active.get(o)??'incinerator'})),proposedNotApplied:named.proposed.filter(o=>candidateOwners.has(o))},custodialSignals:signals?{...signals,flaggedOwners:signals.entries.filter(e=>e.heuristic?.flagged).map(e=>e.owner)}:null,
  belowFloorOwners,excludedOwners,offCurveOwners,candidateOwnersUnion:candidateOwners.size,candidateOwnersOnlyInSomePasses:onlyInOnePass,candidateAccounts:candidates.length,verifiedAccounts,staleAccounts,frozenAccounts,unsupportedAccounts,
  eligibleOwners:balances.length,eligibleBalance,balances,csv,csvSha256:sha256(csv),readAt:new Date((options.now??Date.now)()).toISOString()};
 result.snapshotSha256=sha256(JSON.stringify(publicParentSnapshot({...result,csv:undefined,csvSha256:undefined,snapshotSha256:undefined,readAt:undefined})));
 return result;
}
/** Single pass, kept for callers that want the nomination view; same decision path with passes = 1. */
export const readParentSnapshotOnce=(connection,nominator,mint,options={})=>readParentSnapshot(connection,nominator,mint,{...options,passes:1});
export function publicParentSnapshot(value){return JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v));}
function writeImmutable(path,content){const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{const b=Buffer.from(content,'utf8');let o=0;while(o<b.length)o+=writeSync(fd,b,o,b.length-o);fsyncSync(fd);}finally{closeSync(fd);}}
/** Create-once evidence: `<dir>/<campaign>/<mint>.csv` and `.json`. A snapshot that exists is the record. */
export function writeParentSnapshotEvidence(directory,campaign,result){
 check(BASE58.test(campaign)&&BASE58.test(result.mint),'Evidence needs base58 campaign and mint');check(result.csvSha256===sha256(result.csv),'Evidence CSV does not match its hash');
 check(result.complete===true,'Incomplete evidence is not published: '+(result.custodialSignals?.unresolved??'?')+' owner lookups unresolved');
 const folder=join(directory,campaign);mkdirSync(folder,{recursive:true,mode:0o700});
 const csvPath=join(folder,result.mint+'.csv'),jsonPath=join(folder,result.mint+'.json');
 check(!existsSync(csvPath)&&!existsSync(jsonPath),'Snapshot evidence for '+result.mint+' already exists');
 writeImmutable(csvPath,result.csv);
 const allocationPath=result.allocation?join(folder,result.mint+'.allocation.csv'):null;if(allocationPath){check(!existsSync(allocationPath),'Allocation evidence already exists');writeImmutable(allocationPath,result.allocation.csv);}
 writeImmutable(jsonPath,JSON.stringify(publicParentSnapshot({...result,csv:undefined,allocation:result.allocation?{...result.allocation,csv:undefined,balances:undefined}:undefined,campaign}),null,2)+'\n');
 return {csvPath,jsonPath,allocationPath};
}
/** Why no getProgramAccounts path: Helius refuses the classic read above a size threshold, and its
 * getProgramAccountsV2 pages stride the token program's whole key space before the mint filter, so a large
 * mint yields a few accounts per page (Fartcoin, 20 Sep 2026: 4, 2, 5 accounts per 10,000-stride page).
 * The DAS index read stays the nominator; the two passes and the two parents run concurrently instead. */
/** DAS client over the server-side Helius URL. The URL is never logged or quoted in an error: only its host. */
export function createHeliusDasClient(rpcUrl,fetchImpl=globalThis.fetch,log=()=>{},{policy=READ_RETRY_POLICY,deadlineAt=Date.now()+READ_RETRY_POLICY.operationDeadlineMs,sleep=pause}={}){
 const host=new URL(rpcUrl).host;check(/helius/.test(host),'The DAS client needs a Helius RPC URL');
 return {async getTokenAccounts({mint,limit,cursor}){
  check(BASE58.test(mint)&&Number.isInteger(limit)&&limit>0&&limit<=DAS_PAGE_SIZE&&(cursor===undefined||(typeof cursor==='string'&&cursor.length>0&&cursor.length<=DAS_MAXIMUM_CURSOR)),'Invalid DAS page request');
  const r=await withReadRetries('getTokenAccounts(mint) page',()=>rpcCall(rpcUrl,'getTokenAccounts',{mint,limit,...(cursor===undefined?{}:{cursor}),displayOptions:{showZeroBalance:false}},{fetchImpl,timeoutMs:policy.requestTimeoutMs,id:'kids-parent-snapshot'}),{policy,deadlineAt,log:line=>log({...line,host}),sleep});
  check(r&&Array.isArray(r.token_accounts)&&r.token_accounts.length<=limit&&(r.cursor===undefined||r.cursor===null||typeof r.cursor==='string'),'DAS page is malformed');
  const rows=[];let skipped=0;for(const e of r.token_accounts){if(e&&typeof e.address==='string'&&e.mint===mint&&typeof e.owner==='string'&&(typeof e.amount==='number'||typeof e.amount==='string'))rows.push({address:e.address,mint:e.mint,owner:e.owner,amount:e.amount,frozen:!!e.frozen});else skipped+=1;}
  return {total:r.total??rows.length,limit,cursor:typeof r.cursor==='string'?r.cursor:null,token_accounts:rows,skipped};
 }};
}
/** Final allocation input for the tree: eligible balances with the per-owner cap applied. `balances` are the COUNTED
 * balances (what the on-chain pro-rata uses); every entry keeps its `originalBalance`. Sum stays <= supply. */
export function finalizeParentAllocation(result,{capBps=PER_OWNER_CAP_BPS}={}){
 const {balances,capped}=applyOwnerCap(result.balances,capBps);
 const countedTotal=balances.reduce((s,b)=>s+b.balance,0n);check(countedTotal<=result.supply,'Counted balances exceed the supply');
 // Every capped wallet must hold exactly capBps of the pool. With few wallets (all capped) the counted sum is too small
 // for that, so the eligible total is raised to c * 10000 / capBps and the unallocated remainder stays in custody.
 const cappedBalance=capped?balances.find(b=>b.balance!==b.originalBalance)?.balance??null:null;
 const eligibleTotal=cappedBalance!==null&&cappedBalance*10000n>countedTotal*BigInt(capBps)?cappedBalance*10000n/BigInt(capBps):countedTotal;
 check(eligibleTotal<=result.supply,'Eligible total exceeds the supply');
 const unallocatedBps=Number((eligibleTotal-countedTotal)*10000n/eligibleTotal);
 const csv=['owner,countedBalance,originalBalance',...balances.map(b=>b.owner+','+b.balance+','+b.originalBalance),''].join('\n');
 return {capBps,capped,countedTotal,eligibleTotal,unallocatedBps,balances,csv,csvSha256:sha256(csv)};
}
