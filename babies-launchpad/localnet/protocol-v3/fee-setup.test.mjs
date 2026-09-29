import test from 'node:test';import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {feeSetupInstructions} from '../creation/operating-costs.mjs';
import {FEE_STATE_MAGIC,TOKEN_PROGRAM,WSOL} from '../protocol-v2/client.mjs';
import {createFeeSetupAdapter,feeSetupHandler} from './fee-setup.mjs';
const key=n=>new PublicKey(Buffer.alloc(32,n));
function fixture(){
 const id={programId:String(key(1)),genesisHash:String(key(2)),campaign:String(key(3))},payer=key(4),operator=key(5),terms={mode:0,treasury:payer,dev:key(6),childMint:key(7)};
 const state=Buffer.alloc(160);FEE_STATE_MAGIC.copy(state);key(3).toBuffer().copy(state,8);operator.toBuffer().copy(state,128);
 const instructions=feeSetupInstructions({...id,payer,operator,terms});
 const tokens=instructions.slice(0,-1).map(ix=>{const d=Buffer.alloc(165);ix.keys[3].pubkey.toBuffer().copy(d);ix.keys[2].pubkey.toBuffer().copy(d,32);d[108]=1;if(ix.keys[3].pubkey.equals(WSOL)){d.writeUInt32LE(1,109);d.writeBigUInt64LE(2039280n,113);}return {data:d,owner:TOKEN_PROGRAM,lamports:2039280,executable:false};});
 let rpcError=null,present=false,phase=3,slot=10,sent=0,lastSent=null,result={status:'confirmed',signature:'test'};
 const response={context:{slot:10},value:[{data:state,owner:key(1)},...tokens]};
 const chain={programId:key(1),keeper:payer,signatureStatus:async()=>({status:'confirmed'}),readCampaign:async()=>({phase,slot,terms}),async send(ixs,options){sent++;lastSent=ixs.length;assert.equal(options.computeUnits,400000);return result;}};
 const connection={async getMultipleAccountsInfoAndContext(_addresses,options){assert.equal(options.commitment,'finalized');if(rpcError)throw rpcError;return present?response:{context:{slot:10},value:response.value.map(()=>null)};}};
 const adapter=createFeeSetupAdapter({connection,chain,feeOperator:operator});
 return {id,adapter,state,tokens,response,terms,instructions,setRpcError:x=>{rpcError=x;},get sent(){return sent;},get lastSent(){return lastSent;},setPresent:x=>{present=x;},setPhase:x=>{phase=x;},setResult:x=>{result=x;},setSlot:x=>{slot=x;}};
}
test('setup waits for launch, uses one exact durable packet, and completes only on finalized custody',async()=>{
 const f=fixture();f.setPhase(0);assert.equal((await f.adapter.setup(f.id,{})).reason,'awaiting-live');assert.equal(f.sent,0);
 f.setPhase(3);assert.equal((await f.adapter.setup(f.id,{})).reason,'awaiting-finalized-setup');assert.equal(f.sent,1);assert.equal(f.lastSent,f.instructions.length,'the opening carries the four custody creates and the fee-state init');
 f.setPresent(true);const ready=await f.adapter.setup(f.id,{});assert.equal(ready.status,'ready');assert.equal(ready.accounts,4);assert.equal(f.sent,1);
 f.response.value[4]=null;assert.equal((await f.adapter.setup(f.id,{})).reason,'awaiting-finalized-setup');assert.equal(f.sent,2);assert.equal(f.lastSent,f.instructions.length-1,'a closed recipient account is repaired with the idempotent custody creates alone, never a second opening');
});
test('a cycle opened by someone else with another operator is accepted as ready for Standard campaigns',async()=>{
 const f=fixture();f.setPresent(true);key(9).toBuffer().copy(f.state,128);const ready=await f.adapter.setup(f.id,{});assert.equal(ready.status,'ready');assert.equal(ready.operator,String(key(9)));assert.equal(f.sent,0);
});
test('setup refuses altered accounts, ledger view and treasury before a new send',async()=>{
 for(const mutate of [f=>{f.tokens[0].data[108]=2;},f=>key(9).toBuffer().copy(f.tokens[1].data,32),f=>{f.response.context.slot=9;},f=>{f.terms.treasury=key(9);}]){
  const f=fixture();f.setPresent(true);mutate(f);await assert.rejects(f.adapter.setup(f.id,{}));assert.equal(f.sent,0);
 }
});
test('setup handler preserves unknown identities and yields for finality without seeding fee work',async()=>{
 const f=fixture(),handler=feeSetupHandler({adapter:f.adapter}),job={jobClass:'fee-setup',operationKey:'fee-setup'},ctx={campaign:f.id,token:1,fenced:async(_label,fn)=>fn(),enqueue:()=>{throw Error('Setup may not activate recurring jobs');}};
 f.setResult({status:'unknown',signature:'preserved',blockhash:String(key(8)),lastValidBlockHeight:100});const unknown=await handler.run(job,ctx);assert.equal(unknown.outcome,'unknown');assert.equal(unknown.reconcile.signature,'preserved');
 f.setResult({status:'confirmed',signature:'preserved'});assert.equal((await handler.run(job,ctx)).outcome,'yield');
 f.setPresent(true);assert.equal((await handler.run(job,ctx)).verified,true);
 assert.equal((await handler.run({...job,operationKey:'fee-harvest:0'},ctx)).outcome,'failed-permanent');
});

test('lagging finalized RPC waits without signing, failing setup or spending its retry budget',async()=>{
 const f=fixture();f.setRpcError(Object.assign(Error('Minimum context slot has not been reached'),{code:-32016}));
 const handler=feeSetupHandler({adapter:f.adapter});const result=await handler.run({jobClass:'fee-setup',operationKey:'fee-setup'},{campaign:f.id,token:1,fenced:async(_label,fn)=>fn()});
 assert.equal(result.outcome,'yield');assert.equal(result.category,'awaiting-finalized-setup');assert.equal(f.sent,0);
});
