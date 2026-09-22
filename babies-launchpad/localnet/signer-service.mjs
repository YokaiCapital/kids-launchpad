// Operator signing service: holds the operator key, signs only transaction messages that (1) carry a valid bearer
// token, (2) are paid by the operator key, (3) invoke nothing but the KIDS launch program and a short allowlist of
// system programs, within a per-minute budget. It never sees or moves funds itself; it logs sanitized facts only.
// Run it as its own service on a private network (Railway: separate service, key file on its own volume).
import http from 'node:http';import {readFileSync} from 'node:fs';import {createPrivateKey,sign,timingSafeEqual} from 'node:crypto';
import {Keypair,PublicKey,VersionedMessage} from '@solana/web3.js';
export const DEFAULT_ALLOWED_PROGRAMS=['ComputeBudget111111111111111111111111111111','ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb','AddressLookupTab1e1111111111111111111111111'];
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
export function createSignerService({keypair,token,programId,allowedPrograms=DEFAULT_ALLOWED_PROGRAMS,maxPerMinute=60,maxBodyBytes=8192,log=()=>{},now=Date.now}){
 if(!(keypair instanceof Keypair))throw Error('Signer service needs the operator keypair');if(typeof token!=='string'||token.length<32)throw Error('Signer token must be at least 32 characters');
 const program=new PublicKey(programId).toBase58(),allowed=new Set([program,...allowedPrograms.map(p=>new PublicKey(p).toBase58())]);
 const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(keypair.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});
 const expected=Buffer.from(token);const stamps=[];
 const authorized=header=>{const value=Buffer.from(String(header||'').replace(/^Bearer\s+/i,''));return value.length===expected.length&&timingSafeEqual(value,expected);};
 async function handle(req,res){
  if(req.method==='GET'&&req.url==='/healthz')return json(res,200,{status:'ok',publicKey:keypair.publicKey.toBase58()});
  if(req.method!=='POST'||req.url!=='/sign')return json(res,404,{error:'not found'});
  if(!authorized(req.headers.authorization)){log({event:'signer-unauthorized'});return json(res,401,{error:'unauthorized'});}
  const t=now();while(stamps.length&&t-stamps[0]>60000)stamps.shift();if(stamps.length>=maxPerMinute){log({event:'signer-rate-limited'});return json(res,429,{error:'rate limited'});}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>maxBodyBytes)return json(res,413,{error:'too large'});}
  let message;try{message=VersionedMessage.deserialize(Buffer.from(JSON.parse(body).message,'base64'));}catch{return json(res,400,{error:'malformed message'});}
  const keys=message.staticAccountKeys.map(k=>k.toBase58());
  if(keys[0]!==keypair.publicKey.toBase58())return json(res,403,{error:'fee payer is not the operator'});
  const programs=message.compiledInstructions.map(ix=>keys[ix.programIdIndex]);
  const foreign=programs.filter(p=>!allowed.has(p));if(foreign.length){log({event:'signer-refused-program',programs:foreign.map(p=>p.slice(0,8))});return json(res,403,{error:'program not allowed'});}
  if(!programs.includes(program)&&!programs.every(p=>p==='AddressLookupTab1e1111111111111111111111111'||p==='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'||p==='ComputeBudget111111111111111111111111111111'))return json(res,403,{error:'transaction does not invoke the launch program'});
  stamps.push(t);const bytes=Buffer.from(message.serialize());const signature=sign(null,bytes,privateKey);
  log({event:'signer-signed',instructions:programs.length,programs:[...new Set(programs)].map(p=>p.slice(0,8)),version:message.version});
  return json(res,200,{signature:Buffer.from(signature).toString('base64'),publicKey:keypair.publicKey.toBase58()});
 }
 const server=http.createServer((req,res)=>{handle(req,res).catch(()=>json(res,500,{error:'signer error'}));});server.headersTimeout=5000;server.requestTimeout=10000;
 return {server,handle};
}
export function startSignerService(env=process.env){
 const file=env.KIDS_SIGNER_KEY_FILE,token=env.KIDS_SIGNER_TOKEN,programId=env.KIDS_SIGNER_PROGRAM_ID,[host='127.0.0.1',port='4176']=(env.KIDS_SIGNER_LISTEN||'').split(':').filter(Boolean).length?env.KIDS_SIGNER_LISTEN.split(':'):[];
 if(!file||!token||!programId)throw Error('KIDS_SIGNER_KEY_FILE, KIDS_SIGNER_TOKEN and KIDS_SIGNER_PROGRAM_ID are required');
 const bytes=Uint8Array.from(JSON.parse(readFileSync(file,'utf8')));const keypair=Keypair.fromSecretKey(bytes.slice());bytes.fill(0);
 const service=createSignerService({keypair,token,programId,log:line=>console.log(JSON.stringify(line))});
 service.server.listen(Number(port),host,()=>console.log(JSON.stringify({event:'signer-listening',host,port:Number(port),publicKey:keypair.publicKey.toBase58()})));
 return service;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href)startSignerService();
