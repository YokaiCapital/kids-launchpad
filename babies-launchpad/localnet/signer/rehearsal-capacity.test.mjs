import test from 'node:test';import assert from 'node:assert/strict';
import {DEFAULT_LIMITS} from '../signer-policy.mjs';import {rehearsalSignerCapacity,FLEET_REHEARSAL_GENESIS} from './rehearsal-capacity.mjs';
test('finite fleet signer experiment cannot enable through legacy or hosted composition',()=>{
 assert.deepEqual(rehearsalSignerCapacity(undefined,{programVersion:2}),{});
 for(const args of [{programVersion:2,rpcUrl:'http://127.0.0.1:19499'},{programVersion:3,rpcUrl:'https://api.mainnet-beta.solana.com'},{programVersion:3,rpcUrl:'http://127.0.0.1:19199'},{programVersion:3,rpcUrl:'https://127.0.0.1:19499'}])assert.throws(()=>rehearsalSignerCapacity('isolated-fleet-100',args));
 assert.throws(()=>rehearsalSignerCapacity('unlimited',{programVersion:3,rpcUrl:'http://127.0.0.1:19499'}));
 assert.throws(()=>rehearsalSignerCapacity('isolated-fleet-100',{programVersion:3,rpcUrl:'http://127.0.0.1:19499',genesisHash:'11111111111111111111111111111111'}));
 const p=rehearsalSignerCapacity('isolated-fleet-100',{programVersion:3,rpcUrl:'http://127.0.0.1:19499',genesisHash:FLEET_REHEARSAL_GENESIS});
 assert.equal(p.maxPerMinute,600);assert.equal(p.limits.maxHourlyLamports,5000000000);
 for(const k of Object.keys(DEFAULT_LIMITS))if(k!=='maxHourlyLamports')assert.equal(p.limits[k],DEFAULT_LIMITS[k]);
 assert.equal(DEFAULT_LIMITS.maxHourlyLamports,1000000000);
});
