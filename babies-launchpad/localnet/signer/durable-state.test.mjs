import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,rename,stat} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Keypair,TransactionInstruction,TransactionMessage} from '@solana/web3.js';
import {createSignerService} from '../signer-service.mjs';
test('durable retries cannot return a signature while the on-disk journal is unwritable',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kids-durable-signing-')),file=join(dir,'state.json'),backup=join(dir,'saved.json'),payer=Keypair.generate(),program=Keypair.generate().publicKey,campaign=Keypair.generate().publicKey,token='fixture-only-durable-signer-token-0000';let service;
 try{
  service=createSignerService({keypair:payer,token,programId:program,campaigns:[campaign],stateFile:file,durableState:true,requireOperationId:true});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const message=new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[new TransactionInstruction({programId:program,keys:[{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:payer.publicKey,isSigner:true,isWritable:true}],data:Buffer.from([4])})]}).compileToV0Message();
  const body={message:Buffer.from(message.serialize()).toString('base64'),operationId:'durable-fixture'};
  const post=()=>fetch('http://127.0.0.1:'+service.server.address().port+'/sign',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  const original=await post();assert.equal(original.status,200);const signed=await original.json();assert.equal((await stat(file)).mode&0o077,0);
  await rename(file,backup);await mkdir(file);
  for(let n=0;n<2;n++){const retry=await post();assert.equal(retry.status,500);assert.equal((await retry.json()).signature,undefined);}
  await rm(file,{recursive:true});await rename(backup,file);
  const recovered=await post();assert.equal(recovered.status,200);assert.equal((await recovered.json()).signature,signed.signature);
 }finally{if(service?.server.listening)await new Promise(r=>service.server.close(r));await rm(dir,{recursive:true,force:true});}
});
