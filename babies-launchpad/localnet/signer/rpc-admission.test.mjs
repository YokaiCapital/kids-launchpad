import test from 'node:test';
import assert from 'node:assert/strict';
import {createSignerRpcChannel} from './rpc-admission.mjs';

test('signer evidence reads share an explicit independent budget and preserve Connection binding',async()=>{
 const charged=[];let reads=0;
 const connection={value:42,async getAccountInfo(){assert.equal(this.value,42);reads++;return 'account';}};
 const registry={admission:{consume:async request=>{charged.push(request);return {allowed:true};}}};
 const a=createSignerRpcChannel({registry,connection,resource:'signer-rpc',ratePerSecond:30,burst:30});
 const b=createSignerRpcChannel({registry,connection,resource:'signer-rpc',ratePerSecond:30,burst:30});
 await Promise.all([a.connection.getAccountInfo(),b.connection.getAccountInfo()]);
 assert.equal(reads,2);assert.equal(charged.length,2);
 assert.ok(charged.every(x=>x.resource==='signer-rpc'&&x.lane==='signer'&&x.cost===1));
 assert.deepEqual(charged[0].policy,charged[1].policy);
});

test('signer admission refuses unbounded policy and cannot read through a busy shared budget',async()=>{
 let reads=0;
 const connection={async getBalance(){reads++;}};
 const registry={admission:{consume:async()=>({allowed:false,retryAfterMs:1000})}};
 assert.throws(()=>createSignerRpcChannel({registry,connection,resource:'signer-rpc'}),/Explicit bounded/);
 const channel=createSignerRpcChannel({registry,connection,resource:'signer-rpc',ratePerSecond:1,burst:1});
 await assert.rejects(channel.connection.getBalance(),e=>e.code==='CAPACITY_WAIT');
 assert.equal(reads,0);
});
