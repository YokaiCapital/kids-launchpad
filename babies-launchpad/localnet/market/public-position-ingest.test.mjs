import test from 'node:test';import assert from 'node:assert/strict';import {PublicKey} from '@solana/web3.js';
import {createPositionIndexHandler} from './public-position-ingest.mjs';import * as client from '../protocol-v2/client.mjs';
import {readFileSync} from 'node:fs';import {encodeTerms,termsHash,OFFSETS} from '../protocol-v2/policy.mjs';
const key=n=>new PublicKey(Buffer.alloc(32,n));
function fixture(){
 const program=key(2),genesis=key(3),creator=key(4),owner=key(5),vector=JSON.parse(readFileSync(new URL('../protocol-v2/test-vectors.json',import.meta.url))).termsHash.find(v=>v.name==='standard');
 const t={...vector.terms,genesis:client.keyHex(genesis),creator:client.keyHex(creator)},campaign=client.campaignAddress(program,creator,t.nonce),bytes=Buffer.alloc(client.CAMPAIGN_LEN);client.CAMPAIGN_MAGIC.copy(bytes);encodeTerms(t).copy(bytes,8);termsHash(bytes.subarray(8,808)).copy(bytes,808);bytes.writeBigUInt64LE(1n,OFFSETS.receiptCount);
 const clock=Buffer.alloc(40);clock.writeBigInt64LE(1790000000n,32);const rb=Buffer.alloc(client.RECEIPT_LEN);client.RECEIPT_MAGIC.copy(rb);campaign.toBuffer().copy(rb,8);owner.toBuffer().copy(rb,40);rb.writeBigUInt64LE(100n,72);
 const account=(data,owner)=>({owner:String(owner),executable:false,data:[data.toString('base64'),'base64']}),id={genesisHash:String(genesis),programId:String(program),campaign:String(campaign)},calls=[],commits=[];
 const state={previous:{revision:0,body:null},entries:[{pubkey:String(client.receiptAddress(program,campaign,owner)),account:account(rb,program)}],slot:100,changed:false};
 const rpc={async call(method,params){calls.push(method);assert.equal(params.at(-1).commitment,'finalized');if(method==='getProgramAccounts')return {context:{slot:100},value:state.entries};if(state.changed&&calls.length>1)bytes.writeBigUInt64LE(2n,OFFSETS.receiptCount);return {context:{slot:state.slot},value:[account(bytes,program),account(clock,'Sysvar1111111111111111111111111111111111111')]};}};
 const store={snapshot:async()=>state.previous,commit:async x=>commits.push(x)},handler=createPositionIndexHandler({store,rpc,...id,programVersion:3}),ctx={campaign:id,now:()=>1790000000000,fenced:async(_,fn)=>fn()},job={...id,jobClass:'position-index',operationKey:'positions:0'};
 return {state,handler,ctx,job,calls,commits,rb,bytes,clock,owner,program,account};
}
test('enumerates finalized receipts once then refreshes quiet membership without scanning again',async()=>{
 const f=fixture();assert.equal((await f.handler.run(f.job,f.ctx)).outcome,'done');assert.deepEqual(f.calls,['getMultipleAccounts','getProgramAccounts','getMultipleAccounts']);assert.equal(f.commits[0].receipts[0].owner,String(f.owner));
 f.state.previous={revision:1,body:f.commits[0].body};f.calls.length=0;await f.handler.run({...f.job,operationKey:'positions:1'},f.ctx);assert.deepEqual(f.calls,['getMultipleAccounts']);assert.equal(f.commits[1].receipts,null);
});
test('truncated, duplicate, wrong-program and wrong-PDA receipts do not create false coverage',async()=>{
 for(const mutate of [f=>f.state.entries=[],f=>f.state.entries.push(f.state.entries[0]),f=>f.state.entries[0].account.owner=String(key(9)),f=>f.state.entries[0].pubkey=String(key(9)),f=>{f.rb.writeBigUInt64LE(0n,72);f.state.entries[0].account=f.account(f.rb,f.program);},f=>f.state.changed=true]){
  const f=fixture();mutate(f);await assert.rejects(f.handler.run(f.job,f.ctx));assert.equal(f.commits.length,0);
 }
});
test('wrong ledger, stale observations, backwards contexts and out-of-order jobs fail closed',async()=>{
 for(const mutate of [f=>f.ctx.campaign={...f.ctx.campaign,genesisHash:String(key(9))},f=>f.clock.writeBigInt64LE(1789999000n,32),f=>{f.state.previous={revision:1,body:{sequence:'0',slot:101,count:1}};f.job.operationKey='positions:1';},f=>f.job.operationKey='positions:2']){const f=fixture();mutate(f);await assert.rejects(f.handler.run(f.job,f.ctx));assert.equal(f.commits.length,0);}
 const f=fixture();f.state.previous={revision:1,body:{sequence:'0'}};assert.equal((await f.handler.run(f.job,f.ctx)).replayed,true);assert.equal(f.calls.length,0);
});
