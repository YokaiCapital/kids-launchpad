import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,TransactionMessage,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {boundedRpcFetch} from '../rpc-transport.mjs';
import {createRemoteSigner} from '../operator-signer.mjs';
import {createAdmissionGuard,admittedConnection} from './admission.mjs';
import {setTimeout as pause} from 'node:timers/promises';
import {openRegistry} from '../registry/registry.mjs';
test('RPC and signer transports consult their pinned shared lane before external calls',async()=>{
 const registry=openRegistry({now:()=>10000});registry.migrate();let calls=0;
 try{
  const admit=createAdmissionGuard({registry,resource:'upstream-test',lane:'lifecycle',policy:{ratePerSecond:1,burst:1,lanes:{lifecycle:{ratePerSecond:1,burst:1}}}});
  const fetchImpl=async()=>{calls++;return {ok:true};};
  const rpc=boundedRpcFetch({fetchImpl,admit});await rpc('https://rpc.invalid');assert.equal(calls,1);
  await assert.rejects(rpc('https://rpc.invalid'),{code:'CAPACITY_WAIT'});assert.equal(calls,1);
  const payer=Keypair.generate(),target=Keypair.generate().publicKey;
  const signer=createRemoteSigner({url:'https://signer.invalid',token:'synthetic-admission-test-token-only'.padEnd(40,'x'),publicKey:payer.publicKey,fetchImpl,admit});
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:target.toBase58(),instructions:[SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:target,lamports:1})]}).compileToV0Message());
  await assert.rejects(signer.sign(tx),{code:'CAPACITY_WAIT'});assert.equal(calls,1,'the signing endpoint was never called');
  const aborted=AbortSignal.abort();await assert.rejects(rpc('https://rpc.invalid',{signal:aborted}),{name:'AbortError'});
 }finally{registry.close();}
});
test('SDK admission preserves method binding, refuses before a call, and transport aborts the actual request',async()=>{
 let charges=0,calls=0;const raw={value:7,async read(){calls++;return this.value;}};
 const connection=admittedConnection(raw,async()=>{if(++charges>1)throw Object.assign(Error('Busy'),{code:'CAPACITY_WAIT'});});
 assert.equal(await connection.read(),7);await assert.rejects(connection.read(),{code:'CAPACITY_WAIT'});assert.equal(calls,1);
 let signal;const fetch=boundedRpcFetch({timeoutMs:10,fetchImpl:async(_,init)=>{signal=init.signal;await pause(1000,null,{signal});return {};}});
 await assert.rejects(fetch('https://rpc.invalid'),{name:'AbortError'});assert.equal(signal.aborted,true);
});
