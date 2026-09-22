import test from 'node:test';import assert from 'node:assert/strict';import {Keypair,PublicKey,Transaction,TransactionInstruction,TransactionMessage,VersionedTransaction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {createSignerService} from '../signer-service.mjs';import {createRemoteSigner,createLocalSigner,toSigner,operatorSigner} from '../operator-signer.mjs';
const operator=Keypair.generate(),program=Keypair.generate().publicKey,token='t'.repeat(40),blockhash='EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k';
const launchIx=(payer)=>new TransactionInstruction({programId:program,keys:[{pubkey:payer,isSigner:true,isWritable:true}],data:Buffer.from([21])});
async function serve(opts={}){const logs=[];const s=createSignerService({keypair:operator,token,programId:program,log:l=>logs.push(l),...opts});await new Promise(r=>s.server.listen(0,'127.0.0.1',r));return {url:'http://127.0.0.1:'+s.server.address().port,close:()=>new Promise(r=>s.server.close(r)),logs};}
test('remote signer signs legacy and v0 operator transactions through the service and the signatures verify',async()=>{
 const svc=await serve();try{
  const signer=createRemoteSigner({url:svc.url,token,publicKey:operator.publicKey});
  const legacy=new Transaction({feePayer:operator.publicKey,blockhash,lastValidBlockHeight:1}).add(ComputeBudgetProgram.setComputeUnitLimit({units:200000}),launchIx(operator.publicKey));
  await signer.sign(legacy);assert.ok(legacy.verifySignatures(),'legacy signature verifies');
  const message=new TransactionMessage({payerKey:operator.publicKey,recentBlockhash:blockhash,instructions:[launchIx(operator.publicKey)]}).compileToV0Message([]);const v0=new VersionedTransaction(message);
  await signer.sign(v0);assert.equal(v0.signatures.length,1);assert.ok(!v0.signatures[0].every(b=>b===0));
  assert.ok(svc.logs.some(l=>l.event==='signer-signed'&&l.version===0));assert.ok(!JSON.stringify(svc.logs).includes(blockhash),'logs carry no message bytes');
 }finally{await svc.close();}
});
test('the service refuses a bad token, a foreign program, a wrong fee payer, malformed input and too many requests',async()=>{
 const svc=await serve({maxPerMinute:2});try{
  const post=(body,auth='Bearer '+token)=>fetch(svc.url+'/sign',{method:'POST',headers:{'content-type':'application/json',authorization:auth},body});
  const legacy=new Transaction({feePayer:operator.publicKey,blockhash,lastValidBlockHeight:1}).add(launchIx(operator.publicKey));const msg=legacy.serializeMessage().toString('base64');
  assert.equal((await post(JSON.stringify({message:msg}),'Bearer wrong'+'x'.repeat(35))).status,401);
  const other=Keypair.generate();const foreign=new Transaction({feePayer:operator.publicKey,blockhash,lastValidBlockHeight:1}).add(SystemProgram.transfer({fromPubkey:operator.publicKey,toPubkey:other.publicKey,lamports:1}));
  assert.equal((await post(JSON.stringify({message:foreign.serializeMessage().toString('base64')}))).status,403,'system transfer refused');
  const wrongPayer=new Transaction({feePayer:other.publicKey,blockhash,lastValidBlockHeight:1}).add(launchIx(other.publicKey));
  assert.equal((await post(JSON.stringify({message:wrongPayer.serializeMessage().toString('base64')}))).status,403,'wrong payer refused');
  assert.equal((await post('{"message":"zz"}')).status,400);assert.equal((await post('not json')).status,400);
  assert.equal((await post(JSON.stringify({message:msg}))).status,200);assert.equal((await post(JSON.stringify({message:msg}))).status,200);assert.equal((await post(JSON.stringify({message:msg}))).status,429,'third request within a minute is rate limited');
 }finally{await svc.close();}
});
test('the client refuses a tampered or foreign signature and needs proper configuration; local signer and toSigner behave',async()=>{
 const bad=createRemoteSigner({url:'http://127.0.0.1:1',token,publicKey:operator.publicKey,fetchImpl:async()=>({ok:true,json:async()=>({signature:Buffer.alloc(64,7).toString('base64')})})});
 const legacy=new Transaction({feePayer:operator.publicKey,blockhash,lastValidBlockHeight:1}).add(launchIx(operator.publicKey));
 await assert.rejects(bad.sign(legacy),/invalid signature/);
 const otherKey=Keypair.generate();const forged=createRemoteSigner({url:'http://127.0.0.1:1',token,publicKey:operator.publicKey,fetchImpl:async(u,init)=>{const m=Buffer.from(JSON.parse(init.body).message,'base64');const {sign}=await import('node:crypto');const {createPrivateKey}=await import('node:crypto');const pk=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(otherKey.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});return {ok:true,json:async()=>({signature:Buffer.from(sign(null,m,pk)).toString('base64')})};}});
 await assert.rejects(forged.sign(legacy),/invalid signature/,'a signature by another key is refused');
 assert.throws(()=>createRemoteSigner({url:'ftp://x',token,publicKey:operator.publicKey}),/URL/);assert.throws(()=>createRemoteSigner({url:'http://x',token:'short',publicKey:operator.publicKey}),/32/);
 await assert.rejects(operatorSigner({KIDS_SIGNER_URL:'http://x'}),/KIDS_SIGNER_TOKEN/);
 const local=toSigner(operator);assert.equal(local.kind,'local');await local.sign(legacy);assert.ok(legacy.verifySignatures());assert.equal(toSigner(local),local);
});
