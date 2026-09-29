import {FEE_DISTRIBUTION} from '../../localnet/fee-distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSettings} from '../server/admin-plugin.mjs';
import {generateKeypair} from '../../shared/solana.mjs';
const config=()=>({network:'localnet',rpcUrl:'http://127.0.0.1:18999',admin:generateKeypair().address,mints:Object.fromEntries(['KIDS','SHART','FARTCOIN','BUTTCOIN'].map(k=>[k,generateKeypair().address])),launch:{poolUsd:200000,solUsd:200,parentShareBps:1000,holderMinimumBps:5,commitmentsOpen:false}});
test('operator settings preserve economics and reject switching chains or opening absent escrow',()=>{
 const c=config();assert.equal(validateSettings(c).launch.capLamports,'500000000000');assert.equal(validateSettings({...c,launch:{...c.launch,solUsd:100}}).launch.capLamports,'1000000000000');assert.throws(()=>validateSettings({...c,network:'mainnet-beta'}),/isolated localnet/);assert.throws(()=>validateSettings({...c,launch:{...c.launch,commitmentsOpen:true}}),/escrow/);assert.throws(()=>validateSettings({...c,launch:{...c.launch,holderMinimumBps:25}}),/0.05%/);assert.throws(()=>validateSettings({...c,mints:{...c.mints,SHART:c.mints.KIDS}}),/distinct/);
});

test('2% policy persists and rejects incompatible launch terms',()=>{
 const c=validateSettings(config());
 assert.equal(c.launch.pool.tradeFeeBps,200);
 assert.equal(c.launch.pool.localnetConfigAddress,null);
 assert.deepEqual(c.launch.pool.revenueSplit,FEE_DISTRIBUTION);
 assert.equal(c.launch.prelaunchShareBps+c.launch.liquidityShareBps+c.launch.parentShareBps+c.launch.devShareBps,10000);
 assert.deepEqual(validateSettings(c),c);
 for(const change of [{tradeFeeBps:25},{creatorFeeEnabled:true},{liquidityPolicy:'burn'},{tokenTransferFeeBps:200}])
  assert.throws(()=>validateSettings({...c,launch:{...c.launch,pool:{...c.launch.pool,...change}}}),/2% pool policy/);
 assert.throws(()=>validateSettings({...c,launch:{...c.launch,prelaunchShareBps:5500}}),/43.5%/);
 assert.throws(()=>validateSettings({...c,launch:{...c.launch,revokeMintAuthority:false}}),/revoked/);
});

test('dev unlock is measured against total supply and cannot exceed the agreed schedule',()=>{
 const c=validateSettings(config());
 assert.equal(c.launch.devUnlockBps,100);
 assert.equal(c.launch.devVestedBps,200);
 assert.equal(c.launch.devUnlockBps+c.launch.devVestedBps,c.launch.devShareBps);
 assert.equal(c.launch.devVestingMonths,3);
 assert.equal(c.launch.devCliffSeconds,0);
 for(const change of [{devUnlockBps:300},{devVestedBps:300},{devVestingMonths:12},{devCliffSeconds:1}])
  assert.throws(()=>validateSettings({...c,launch:{...c.launch,...change}}),/Dev allocation/);
});
