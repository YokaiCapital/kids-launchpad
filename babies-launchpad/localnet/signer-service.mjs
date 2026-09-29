// Operator signing service: holds the operator key, signs only transaction messages that (1) carry a valid bearer
// token, (2) are paid by the operator key, (3) invoke nothing but the KIDS launch program and a short allowlist of
// system programs, within a per-minute budget. It never sees or moves funds itself; it logs sanitized facts only.
// Run it as its own service on a private network (Railway: separate service, key file on its own volume).
import http from 'node:http';import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';import {dirname,join} from 'node:path';import {createPrivateKey,sign,timingSafeEqual} from 'node:crypto';
import {Keypair,PublicKey,VersionedMessage,Connection} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {evaluateOperatorMessage,createSpendLedger,createOperationRegistry,DEFAULT_LIMITS} from './signer-policy.mjs';
import {evaluateCapabilityRequest,createFenceRegistry,STALE_FENCING_TOKEN} from './signer/capabilities.mjs';
import {needsCpiRent} from './signer/cpi-costs.mjs';
import {writeDurableJson} from '../shared/durable-json.mjs';
export const LEGACY_ALLOWED_PROGRAMS=['ComputeBudget111111111111111111111111111111','ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb','AddressLookupTab1e1111111111111111111111111'];
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
/** Durable ledger + registry + fencing state (JSON on the signer volume): a restart never resets the hourly limit, forgets an
 * approved id or lowers a fencing high-water mark. A state file written before fencing marks existed loads with none. */
function loadState(file){if(!file||!existsSync(file))return {entries:[],seen:new Map(),fences:new Map()};try{const j=JSON.parse(readFileSync(file,'utf8'));const fences=new Map();for(const [k,v] of j.fences||[])if(typeof k==='string'&&Number.isSafeInteger(v)&&v>=1)fences.set(k,v);return {entries:(j.ledger||[]).map(e=>({at:Number(e.at),lamports:BigInt(e.lamports)})),seen:new Map(j.registry||[]),fences};}catch{throw Error('Signer state file is unreadable; refusing to start with an unknown spend history');}}
function saveState(file,ledger,registry,fences,durable=false){if(!file)return;const j={ledger:ledger.entries.map(e=>({at:e.at,lamports:e.lamports.toString()})),registry:[...registry.seen],fences:[...fences.seen]};if(durable)return writeDurableJson(file,j);const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(j),{mode:0o600});renameSync(tmp,file);}
/** `capabilities` (optional, P3): a Map campaign -> capability or an async function
 * receiving {campaign} and returning a Map (signer/capabilities.mjs loadCapabilities).
 * A request that names a `campaign` is then evaluated against that campaign's grant only; a request without one takes the
 * legacy path exactly as before. Without the option, a request naming a campaign is refused. A campaign request carries
 * `fencingToken` (the job lease's token) and may carry `operationKey` (the job's operation key): the signer keeps the highest
 * token signed per campaign|operationKey (per campaign|operationId without a key) and refuses a lower one with 409
 * category stale-fencing-token. Version 2 also requires authorizeLease, which checks
 * the current registry grant and job lease. Its result is evidence at check time,
 * not an on-chain cancellation primitive: already signed bytes remain broadcastable. */
/** Refusal classes the persistence boundary may report; anything else is 'other'. */
const PERSISTENCE_REFUSALS=new Map([['Invalid operating signature reservation','reservation'],['Operating packet unavailable','packet-unavailable'],['Operating signer scope changed','scope'],['Invalid operating campaign','scope'],['Operating packet binding differs','binding'],['Operating packet hash differs','message-hash'],['Operating packet cannot sign after expiry','expired'],['Operating signature does not match the held packet','signature-mismatch']]);
export function createSignerService({keypair,token,programId,campaigns=null,limits=DEFAULT_LIMITS,provisioning=false,resolveLookups=null,maxPerMinute=60,maxBodyBytes=8192,log=()=>{},now=Date.now,monotonicNow=()=>performance.now(),stateFile=null,durableState=false,requireOperationId=false,recipients=null,unrestricted=false,distributionProgram=null,capabilities=null,authorizeLease=null,requireCapability=false,readCpiRent=null,operatingBudget=null,ownershipValid=null,capacityWaits=false}){
 if(typeof capacityWaits!=='boolean')throw Error('Invalid signer capacity mode');
 if(ownershipValid!==null&&typeof ownershipValid!=='function')throw Error('Signer ownership validator must be synchronous');
 const owns=()=>ownershipValid===null||ownershipValid()===true;
 if(typeof monotonicNow!=='function')throw Error('Monotonic signing clock required');
 if(typeof durableState!=='boolean'||durableState&&!stateFile)throw Error('Durable signer state needs a private file');
 if(operatingBudget!==null&&(typeof operatingBudget.reserve!=='function'||typeof operatingBudget.recordSignature!=='function'))throw Error('Operating budget must reserve and persist signed packets');
 if(readCpiRent!==null&&typeof readCpiRent!=='function')throw Error('CPI rent reader must be a function');
 if(authorizeLease!==null&&typeof authorizeLease!=='function')throw Error('Lease authority must be a function');
 if(!(keypair instanceof Keypair))throw Error('Signer service needs the operator keypair');if(typeof token!=='string'||token.length<32)throw Error('Signer token must be at least 32 characters');
 const program=new PublicKey(programId).toBase58(),served=campaigns?new Set([...campaigns].map(c=>new PublicKey(c).toBase58())):null;
 const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(keypair.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});
 const expected=Buffer.from(token);const stamps=[];const state=loadState(stateFile);let ledger,registry,fences;const persist=()=>saveState(stateFile,ledger,registry,fences,durableState);ledger=createSpendLedger({maxHourlyLamports:limits.maxHourlyLamports,now,entries:state.entries,persist});registry=createOperationRegistry({now,seen:state.seen,persist});fences=createFenceRegistry({seen:state.fences,persist});
 const capacityUnavailable=(res,error)=>{if(!capacityWaits||error?.code!=='CAPACITY_WAIT')return false;json(res,429,{error:'Signer upstream capacity unavailable',category:'signer-capacity',capacityKind:'rpc',retryAfterMs:Math.max(10,Math.min(300000,Number(error.retryAfterMs)||1000))});return true;};
 const authorized=header=>{const value=Buffer.from(String(header||'').replace(/^Bearer\s+/i,''));return value.length===expected.length&&timingSafeEqual(value,expected);};
 async function handle(req,res){
  if(req.method==='GET'&&req.url==='/healthz')return json(res,owns()?200:503,{status:owns()?'ok':'ownership-unavailable',publicKey:keypair.publicKey.toBase58(),provisioning,servedCampaigns:served?served.size:null,hourlySpendLamports:ledger.total().toString(),...(capabilities?{capabilities:true}:{})});
  if(req.method==='GET'&&req.url==='/readyz')return json(res,owns()?200:503,{status:owns()?'ready':'starting'});
  if(req.method!=='POST'||req.url!=='/sign')return json(res,404,{error:'not found'});
  if(!authorized(req.headers.authorization)){log({event:'signer-unauthorized'});return json(res,401,{error:'unauthorized'});}
  if(!owns())return json(res,503,{error:'signer ownership unavailable'});
  let t=now();while(stamps.length&&t-stamps[0]>60000)stamps.shift();if(stamps.length>=maxPerMinute){log({event:'signer-rate-limited'});return json(res,429,{error:'rate limited',...(capacityWaits?{category:'signer-capacity',capacityKind:'request-rate',retryAfterMs:Math.max(1000,60001-(t-stamps[0]))}:{})});}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>maxBodyBytes)return json(res,413,{error:'too large'});}
  let message,operationId,packetRef=null,campaignRef=null,fencingToken=null,operationKey=null;try{const parsed=JSON.parse(body);message=VersionedMessage.deserialize(Buffer.from(parsed.message,'base64'));operationId=typeof parsed.operationId==='string'&&parsed.operationId.length<=120?parsed.operationId:null;packetRef=parsed.packetRef??null;if(parsed.campaign!==undefined){campaignRef=typeof parsed.campaign==='string'&&parsed.campaign.length<=44?parsed.campaign:'';fencingToken=Number.isSafeInteger(parsed.fencingToken)?parsed.fencingToken:null;if(parsed.operationKey!==undefined)operationKey=typeof parsed.operationKey==='string'&&parsed.operationKey.length<=128?parsed.operationKey:'';}}catch{return json(res,400,{error:'malformed message'});}
  if(requireCapability&&campaignRef===null)return json(res,403,{error:'campaign capability required'});
  let loadedAddresses=null;
  if(message.addressTableLookups?.length){
   if(!resolveLookups){log({event:'signer-refused',reason:'lookup tables not resolved'});return json(res,403,{error:'lookup tables not resolved'});}
   // The v3 resolver (signer/lookup-resolution.mjs) resolves only from the durable packet the request names and proves the
   // pinned tables on the ledger; a registry or RPC failure there is unresolved (retry the same operation), not a refusal.
   try{loadedAddresses=await resolveLookups(message.addressTableLookups,{packetRef,campaign:campaignRef,message});}
   catch(error){
    if(capacityUnavailable(res,error))return;
    if(error?.dependency){log({event:'signer-refused',reason:'lookup resolution unresolved',cause:error.dependency==='timeout'?'dependency-timeout':'dependency-failure'});return json(res,503,{error:'lookup resolution unresolved; retry the same operation',category:'signer-lookup-unresolved'});}
    log({event:'signer-refused',reason:'lookup resolution failed'});return json(res,403,{error:'lookup resolution failed'});
   }
   if(!Array.isArray(loadedAddresses?.writable)||!Array.isArray(loadedAddresses?.readonly)){log({event:'signer-refused',reason:'lookup resolution failed'});return json(res,403,{error:'lookup resolution failed'});}
  }
  if(requireOperationId&&!operationId){log({event:'signer-refused',reason:'operation id required'});return json(res,400,{error:'operation id required'});}
  let verdict;
  if(campaignRef!==null){
   // Capability path (P3): the grant for this campaign decides; the legacy served-campaign set and provisioning flag play no part.
   if(!capabilities){log({event:'signer-refused',reason:'capabilities not configured'});return json(res,403,{error:'capabilities not configured'});}
   let loaded;try{loaded=typeof capabilities==='function'?await capabilities({campaign:campaignRef}):capabilities;}catch(error){if(capacityUnavailable(res,error))return;log({event:'signer-refused',reason:'capabilities unavailable'});return json(res,503,{error:'capabilities unavailable'});}
   let cpiRentEvidence=null;
   if(needsCpiRent(message,loaded?.get(campaignRef),loadedAddresses)){
    if(!readCpiRent)return json(res,503,{error:'CPI rent reader not configured'});
    try{cpiRentEvidence=await readCpiRent();}catch(error){if(capacityUnavailable(res,error))return;return json(res,503,{error:'CPI rent evidence unavailable'});}
   }
   verdict=evaluateCapabilityRequest({message,campaign:campaignRef,fencingToken,operationId,operationKey,capabilities:loaded,operator:keypair.publicKey,loadedAddresses,distributionProgram,replay:registry,fences,cpiRentEvidence,now:now()});
   if(!verdict.ok){log({event:'signer-refused',reason:verdict.reason,campaign:campaignRef||null,...(verdict.reason===STALE_FENCING_TOKEN?{fencingToken,category:'stale-fencing-token'}:{})});if(verdict.reason===STALE_FENCING_TOKEN)return json(res,409,{error:verdict.reason,category:'stale-fencing-token'});return json(res,verdict.reason==='operation id reused for a different message'?409:403,{error:verdict.reason});}
  }else{
   verdict=evaluateOperatorMessage(message,{operator:keypair.publicKey,programId:program,campaigns:served,limits,loadedAddresses,provisioning,recipients,unrestricted,distributionProgram});
   if(!verdict.ok){log({event:'signer-refused',reason:verdict.reason});return json(res,403,{error:verdict.reason});}
  }
  // Reserve shared campaign exposure before the final lease check. No signature
  // can leave this process until its signed packet is durably recorded below.
  // Existing legacy/v2 paths do not acquire a new economic policy here.
  let operatingHold=null;
  if(operatingBudget&&verdict.capability?.programVersion===3){
   try{operatingHold=await operatingBudget.reserve({capability:verdict.capability,operationId,operationKey,packetRef,messageBase64:Buffer.from(message.serialize()).toString('base64'),maximumLamports:String(verdict.spendLamports)});}
   catch(error){
    if(capacityUnavailable(res,error))return;
    if(error?.code==='OPERATING_PACKET_REFUSED'){
     // Deterministic: the packet, its scope, its exact cost template or its opening commitment do not qualify. Class only.
     const m=String(error.message||'');const cause=/commitment|sealed URI|display|Extension/i.test(m)?'commitment':/template|differs|not qualified|Mixed or foreign|Aliased|chunk/i.test(m)?'template':/not current|Prepared packet|binding|scope|attempt|packet/i.test(m)?'packet':'other';
     log({event:'signer-refused',reason:'operating packet refused',cause,operationId,...(campaignRef!==null?{campaign:campaignRef,fencingToken,operationKey}:{})});
     return json(res,409,{error:'operating packet refused ('+cause+')',category:'signer-packet-refused'});
    }
    return json(res,503,{error:'operating budget unavailable or packet unqualified'});
   }
   if(operatingHold?.state==='insufficient')return json(res,409,{error:'campaign operating budget not available',category:'operating-funding-wait'});
   if(operatingHold?.state!=='held')return json(res,409,{error:'campaign operating budget not available'});
  }
  // New programs require authoritative active-lease evidence even for the first
  // signature ever seen for a job. File-only grants cannot enable this path.
  let signingLeaseDeadline=Infinity;
  if(campaignRef!==null&&(verdict.capability.programVersion>=2||authorizeLease)){
   if(!authorizeLease)return json(res,503,{error:'active lease authority not configured'});
   if(!operationKey)return json(res,403,{error:'operation key required for active lease'});
   const started=monotonicNow();let lease;
   try{lease=await authorizeLease({capability:verdict.capability,operationKey,fencingToken});}
   catch{return json(res,503,{error:'active lease authority unavailable'});}
   // Subtract the entire lookup round trip conservatively. No awaited work occurs
   // between this check and signing. A near-expiry lease must renew before retry.
   if(lease?.allowed!==true||!Number.isFinite(lease.validForMs)||lease.validForMs-(monotonicNow()-started)<1000)
    return json(res,409,{error:'active lease no longer valid',category:'stale-fencing-token'});
   signingLeaseDeadline=started+lease.validForMs-1000;
   if(fences.check(verdict.fenceKey,fencingToken)==='stale')return json(res,409,{error:STALE_FENCING_TOKEN,category:'stale-fencing-token'});
  }
  // Other requests may have signed while lookups/lease checks awaited. Recheck
  // both time and rate at the synchronous signing boundary, not just ingress.
  if(!owns())return json(res,503,{error:'signer ownership unavailable'});
  t=now();while(stamps.length&&t-stamps[0]>60000)stamps.shift();
  if(stamps.length>=maxPerMinute)return json(res,429,{error:'rate limited',...(capacityWaits?{category:'signer-capacity',capacityKind:'request-rate',retryAfterMs:Math.max(1000,60001-(t-stamps[0]))}:{})});
  if(campaignRef!==null&&Date.parse(verdict.capability.expiresAt)<=t)return json(res,403,{error:'capability expired'});
  if(verdict.costEvidenceValidUntil&&verdict.costEvidenceValidUntil<=t)return json(res,503,{error:'CPI rent evidence expired'});
  const bytes=Buffer.from(message.serialize()),hash=createHash('sha256').update(bytes).digest('hex');
  const seen=operationId?registry.check(operationId,hash,t):'new';
  if(seen===false){log({event:'signer-refused',reason:'operation id reused for a different message'});return json(res,409,{error:'operation id reused for a different message'});}
  // A retry re-signs identical bytes of an APPROVED signing: the spend was counted then. A refused request records
  // nothing, so its retry is charged again (and refused again while the limit holds). check, charge and approve run
  // synchronously, so two identical requests cannot interleave.
  if(seen!=='retry'&&!ledger.charge(verdict.spendLamports,t)){log({event:'signer-refused',reason:'hourly spending limit',lamports:verdict.spendLamports.toString()});return capacityWaits?json(res,429,{error:'hourly spending limit reached',category:'signer-capacity',capacityKind:'hourly-spend',retryAfterMs:300000}):json(res,403,{error:'hourly spending limit reached'});}
  if(operationId&&seen==='new')registry.approve(operationId,hash,t);
  // The fencing mark rises only for a request that is signed: a refused request (budget, replay, policy) never advances it.
  if(campaignRef!==null)fences.record(verdict.fenceKey,fencingToken);
  // A previous persistence exception may have changed the in-memory registry or
  // fence before failing. V3 retries must flush the entire current journal again,
  // even when approve/record regard the operation as already seen.
  if(durableState)persist();
  // Disk flushes can stall too. The final synchronous boundary must still be
  // inside the conservative lease/grant/cost windows after persistence.
  if(!owns())return json(res,503,{error:'signer ownership unavailable'});
  if(monotonicNow()>=signingLeaseDeadline)return json(res,409,{error:'active lease no longer valid',category:'stale-fencing-token'});
  if(campaignRef!==null&&Date.parse(verdict.capability.expiresAt)<=now())return json(res,403,{error:'capability expired'});
  if(verdict.costEvidenceValidUntil&&verdict.costEvidenceValidUntil<=now())return json(res,503,{error:'CPI rent evidence expired'});
  stamps.push(t);const signature=sign(null,bytes,privateKey);
  if(operatingHold){
   try{await operatingBudget.recordSignature(operatingHold,Buffer.from(signature).toString('base64'));}
   catch(error){
    // Allowlisted diagnostics only: a stage and a cause class, never error text, packet bytes or secrets. A typed refusal
    // happened before any write, so nothing can be persisted; everything else may have persisted and stays unresolved.
    const refused=error?.code==='OPERATING_SIGNATURE_REFUSED';
    const cause=refused?PERSISTENCE_REFUSALS.get(error.message)??'other':error?.dependency==='timeout'?'dependency-timeout':error?.dependency?'dependency-failure':'unknown';
    log({event:'signer-persistence-failed',stage:refused?'refused-before-persist':'unresolved',cause,operationId,...(campaignRef!==null?{campaign:campaignRef,fencingToken,operationKey}:{})});
    if(refused)return json(res,409,{error:'signer refused to persist the signature ('+cause+')',category:'signer-persistence-refused'});
    return json(res,503,{error:'signature persistence unresolved; retry the same operation',category:'signer-persistence-unresolved'});
   }
  }
  log({event:'signer-signed',operations:verdict.operations,spendLamports:verdict.spendLamports.toString(),operationId,version:message.version,...(campaignRef!==null?{campaign:campaignRef,fencingToken,operationKey}:{})});
  return json(res,200,{signature:Buffer.from(signature).toString('base64'),publicKey:keypair.publicKey.toBase58()});
 }
 const server=http.createServer((req,res)=>{handle(req,res).catch(()=>json(res,500,{error:'signer error'}));});server.headersTimeout=5000;server.requestTimeout=10000;
 return {server,handle};
}
export function startSignerService(env=process.env){
 const file=env.KIDS_SIGNER_KEY_FILE,token=env.KIDS_SIGNER_TOKEN,programId=env.KIDS_SIGNER_PROGRAM_ID;const host=env.KIDS_SIGNER_HOST||(env.KIDS_SIGNER_LISTEN||'').split(':')[0]||'127.0.0.1',port=env.KIDS_SIGNER_PORT||(env.KIDS_SIGNER_LISTEN||'').split(':')[1]||'4176';
 if(!file||!token||!programId)throw Error('KIDS_SIGNER_KEY_FILE, KIDS_SIGNER_TOKEN and KIDS_SIGNER_PROGRAM_ID are required');
 const bytes=Uint8Array.from(JSON.parse(readFileSync(file,'utf8')));const keypair=Keypair.fromSecretKey(bytes.slice());bytes.fill(0);
 const campaigns=(env.KIDS_SIGNER_CAMPAIGNS||'').split(',').map(v=>v.trim()).filter(Boolean),provisioning=env.KIDS_SIGNER_ALLOW_PROVISIONING==='1';
 const rpc=env.KIDS_SIGNER_RPC_URL?new Connection(env.KIDS_SIGNER_RPC_URL,'confirmed'):null;
 const resolveLookups=rpc?async lookups=>{const writable=[],readonly=[];for(const l of lookups){const t=(await rpc.getAddressLookupTable(l.accountKey)).value;if(!t)throw Error('table missing');for(const i of l.writableIndexes)writable.push(t.state.addresses[i].toBase58());for(const i of l.readonlyIndexes)readonly.push(t.state.addresses[i].toBase58());}return {writable,readonly};}:null;
 const limits={...DEFAULT_LIMITS,...(env.KIDS_SIGNER_MAX_HOURLY_LAMPORTS?{maxHourlyLamports:Number(env.KIDS_SIGNER_MAX_HOURLY_LAMPORTS)}:{})};
 const realNetwork=!!env.KIDS_NETWORK&&env.KIDS_NETWORK!=='localnet';if(realNetwork&&!campaigns.length)throw Error('KIDS_SIGNER_CAMPAIGNS is required on '+env.KIDS_NETWORK+': a production signer never signs for unlisted campaigns');
 const recipients=(env.KIDS_SIGNER_RECIPIENTS||'').split(',').map(v=>v.trim()).filter(Boolean),stateFile=env.KIDS_SIGNER_STATE_FILE||join(dirname(file),'signer-state.json');
 const service=createSignerService({keypair,token,programId,campaigns:campaigns.length?campaigns:null,provisioning,resolveLookups,limits,recipients:recipients.length?recipients:null,unrestricted:!realNetwork&&!campaigns.length,requireOperationId:realNetwork||env.KIDS_SIGNER_REQUIRE_OPERATION_ID==='1',stateFile,distributionProgram:env.KIDS_SIGNER_DISTRIBUTION_PROGRAM||null,log:line=>console.log(JSON.stringify(line))});
 service.server.listen(Number(port),host,()=>console.log(JSON.stringify({event:'signer-listening',host,port:Number(port),publicKey:keypair.publicKey.toBase58()})));
 return service;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href)startSignerService();
