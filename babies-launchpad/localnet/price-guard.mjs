// Reference-price guard for aggregator buybacks (release gate "oracle/MEV-safe parent buyback").
// Reads Pyth's on-chain sponsored price accounts through the keeper's own RPC (no Hermes key needed): the parent's
// USD feed when one exists and SOL/USD, both fresh and fully verified, and refuses a Jupiter quote whose implied
// price deviates from the reference by more than the allowed basis points or whose price impact is too high.
// A parent without a feed gets a smaller slice and the impact cap only; the evidence says so.
import {PublicKey} from '@solana/web3.js';
export const PYTH_PRICE_FEED_PROGRAM=new PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
export const PYTH_SOL_USD_FEED='ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
export const PRICE_GUARD={maxDeviationBps:300,maxImpactBps:50,maxAgeSeconds:60,maxConfidenceBps:200,noReferenceSliceLamports:100000000n};
const check=(ok,message)=>{if(!ok)throw Error(message);};
/** Address of a sponsored (shard 0) price account for a feed id. */
export const pythFeedAccount=(feedIdHex,shard=0)=>{const s=Buffer.alloc(2);s.writeUInt16LE(shard);return PublicKey.findProgramAddressSync([s,Buffer.from(feedIdHex,'hex')],PYTH_PRICE_FEED_PROGRAM)[0];};
/** Decodes a PriceUpdateV2 account: disc 8 | write_authority 32 | verification_level | PriceFeedMessage. */
export function decodePriceUpdate(data){
 check(Buffer.isBuffer(data)&&data.length>=100,'Price account too short');
 let o=40;const level=data[o];check(level===0||level===1,'Unknown verification level');o+=level===0?2:1;
 const feedId=data.subarray(o,o+32).toString('hex');o+=32;const price=data.readBigInt64LE(o);o+=8;const conf=data.readBigUInt64LE(o);o+=8;const expo=data.readInt32LE(o);o+=4;const publishTime=Number(data.readBigInt64LE(o));
 return {feedId,price,conf,expo,publishTime,fullyVerified:level===1};
}
export async function readPythPrice(connection,feedIdHex,{now=()=>Math.floor(Date.now()/1000),maxAgeSeconds=PRICE_GUARD.maxAgeSeconds}={}){
 const address=pythFeedAccount(feedIdHex),info=await connection.getAccountInfo(address,'confirmed');
 check(info,'Pyth price account absent: '+address.toBase58());const p=decodePriceUpdate(Buffer.from(info.data));
 check(p.feedId===feedIdHex,'Pyth account carries another feed');check(p.fullyVerified,'Pyth price is not fully verified');
 const age=now()-p.publishTime;check(age>=-5&&age<=maxAgeSeconds,'Pyth price is stale ('+age+' s)');check(p.price>0n,'Pyth price not positive');
 check(p.conf*10000n<=p.price*BigInt(PRICE_GUARD.maxConfidenceBps),'Pyth confidence interval too wide');
 return {...p,account:address.toBase58(),ageSeconds:age};
}
/** usd = price * 10^expo; returns a scaled bigint (1e12 units per USD) to stay in integers. */
const usdScaled=p=>{const scale=12+p.expo;return scale>=0?p.price*10n**BigInt(scale):p.price/10n**BigInt(-scale);};
/** The guard. `quote` = {outAmount, priceImpactPct}; `amountLamports` in; parentDecimals; `parentFeed` hex or null. */
export async function guardBuybackQuote(connection,{quote,amountLamports,parentDecimals,parentFeed,now}){
 const impactBps=Math.round(Number(quote.priceImpactPct??0)*10000);check(Number.isFinite(impactBps)&&impactBps>=0,'Quote has no price impact figure');
 check(impactBps<=PRICE_GUARD.maxImpactBps,'Quote price impact '+impactBps+' bps exceeds the cap');
 const out=BigInt(quote.outAmount),amount=BigInt(amountLamports);check(out>0n&&amount>0n,'Empty quote');
 if(!parentFeed){check(amount<=PRICE_GUARD.noReferenceSliceLamports,'Without a reference price the slice is capped at 0.1 SOL');return {referenceCheck:'none',impactBps,deviationBps:null,note:'parent has no Pyth feed; impact cap and reduced slice only'};}
 const [parent,sol]=await Promise.all([readPythPrice(connection,parentFeed,{now}),readPythPrice(connection,PYTH_SOL_USD_FEED,{now})]);
 // implied parent USD price from the quote: (amount SOL * SOL_USD) / (out parent tokens)
 const solUsd=usdScaled(sol),parentUsd=usdScaled(parent);
 const impliedScaled=amount*solUsd*10n**BigInt(parentDecimals)/(out*1000000000n);
 const deviationBps=Number((impliedScaled>parentUsd?impliedScaled-parentUsd:parentUsd-impliedScaled)*10000n/parentUsd);
 check(deviationBps<=PRICE_GUARD.maxDeviationBps,'Quote deviates '+deviationBps+' bps from the Pyth reference');
 return {referenceCheck:'pyth',impactBps,deviationBps,reference:{parentFeed,parentAccount:parent.account,parentAgeSeconds:parent.ageSeconds,solAccount:sol.account,solAgeSeconds:sol.ageSeconds}};
}
