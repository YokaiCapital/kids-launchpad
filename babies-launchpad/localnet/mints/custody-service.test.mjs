// The private custody endpoint and the keeper worker's client, round trip over loopback HTTP with a scripted adapter: the exact
// request the adapter needs, a verified answer (same message, custody slots signed by the named mint and fee NFT, keeper slot
// empty), and every refusal typed: wrong token 401, malformed 400, deterministic refusal 409 (CUSTODY_REFUSED; a lease that is
// not current maps to STALE_LEASE), dependency 503 and rate limit 429 as transient dependencies, an answer that changed the
// message or carries a bad or keeper signature refused by the client. The service never logs the packet, keys or token.
import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair,PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {createCustodyService} from './custody-service.mjs';
import {createCustodyClient} from './custody-client.mjs';
import {classifyError} from '../jobs/runner.mjs';
const key=()=>Keypair.generate().publicKey;
function packet(keeper,mint,nft,program){
 const ix=new TransactionInstruction({programId:program,keys:[{pubkey:key(),isSigner:false,isWritable:true},{pubkey:keeper.publicKey,isSigner:true,isWritable:true},{pubkey:mint.publicKey,isSigner:true,isWritable:true},{pubkey:nft.publicKey,isSigner:true,isWritable:true}],data:Buffer.from([42,1])});
 return new VersionedTransaction(new TransactionMessage({payerKey:keeper.publicKey,recentBlockhash:String(key()),instructions:[ix]}).compileToV0Message());
}
test('custody endpoint and client: exact request, verified answer, typed refusals, no secrets in logs',async()=>{
 const keeper=Keypair.generate(),mint=Keypair.generate(),nft=Keypair.generate(),program=key(),campaign=String(key()),token='custody-'+'x'.repeat(40);
 const requests=[],logs=[];let mode='sign';
 const custody={async signLaunch(input){requests.push(input);
  if(mode==='dependency')throw Object.assign(Error('registry offline'),{dependency:'failure'});
  if(mode==='capacity')throw Object.assign(Error('Reserved upstream capacity is busy'),{code:'CAPACITY_WAIT'});
  if(mode==='stale')throw Object.assign(Error('Launch job lease is not current'),{code:'STALE_LEASE'});
  if(mode==='refuse')throw Error('Launch packet differs from its independently rebuilt template SENTINEL-9f3a');
  if(mode==='coded-transport')throw Object.assign(Error('read ECONNRESET SENTINEL-7c1e'),{code:'ECONNRESET'});
  if(mode==='coded-database')throw Object.assign(Error('terminating connection due to administrator command SENTINEL-2b8d'),{code:'57P01',dependency:'failure'});
  const tx=VersionedTransaction.deserialize(Buffer.from(input.packet,'base64'));
  if(mode==='other-message'){const other=packet(keeper,mint,nft,program);other.sign([mint,nft]);return {transactionBase64:Buffer.from(other.serialize()).toString('base64'),generation:0,messageSha256:'0'.repeat(64),step:'launch'};}
  if(mode==='keeper-signed'){tx.sign([keeper,mint,nft]);return {transactionBase64:Buffer.from(tx.serialize()).toString('base64'),generation:0,messageSha256:'0'.repeat(64),step:'launch'};}
  if(mode==='bad-signature'){tx.sign([mint,nft]);tx.signatures[2][0]^=1;return {transactionBase64:Buffer.from(tx.serialize()).toString('base64'),generation:0,messageSha256:'0'.repeat(64),step:'launch'};}
  tx.sign([mint,nft]);return {transactionBase64:Buffer.from(tx.serialize()).toString('base64'),generation:0,messageSha256:'a'.repeat(64),step:'launch'};
 }};
 const service=createCustodyService({custody,token,maxPerMinute:15,log:e=>logs.push(e)});
 const address=await service.listen(0);const url='http://127.0.0.1:'+address.port;
 try{
  const client=createCustodyClient({url,token});
  const ref={mint:mint.publicKey.toBase58(),feeNft:nft.publicKey.toBase58(),campaign,keeper:keeper.publicKey.toBase58(),operationId:'f'.repeat(64),attempt:1,lookups:[{table:String(key()),addresses:[String(key())]}],operationKey:'launch',fencingToken:3};
  const tx=packet(keeper,mint,nft,program),signed=await client.coSign(tx,ref);
  assert.deepEqual(requests[0],{mint:ref.mint,campaign,keeper:ref.keeper,packet:Buffer.from(tx.serialize()).toString('base64'),lookups:ref.lookups,packetRef:{operationId:ref.operationId,attempt:1},operationKey:'launch',fencingToken:3},'exactly what the adapter needs, nothing else');
  assert.ok(Buffer.from(signed.message.serialize()).equals(Buffer.from(tx.message.serialize())));assert.ok(signed.signatures[0].every(b=>b===0));assert.ok(signed.signatures[1].some(b=>b!==0)&&signed.signatures[2].some(b=>b!==0));
  assert.deepEqual(logs.map(l=>l.event),['custody-signed']);assert.equal(JSON.stringify(logs).includes(token),false);assert.equal(JSON.stringify(logs).includes(requests[0].packet),false);
  // Refusals.
  await assert.rejects(createCustodyClient({url,token:'wrong-'+'y'.repeat(40)}).coSign(tx,ref),e=>e.status===401&&e.code==='CUSTODY_UNAUTHORIZED');
  mode='refuse';await assert.rejects(client.coSign(tx,ref),e=>e.status===409&&e.code==='CUSTODY_REFUSED'&&e.category==='custody-refused'&&/packet-template/.test(e.message)&&!/SENTINEL/.test(e.message),'the answer carries the cause class, never the raw message');
  assert.equal(JSON.stringify(logs).includes('SENTINEL'),false,'the log carries the cause class, never the raw message');assert.equal(logs.at(-1).cause,'packet-template');
  // Transport and database failures that carry a code are dependencies (503, transient), never permanent refusals.
  mode='coded-transport';await assert.rejects(client.coSign(tx,ref),e=>e.status===503&&e.dependency==='failure'&&e.code===undefined&&!/SENTINEL/.test(e.message));
  assert.equal(classifyError(await client.coSign(tx,ref).catch(e=>e)).transient,true,'the runner retries a dependency answer');
  mode='coded-database';await assert.rejects(client.coSign(tx,ref),e=>e.status===503&&e.dependency==='failure');assert.equal(JSON.stringify(logs).includes('SENTINEL'),false);
  assert.equal(classifyError(Object.assign(Error('x'),{code:'CUSTODY_REFUSED'})).transient,false);
  mode='stale';await assert.rejects(client.coSign(tx,ref),e=>e.status===409&&e.code==='STALE_LEASE'&&e.category==='stale-fencing-token');
  mode='dependency';await assert.rejects(client.coSign(tx,ref),e=>e.status===503&&e.dependency==='failure'&&e.code===undefined);
  mode='capacity';await assert.rejects(client.coSign(tx,ref),e=>e.status===503&&e.dependency==='failure');
  mode='other-message';await assert.rejects(client.coSign(tx,ref),/another message/);
  mode='keeper-signed';await assert.rejects(client.coSign(tx,ref),/must not sign for the keeper/);
  mode='bad-signature';await assert.rejects(client.coSign(tx,ref),/invalid signature/);
  mode='sign';
  // The client refuses an incomplete reference before any request; the endpoint refuses malformed bodies and unknown routes.
  await assert.rejects(client.coSign(tx,{...ref,feeNft:undefined}),/needs feeNft/);await assert.rejects(client.coSign(tx,{...ref,fencingToken:null}),/fencing token/);
  const post=(body,auth='Bearer '+token,path='/custody/launch')=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',authorization:auth},body});
  assert.equal((await post('{')).status,400);assert.equal((await post(JSON.stringify({...requests[0],extra:1}))).status,400);assert.equal((await post(JSON.stringify({...requests[0],packetRef:{operationId:'x'}}))).status,400);
  assert.equal((await post('{}','Bearer nope')).status,401);assert.equal((await post('{}','Bearer '+token,'/sign')).status,404);assert.equal((await post('x'.repeat(9000))).status,413);
  assert.equal((await fetch(url+'/healthz')).status,200);
  // Rate limit: the fifteen authorized requests above used the minute; the next one is refused as a transient dependency.
  const before=requests.length;let limited=null;for(let i=0;i<8&&!limited;i++)try{await client.coSign(tx,ref);}catch(e){limited=e;}
  assert.ok(limited&&limited.status===429&&limited.dependency==='failure','rate limited as a dependency');assert.ok(requests.length-before<8);
  assert.throws(()=>createCustodyClient({url:'ftp://x',token}),/URL/);assert.throws(()=>createCustodyClient({url,token:'short'}),/32/);assert.throws(()=>createCustodyService({custody:{},token}),/adapter/);
 }finally{await service.close();}
});
