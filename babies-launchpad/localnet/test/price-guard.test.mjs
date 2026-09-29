// FIXTURES ONLY: encoded Pyth accounts are built here; no network.
import test from 'node:test';import assert from 'node:assert/strict';import {PublicKey} from '@solana/web3.js';
import {pythFeedAccount,decodePriceUpdate,readPythPrice,guardBuybackQuote,PYTH_SOL_USD_FEED,PRICE_GUARD} from '../price-guard.mjs';
const FART='58cd29ef0e714c5affc44f269b2c1899a52da4169d7acc147b9da692e6953608';
function priceAccount(feed,{price,expo,conf=1n,publishTime,level=1}){const b=Buffer.alloc(134);b.fill(0);b[40]=level;let o=level===0?42:41;Buffer.from(feed,'hex').copy(b,o);o+=32;b.writeBigInt64LE(BigInt(price),o);o+=8;b.writeBigUInt64LE(BigInt(conf),o);o+=8;b.writeInt32LE(expo,o);o+=4;b.writeBigInt64LE(BigInt(publishTime),o);return b;}
const NOW=1_758_400_000;
function chain(accounts){return {async getAccountInfo(pk){const d=accounts[pk.toBase58()];return d?{data:d}:null;}};}
const fixture=({fartPrice=16776925,solPrice=11041500025,fartAge=10,solAge=10,fartConf=9384,level=1}={})=>chain({[pythFeedAccount(FART).toBase58()]:priceAccount(FART,{price:fartPrice,expo:-8,conf:fartConf,publishTime:NOW-fartAge,level}),[pythFeedAccount(PYTH_SOL_USD_FEED).toBase58()]:priceAccount(PYTH_SOL_USD_FEED,{price:solPrice,expo:-8,conf:1592065,publishTime:NOW-solAge})});
test('sponsored feed accounts derive as on mainnet and decode',()=>{
 assert.equal(pythFeedAccount(FART).toBase58(),'2t8eUbYKjidMs3uSeYM9jXM9uudYZwGkSeTB4TKjmvnC');assert.equal(pythFeedAccount(PYTH_SOL_USD_FEED).toBase58(),'7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE');
 const p=decodePriceUpdate(priceAccount(FART,{price:5,expo:-8,publishTime:NOW}));assert.equal(p.feedId,FART);assert.equal(p.price,5n);assert.equal(p.fullyVerified,true);
});
test('reference read refuses stale, partial, wide-confidence and foreign feeds',async()=>{
 const ok=await readPythPrice(fixture(),FART,{now:()=>NOW});assert.equal(ok.ageSeconds,10);
 await assert.rejects(readPythPrice(fixture({fartAge:120}),FART,{now:()=>NOW}),/stale/);
 await assert.rejects(readPythPrice(fixture({level:0}),FART,{now:()=>NOW}),/not fully verified/);
 await assert.rejects(readPythPrice(fixture({fartConf:16776925}),FART,{now:()=>NOW}),/confidence/);
 await assert.rejects(readPythPrice(chain({}),FART,{now:()=>NOW}),/absent/);
});
test('guard accepts a fair quote and refuses deviation, impact and oversize no-reference slices',async()=>{
 // 0.01 SOL at $110.415 = $1.10415; at $0.16776925 per Fartcoin that is ~6.5813 tokens = 6581300 raw (6 decimals)
 const fair=await guardBuybackQuote(fixture(),{quote:{outAmount:'6581300',priceImpactPct:'0.001'},amountLamports:10000000n,parentDecimals:6,parentFeed:FART,now:()=>NOW});
 assert.equal(fair.referenceCheck,'pyth');assert.ok(fair.deviationBps<=5,'deviation '+fair.deviationBps);assert.equal(fair.impactBps,10);
 await assert.rejects(guardBuybackQuote(fixture(),{quote:{outAmount:'6000000',priceImpactPct:'0.001'},amountLamports:10000000n,parentDecimals:6,parentFeed:FART,now:()=>NOW}),/deviates/);
 await assert.rejects(guardBuybackQuote(fixture(),{quote:{outAmount:'6581300',priceImpactPct:'0.02'},amountLamports:10000000n,parentDecimals:6,parentFeed:FART,now:()=>NOW}),/impact/);
 const none=await guardBuybackQuote(fixture(),{quote:{outAmount:'1',priceImpactPct:'0'},amountLamports:100000000n,parentDecimals:6,parentFeed:null,now:()=>NOW});assert.equal(none.referenceCheck,'none');
 await assert.rejects(guardBuybackQuote(fixture(),{quote:{outAmount:'1',priceImpactPct:'0'},amountLamports:100000001n,parentDecimals:6,parentFeed:null,now:()=>NOW}),/0.1 SOL/);
 assert.equal(PRICE_GUARD.maxDeviationBps,300);
});
