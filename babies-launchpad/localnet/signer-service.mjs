// Operator signing service: holds the operator key, signs only transaction messages that (1) carry a valid bearer
// token, (2) are paid by the operator key, (3) invoke nothing but the KIDS launch program and a short allowlist of
// system programs, within a per-minute budget. It never sees or moves funds itself; it logs sanitized facts only.
// Run it as its own service on a private network (Railway: separate service, key file on its own volume).
import http from 'node:http';import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';import {dirname,join} from 'node:path';import {createPrivateKey,sign,timingSafeEqual} from 'node:crypto';
import {Keypair,PublicKey,VersionedMessage,Connection} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {evaluateOperatorMessage,createSpendLedger,createOperationRegistry,DEFAULT_LIMITS} from './signer-policy.mjs';
export const LEGACY_ALLOWED_PROGRAMS=['ComputeBudget111111111111111111111111111111','ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb','AddressLookupTab1e1111111111111111111111111'];
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
/** Durable ledger + registry state (JSON on the signer volume): a restart never resets the hourly limit or forgets an approved id. */
function loadState(file){if(!file||!existsSync(file))return {entries:[],seen:new Map()};try{const j=JSON.parse(readFileSync(file,'utf8'));return {entries:(j.ledger||[]).map(e=>({at:Number(e.at),lamports:BigInt(e.lamports)})),seen:new Map(j.registry||[])};}catch{throw Error('Signer state file is unreadable; refusing to start with an unknown spend history');}}
function saveState(file,ledger,registry){if(!file)return;const j={ledger:ledger.entries.map(e=>({at:e.at,lamports:e.lamports.toString()})),registry:[...registry.seen]};const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(j),{mode:0o600});renameSync(tmp,file);}
export function createSignerService({keypair,token,programId,campaigns=null,limits=DEFAULT_LIMITS,provisioning=false,resolveLookups=null,maxPerMinute=60,maxBodyBytes=8192,log=()=>{},now=Date.now,stateFile=null,requireOperationId=false,recipients=null,unrestricted=false,distributionProgram=null}){
 if(!(keypair instanceof Keypair))throw Error('Signer service needs the operator keypair');if(typeof token!=='string'||token.length<32)throw Error('Signer token must be at least 32 characters');
 const program=new PublicKey(programId).toBase58(),served=campaigns?new Set([...campaigns].map(c=>new PublicKey(c).toBase58())):null;
 const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(keypair.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});
 const expected=Buffer.from(token);const stamps=[];const state=loadState(stateFile);let ledger,registry;const persist=()=>saveState(stateFile,ledger,registry);ledger=createSpendLedger({maxHourlyLamports:limits.maxHourlyLamports,now,entries:state.entries,persist});registry=createOperationRegistry({now,seen:state.seen,persist});
 const authorized=header=>{const value=Buffer.from(String(header||'').replace(/^Bearer\s+/i,''));return value.length===expected.length&&timingSafeEqual(value,expected);};
 async function handle(req,res){
  if(req.method==='GET'&&req.url==='/healthz')return json(res,200,{status:'ok',publicKey:keypair.publicKey.toBase58(),provisioning,servedCampaigns:served?served.size:null,hourlySpendLamports:ledger.total().toString()});
  if(req.method!=='POST'||req.url!=='/sign')return json(res,404,{error:'not found'});
  if(!authorized(req.headers.authorization)){log({event:'signer-unauthorized'});return json(res,401,{error:'unauthorized'});}
  const t=now();while(stamps.length&&t-stamps[0]>60000)stamps.shift();if(stamps.length>=maxPerMinute){log({event:'signer-rate-limited'});return json(res,429,{error:'rate limited'});}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>maxBodyBytes)return json(res,413,{error:'too large'});}
  let message,operationId;try{const parsed=JSON.parse(body);message=VersionedMessage.deserialize(Buffer.from(parsed.message,'base64'));operationId=typeof parsed.operationId==='string'&&parsed.operationId.length<=120?parsed.operationId:null;}catch{return json(res,400,{error:'malformed message'});}
  let loadedAddresses=null;
  if(message.addressTableLookups?.length){
   if(!resolveLookups){log({event:'signer-refused',reason:'lookup tables not resolved'});return json(res,403,{error:'lookup tables not resolved'});}
   try{loadedAddresses=await resolveLookups(message.addressTableLookups);}catch(error){log({event:'signer-refused',reason:'lookup resolution failed'});return json(res,403,{error:'lookup resolution failed'});}
  }
  if(requireOperationId&&!operationId){log({event:'signer-refused',reason:'operation id required'});return json(res,400,{error:'operation id required'});}
  const verdict=evaluateOperatorMessage(message,{operator:keypair.publicKey,programId:program,campaigns:served,limits,loadedAddresses,provisioning,recipients,unrestricted,distributionProgram});
  if(!verdict.ok){log({event:'signer-refused',reason:verdict.reason});return json(res,403,{error:verdict.reason});}
  const bytes=Buffer.from(message.serialize()),hash=createHash('sha256').update(bytes).digest('hex');
  const seen=operationId?registry.check(operationId,hash,t):'new';
  if(seen===false){log({event:'signer-refused',reason:'operation id reused for a different message'});return json(res,409,{error:'operation id reused for a different message'});}
  // A retry re-signs identical bytes of an APPROVED signing: the spend was counted then. A refused request records
  // nothing, so its retry is charged again (and refused again while the limit holds). check, charge and approve run
  // synchronously, so two identical requests cannot interleave.
  if(seen!=='retry'&&!ledger.charge(verdict.spendLamports,t)){log({event:'signer-refused',reason:'hourly spending limit',lamports:verdict.spendLamports.toString()});return json(res,403,{error:'hourly spending limit reached'});}
  if(operationId&&seen==='new')registry.approve(operationId,hash,t);
  stamps.push(t);const signature=sign(null,bytes,privateKey);
  log({event:'signer-signed',operations:verdict.operations,spendLamports:verdict.spendLamports.toString(),operationId,version:message.version});
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
