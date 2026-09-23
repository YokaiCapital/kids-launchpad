// Regression (auditor, 23 Sep 2026): after the 2.5 % tier became the default for new pools, every pool lookup derived the
// address from the network constant, so the live 2 % pool (FAThun8y…, campaign 8LmwBAa5…) stopped resolving on mainnet:
// coin page, trades and the fee keeper all failed with "Launch pool is not canonical". Lookups now follow the campaign's
// recorded pool and accept whichever approved tier produced it.
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {Keypair,PublicKey} from '@solana/web3.js';import {NATIVE_MINT,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {poolAddresses,decodePool,decodeConfig} from '../cpmm.mjs';
import {CPMM,AMM_CONFIG,AMM_TIERS,PARENT_AMM_CONFIG,campaignPoolAddresses,checkPoolPolicy,approvedTier} from '../atomic-launch.mjs';
import {createCampaignResolver} from '../postlaunch-campaign.mjs';
import {collectFeesInstruction,convertFeesInstruction} from '../atomic-fees.mjs';
const pk=()=>Keypair.generate().publicKey;
const TWO=AMM_TIERS[0],TWO_HALF=AMM_TIERS[1];
function configAccount(tier,{trade=tier.trade,index=tier.index}={}){const c=Buffer.alloc(236);createHash('sha256').update('account:AmmConfig').digest().copy(c,0,0,8);c.writeUInt16LE(index,10);c.writeBigUInt64LE(trade,12);c.writeBigUInt64LE(120000n,20);c.writeBigUInt64LE(40000n,28);return c;}
function poolAccount(tier,p,creator){const d=Buffer.alloc(637);createHash('sha256').update('account:PoolState').digest().copy(d,0,0,8);[tier.key,creator,p.vault0,p.vault1,p.lpMint,p.mint0,p.mint1,TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,p.observation].forEach((k,i)=>k.toBuffer().copy(d,8+i*32));return d;}
function fixture(tier){
 const programId=pk(),address=pk(),mint=pk(),creator=pk(),dev=pk(),treasury=pk(),p=poolAddresses(CPMM,tier.key,mint,NATIVE_MINT);
 const state={phase:3,mint,pool:p.pool,creator,dev,treasury,soft:100000000000n,hard:500000000000n,supply:1000000000000000n,deadline:100,launchDeadline:86500};
 const record={ready:true,network:'localnet',rpcUrl:'http://127.0.0.1:19099',address:address.toBase58(),campaign:address.toBase58(),mint:mint.toBase58(),pool:p.pool.toBase58(),creator:creator.toBase58(),dev:dev.toBase58(),treasury:treasury.toBase58(),soft:state.soft.toString(),hard:state.hard.toString(),supply:state.supply.toString(),deadline:100,launchDeadline:86500,programId:programId.toBase58(),programSha256:'hash',genesisHash:'genesis',launchSignature:'receipt'};
 const requested=[];
 const ctx={programId,manifest:{sha256:'hash',genesisHash:'genesis'},connection:{getMultipleAccountsInfo:async keys=>{requested.push(keys.map(k=>k.toBase58()));return [{owner:CPMM,data:poolAccount(tier,p,creator)},{owner:CPMM,data:configAccount(tier)}];},getSignatureStatuses:async()=>({value:[{confirmationStatus:'confirmed',err:null}]})}};
 return {ctx,state,record,p,requested};
}
test('the recorded pool decides the tier: a 2 % pool resolves while new pools default to another tier',async()=>{
 const other=AMM_TIERS.find(t=>!t.key.equals(AMM_CONFIG));
 for(const tier of [TWO,TWO_HALF]){
  const f=fixture(tier),resolver=createCampaignResolver({context:async()=>f.ctx,readState:async()=>f.state,has:()=>true,readRecord:()=>f.record});
  const selected=await resolver.resolve('active');assert.equal(selected.campaign.toBase58(),f.record.address,'tier '+tier.tradeFeeBps);
  assert.deepEqual(f.requested[0],[f.p.pool.toBase58(),tier.key.toBase58()],'the pool\'s own config account is read, not the network default');
 }
 assert.ok(other,'two tiers are approved');
});
test('campaignPoolAddresses derives from whichever tier produced the pool and refuses foreign pools',()=>{
 const mint=pk();
 for(const tier of AMM_TIERS){const p=poolAddresses(CPMM,tier.key,mint,NATIVE_MINT),found=campaignPoolAddresses(mint,p.pool);assert.ok(found.config.equals(tier.key));assert.equal(found.tier.tradeFeeBps,tier.tradeFeeBps);assert.ok(found.vault0.equals(p.vault0));}
 assert.throws(()=>campaignPoolAddresses(mint,pk()),/not canonical/);
});
test('pool policy binds the config account to its tier (index and rate) and refuses creator fees',()=>{
 const mint=pk(),p=poolAddresses(CPMM,TWO_HALF.key,mint,NATIVE_MINT),pool=decodePool({owner:CPMM,data:poolAccount(TWO_HALF,p,pk())},CPMM,p);
 assert.equal(checkPoolPolicy(pool,decodeConfig({owner:CPMM,data:configAccount(TWO_HALF)},CPMM),TWO_HALF.key).tradeFeeBps,250);
 assert.throws(()=>checkPoolPolicy(pool,decodeConfig({owner:CPMM,data:configAccount(TWO_HALF,{trade:20000n})},CPMM),TWO_HALF.key),/policy/);
 assert.throws(()=>checkPoolPolicy(pool,decodeConfig({owner:CPMM,data:configAccount(TWO_HALF,{index:2})},CPMM),TWO_HALF.key),/policy/);
 assert.throws(()=>checkPoolPolicy(pool,decodeConfig({owner:CPMM,data:configAccount(TWO)},CPMM),TWO.key),/policy/,'pool recorded on another config');
 assert.equal(approvedTier(pk()),null);assert.ok(PARENT_AMM_CONFIG.equals(TWO.key),'parent pools stay on the 2 % tier');
});
test('fee instructions carry the pool\'s own config account',()=>{
 const ctx={programId:pk()},campaign=pk(),keeper=pk(),mint=pk();
 for(const tier of AMM_TIERS){
  const p=poolAddresses(CPMM,tier.key,mint,NATIVE_MINT);
  const collect=collectFeesInstruction(ctx,campaign,keeper,mint,pk(),1n,p.pool);assert.ok(collect.keys.some(k=>k.pubkey.equals(p.pool)));
  const convert=convertFeesInstruction(ctx,campaign,keeper,mint,5n,1n,10n,p.pool);assert.ok(convert.keys.some(k=>k.pubkey.equals(tier.key)),'config '+tier.tradeFeeBps);assert.ok(convert.keys.some(k=>k.pubkey.equals(p.pool)));
 }
 assert.throws(()=>convertFeesInstruction(ctx,campaign,keeper,mint,5n,1n,10n),/campaign pool/);
});
