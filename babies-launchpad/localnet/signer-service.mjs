// Operator signing service: holds the operator key, signs only transaction messages that (1) carry a valid bearer
// token, (2) are paid by the operator key, (3) invoke nothing but the KIDS launch program and a short allowlist of
// system programs, within a per-minute budget. It never sees or moves funds itself; it logs sanitized facts only.
// Run it as its own service on a private network (Railway: separate service, key file on its own volume).
import http from 'node:http';import {readFileSync} from 'node:fs';import {createPrivateKey,sign,timingSafeEqual} from 'node:crypto';
import {Keypair,PublicKey,VersionedMessage,Connection} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {evaluateOperatorMessage,createSpendLedger,createOperationRegistry,DEFAULT_LIMITS} from './signer-policy.mjs';
export const LEGACY_ALLOWED_PROGRAMS=['ComputeBudget111111111111111111111111111111','ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb','AddressLookupTab1e1111111111111111111111111'];
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
export function createSignerService({keypair,token,programId,campaigns=null,limits=DEFAULT_LIMITS,provisioning=false,resolveLookups=null,maxPerMinute=60,maxBodyBytes=8192,log=()=>{},now=Date.now}){
 if(!(keypair instanceof Keypair))throw Error('Signer service needs the operator keypair');if(typeof token!=='string'||token.length<32)throw Error('Signer token must be at least 32 characters');
 const program=new PublicKey(programId).toBase58(),served=campaigns?new Set([...campaigns].map(c=>new PublicKey(c).toBase58())):null;
 const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(keypair.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});
 const expected=Buffer.from(token);const stamps=[];const ledger=createSpendLedger({maxHourlyLamports:limits.maxHourlyLamports,now}),registry=createOperationRegistry({now});
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
  const verdict=evaluateOperatorMessage(message,{operator:keypair.publicKey,programId:program,campaigns:served,limits,loadedAddresses,provisioning});
  if(!verdict.ok){log({event:'signer-refused',reason:verdict.reason});return json(res,403,{error:verdict.reason});}
  const bytes=Buffer.from(message.serialize()),hash=createHash('sha256').update(bytes).digest('hex');
  const seen=operationId?registry.check(operationId,hash,t):'new';
  if(seen===false){log({event:'signer-refused',reason:'operation id reused for a different message'});return json(res,409,{error:'operation id reused for a different message'});}
  // A retry re-signs identical bytes: the spend was already counted the first time.
  if(seen!=='retry'&&!ledger.charge(verdict.spendLamports,t)){log({event:'signer-refused',reason:'hourly spending limit',lamports:verdict.spendLamports.toString()});return json(res,403,{error:'hourly spending limit reached'});}
  stamps.push(t);const signature=sign(null,bytes,privateKey);
  log({event:'signer-signed',operations:verdict.operations,spendLamports:verdict.spendLamports.toString(),operationId,version:message.version});
  return json(res,200,{signature:Buffer.from(signature).toString('base64'),publicKey:keypair.publicKey.toBase58()});
 }
 const server=http.createServer((req,res)=>{handle(req,res).catch(()=>json(res,500,{error:'signer error'}));});server.headersTimeout=5000;server.requestTimeout=10000;
 return {server,handle};
}
export function startSignerService(env=process.env){
 const file=env.KIDS_SIGNER_KEY_FILE,token=env.KIDS_SIGNER_TOKEN,programId=env.KIDS_SIGNER_PROGRAM_ID,[host='127.0.0.1',port='4176']=(env.KIDS_SIGNER_LISTEN||'').split(':').filter(Boolean).length?env.KIDS_SIGNER_LISTEN.split(':'):[];
 if(!file||!token||!programId)throw Error('KIDS_SIGNER_KEY_FILE, KIDS_SIGNER_TOKEN and KIDS_SIGNER_PROGRAM_ID are required');
 const bytes=Uint8Array.from(JSON.parse(readFileSync(file,'utf8')));const keypair=Keypair.fromSecretKey(bytes.slice());bytes.fill(0);
 const campaigns=(env.KIDS_SIGNER_CAMPAIGNS||'').split(',').map(v=>v.trim()).filter(Boolean),provisioning=env.KIDS_SIGNER_ALLOW_PROVISIONING==='1';
 const rpc=env.KIDS_SIGNER_RPC_URL?new Connection(env.KIDS_SIGNER_RPC_URL,'confirmed'):null;
 const resolveLookups=rpc?async lookups=>{const writable=[],readonly=[];for(const l of lookups){const t=(await rpc.getAddressLookupTable(l.accountKey)).value;if(!t)throw Error('table missing');for(const i of l.writableIndexes)writable.push(t.state.addresses[i].toBase58());for(const i of l.readonlyIndexes)readonly.push(t.state.addresses[i].toBase58());}return {writable,readonly};}:null;
 const limits={...DEFAULT_LIMITS,...(env.KIDS_SIGNER_MAX_HOURLY_LAMPORTS?{maxHourlyLamports:Number(env.KIDS_SIGNER_MAX_HOURLY_LAMPORTS)}:{})};
 const service=createSignerService({keypair,token,programId,campaigns:campaigns.length?campaigns:null,provisioning,resolveLookups,limits,log:line=>console.log(JSON.stringify(line))});
 service.server.listen(Number(port),host,()=>console.log(JSON.stringify({event:'signer-listening',host,port:Number(port),publicKey:keypair.publicKey.toBase58()})));
 return service;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href)startSignerService();
