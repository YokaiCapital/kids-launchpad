import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {createRemoteSigner} from '../operator-signer.mjs';
import {classifyError} from '../jobs/runner.mjs';
test('a signer packet refusal (409 signer-packet-refused) is a permanent, typed worker failure; unresolved answers stay retryable',async()=>{
 const payer=Keypair.generate(),tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[]}).compileToV0Message());
 const answer=(status,body)=>async()=>({ok:false,status,json:async()=>body});
 const signer=fetchImpl=>createRemoteSigner({url:'http://127.0.0.1:1',token:'synthetic-token-for-refusal-mapping-tests',publicKey:payer.publicKey,fetchImpl});
 await assert.rejects(signer(answer(409,{error:'operating packet refused (commitment)',category:'signer-packet-refused'})).sign(tx,{operationId:'op',campaign:String(payer.publicKey),fencingToken:1}),e=>{assert.equal(e.code,'SIGNER_PACKET_REFUSED');assert.equal(e.status,409);assert.deepEqual(classifyError(e),{category:'signer-refused',transient:false});return true;});
 await assert.rejects(signer(answer(503,{error:'lookup resolution unresolved; retry the same operation',category:'signer-lookup-unresolved'})).sign(tx,{operationId:'op',campaign:String(payer.publicKey),fencingToken:1}),e=>{assert.equal(e.code,undefined);assert.equal(classifyError(e).transient,true);return true;});
 await assert.rejects(signer(answer(503,{error:'operating budget unavailable or packet unqualified'})).sign(tx,{operationId:'op'}),e=>{assert.equal(classifyError(e).transient,true);return true;});
});
