// Decoder gates (KIDS market plan, sections 3 and 5): real mainnet fixtures of pool FAThun8y (public data, see
// fixtures/market/README.md) plus synthetic cases for multi-swap, other-pool, forged-program and ambiguous shapes.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeSwaps,priceScaled,formatScaled,scaledToNumber,CPMM_PROGRAM,WSOL_MINT,SUPPORTED_VERSIONS} from '../market/decode.mjs';
const fixture=name=>JSON.parse(readFileSync(new URL('./fixtures/market/'+name+'.json',import.meta.url),'utf8'));
const POOL=fixture('pool');// canonical identity derived with campaignPoolAddresses(mint,pool) from atomic-launch.mjs
const SWAP_BASE_INPUT_DATA='E73fXHPWvSQzYizrDxkL5REbZSMncAuZy';// base58 of [143,190,90,218,196,30,51,222] + 16 zero bytes

test('price is exact integer maths: SOL per whole coin scaled by 1e18',()=>{
 // 20000 lamports for 3632.394060 coins = 0.00002 / 3632.39406 SOL per coin
 assert.equal(priceScaled('20000','3632394060',6),'5506010545');
 assert.equal(formatScaled('5506010545'),'0.000000005506010545');
 assert.equal(scaledToNumber('5506010545'),5.506010545e-9);
 assert.equal(priceScaled('1000000000','1000000',6),'1000000000000000000','1 SOL for 1 coin = 1');
 assert.equal(formatScaled('1000000000000000000'),'1');
 assert.equal(priceScaled('1','0',6),null,'zero coin amount cannot be priced');
});

test('fixture: a direct swap_base_input buy by an ordinary wallet decodes to one buy with exact amounts',()=>{
 const r=decodeSwaps(fixture('swap-direct-buy'),POOL);
 assert.equal(r.failed,false);assert.equal(r.skipped.length,0);assert.equal(r.swaps.length,1);
 const s=r.swaps[0];
 assert.equal(s.signature,'e93Xu1rk8qpQ4ppXiZxLfFavhp7T13HvedPHf19kJ8K3VvfXqij4dzCjrhnujsJSfUqZvxGHjZRW1GzVXiweUXm');
 assert.equal(s.slot,449563079);assert.equal(s.blockTime,1790129330);assert.equal(s.instructionPath,'4');
 assert.equal(s.nested,false);assert.equal(s.outerProgram,null);assert.equal(s.kind,'swap_base_input');
 assert.equal(s.trader,'AXA2k9FKgTyUaaQSAvB7qVHUsnRJJST2rsmF6EFDZBHZ');
 assert.equal(s.side,'buy');assert.equal(s.inputMint,WSOL_MINT);assert.equal(s.inputAmount,'20000');
 assert.equal(s.outputMint,POOL.mint1);assert.equal(s.outputAmount,'3632394060');
 assert.equal(s.solLamports,'20000');assert.equal(s.coinRaw,'3632394060');assert.equal(s.coinDecimals,6);
 assert.equal(s.priceScaled,'5506010545');assert.equal(s.priceSol,5.506010545e-9);
 // cross-check against the transaction's own vault balance changes
 const tx=fixture('swap-direct-buy'),pre=tx.meta.preTokenBalances,post=tx.meta.postTokenBalances;
 const delta=i=>BigInt(post.find(b=>b.accountIndex===i).uiTokenAmount.amount)-BigInt(pre.find(b=>b.accountIndex===i).uiTokenAmount.amount);
 assert.equal(delta(3),20000n,'SOL vault gained the input');assert.equal(delta(4),-3632394060n,'coin vault paid the output');
});

test('fixture: swap_base_input nested under an aggregator route (v0 transaction) decodes as one nested sell; the other leg on another pool is ignored',()=>{
 const r=decodeSwaps(fixture('swap-nested-sell-router'),POOL);
 assert.equal(r.failed,false);assert.deepEqual(r.skipped,[]);assert.equal(r.swaps.length,1);assert.equal(r.version,0);
 const s=r.swaps[0];
 assert.equal(s.signature,'42ESxoknLNLRz3UubYeiRZ77DNjtHYhMKzpfxihZK2nww6ufNfVdYwRF4TU6eHBUszrAtF5HfuFCwdVCjaYc5hks');
 assert.equal(s.instructionPath,'0.0');assert.equal(s.nested,true);assert.equal(s.outerProgram,'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS');
 assert.equal(s.side,'sell');assert.equal(s.trader,'ProCXqRcXJjoUd1RNoo28bSizAA6EEqt9wURZYPDc5u');
 assert.equal(s.inputAmount,'1383367409292');assert.equal(s.outputAmount,'1679349');
 assert.equal(s.solLamports,'1679349');assert.equal(s.coinRaw,'1383367409292');
 assert.equal(s.priceScaled,'1213957325');assert.equal(formatScaled(s.priceScaled),'0.000000001213957325');
});

test('fixture: the fee-fund wallet selling through the router decodes as one nested sell (5404 lamports for 4459.366261 coins)',()=>{
 const r=decodeSwaps(fixture('swap-nested-sell-fund'),POOL);
 assert.equal(r.swaps.length,1);assert.deepEqual(r.skipped,[]);
 const s=r.swaps[0];
 assert.equal(s.side,'sell');assert.equal(s.nested,true);assert.equal(s.instructionPath,'0.0');
 assert.equal(s.solLamports,'5404');assert.equal(s.coinRaw,'4459366261');assert.equal(s.priceScaled,'1211831386');
 assert.equal(s.trader,'FUNDduJTA7XcckKHKfAoEnnhuSud2JUCUZv6opWEjrBU');
});

test('fixture: a version 1 transaction (router FLASHX8, nested swap_base_input) decodes as one nested sell; versions above the verified set are refused as unsupported',()=>{
 const tx=fixture('swap-nested-sell-v1');assert.equal(tx.version,1);assert.ok('transactionConfig' in tx.transaction.message,'v1 carries transactionConfig instead of addressTableLookups');
 const r=decodeSwaps(tx,POOL);assert.equal(r.unsupported,false);assert.deepEqual(r.skipped,[]);assert.equal(r.swaps.length,1);
 const s=r.swaps[0];assert.equal(s.signature,'hY5B6iKC82HzR4kwBxwASUabREckCmNGxpBFhkYvhj3EJfNunnxccCYWLfCB98jhDoQcGex3jZam8LVH1qYX68e');
 assert.equal(s.slot,449589012);assert.equal(s.blockTime,1790136198);assert.equal(s.instructionPath,'1.0');assert.equal(s.nested,true);assert.equal(s.outerProgram,'FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9');
 assert.equal(s.side,'sell');assert.equal(s.trader,'2X3EarLXkRwQ1FCGVcSoCRpNipFQ3fBiRNKM7K9PT6Rv');assert.equal(s.coinRaw,'74992737749797');assert.equal(s.solLamports,'96461003');
 assert.equal(s.priceScaled,priceScaled('96461003','74992737749797',6));assert.match(formatScaled(s.priceScaled),/^0\.00000000128/);
 assert.deepEqual([...SUPPORTED_VERSIONS],['legacy',0,1]);
 const v2=decodeSwaps({...tx,version:2},POOL);assert.equal(v2.unsupported,true);assert.deepEqual(v2.swaps,[]);assert.match(v2.skipped[0].reason,/unsupported transaction version 2/);
});
test('fixture: keeper fee collection (CollectCpFees -> CPMM withdraw) is never a trade',()=>{
 const r=decodeSwaps(fixture('fee-collect-withdraw'),POOL);
 assert.equal(r.failed,false);assert.deepEqual(r.swaps,[]);assert.deepEqual(r.skipped,[]);
});
test('fixture: Raydium collect_fund_fee (both vaults pay out, no swap) is never a trade',()=>{
 const r=decodeSwaps(fixture('collect-fund-fee'),POOL);assert.deepEqual(r.swaps,[]);assert.deepEqual(r.skipped,[]);
});
test('fixture: the launch (CPMM initialize nested under the KIDS program, plus the lock) is never a trade',()=>{
 const r=decodeSwaps(fixture('launch-initialize'),POOL);assert.deepEqual(r.swaps,[]);assert.deepEqual(r.skipped,[]);
});
test('fixture: a failed swap transaction is excluded and reported as failed',()=>{
 const r=decodeSwaps(fixture('swap-failed'),POOL);assert.equal(r.failed,true);assert.deepEqual(r.swaps,[]);
});
test('a null RPC response is "no transaction", never an empty success',()=>{
 const r=decodeSwaps(null,POOL);assert.equal(r.failed,false);assert.deepEqual(r.swaps,[]);assert.equal(r.skipped[0].reason,'no transaction');
});
test('an incomplete pool identity is refused before any decoding',()=>{
 assert.throws(()=>decodeSwaps(fixture('swap-direct-buy'),{...POOL,vault1:undefined}),/incomplete: vault1/);
 assert.throws(()=>decodeSwaps(fixture('swap-direct-buy'),{...POOL,decimals1:'6'}),/incomplete: decimals1/);
});

// ---- synthetic shapes built from the real buy ----
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function swapIx(pool=POOL.pool,payer='AXA2k9FKgTyUaaQSAvB7qVHUsnRJJST2rsmF6EFDZBHZ'){return {programId:CPMM_PROGRAM,data:SWAP_BASE_INPUT_DATA,accounts:[payer,POOL.authority,'2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5',pool,'a','b',POOL.vault0,POOL.vault1,TOKEN,TOKEN,POOL.mint0,POOL.mint1,'obs'],stackHeight:null};}
const xfer=(source,destination,authority,amount,mint,decimals,height,program=TOKEN)=>({programId:program,program:'spl-token',stackHeight:height,parsed:{type:'transferChecked',info:{source,destination,authority,mint,tokenAmount:{amount,decimals}}}});
const buyIn=(h,amount='20000')=>xfer('user-sol',POOL.vault0,'AXA2k9FKgTyUaaQSAvB7qVHUsnRJJST2rsmF6EFDZBHZ',amount,WSOL_MINT,9,h);
const buyOut=(h,amount='3632394060')=>xfer(POOL.vault1,'user-coin',POOL.authority,amount,POOL.mint1,6,h);
const tx=(instructions,inner,extra={})=>({slot:1,blockTime:1000,version:0,meta:{err:null,innerInstructions:inner,...extra},transaction:{signatures:['sig'],message:{instructions}}});

test('two swaps in one transaction are two records, ordered by instruction path',()=>{
 const t=tx([{programId:'other',data:'1'},swapIx(),swapIx()],[{index:1,instructions:[buyIn(2),buyOut(2)]},{index:2,instructions:[buyIn(2,'10000'),buyOut(2,'1000000')]}]);
 const r=decodeSwaps(t,POOL);assert.equal(r.swaps.length,2);assert.deepEqual(r.swaps.map(s=>s.instructionPath),['1','2']);assert.equal(r.swaps[1].solLamports,'10000');
});
test('a swap on another pool in the same transaction is not ours',()=>{
 const t=tx([swapIx('OtherPool111111111111111111111111111111111')],[{index:0,instructions:[buyIn(2),buyOut(2)]}]);
 assert.deepEqual(decodeSwaps(t,POOL).swaps,[]);
});
test('a transfer emitted by a program that is not the token program is ignored (forged shape is ambiguous, never a fill)',()=>{
 const t=tx([swapIx()],[{index:0,instructions:[buyIn(2),xfer(POOL.vault1,'user-coin',POOL.authority,'3632394060',POOL.mint1,6,2,'Fake11111111111111111111111111111111111111')]}]);
 const r=decodeSwaps(t,POOL);assert.deepEqual(r.swaps,[]);assert.match(r.skipped[0].reason,/ambiguous/);
});
test('an output transfer not signed by the pool authority is not a fill',()=>{
 const t=tx([swapIx()],[{index:0,instructions:[buyIn(2),xfer(POOL.vault1,'user-coin','someone-else','1',POOL.mint1,6,2)]}]);
 assert.match(decodeSwaps(t,POOL).skipped[0].reason,/ambiguous/);
});
test('a nested swap only takes its own children by stack height; the next leg of the route is not mixed in',()=>{
 const inner=[{...swapIx(),stackHeight:2},buyIn(3),buyOut(3),{programId:'CAMMCzo5YL8w075wJ1XX8jGRBs1nT3uxK7KoRgyXX111',stackHeight:2,data:'1'},xfer('x',POOL.vault0,'someone','999',WSOL_MINT,9,3)];
 const r=decodeSwaps(tx([{programId:'route',data:'1'}],[{index:0,instructions:inner}]),POOL);
 assert.equal(r.swaps.length,1);assert.equal(r.swaps[0].nested,true);assert.equal(r.swaps[0].outerProgram,'route');assert.equal(r.swaps[0].solLamports,'20000');
});
test('a nested swap without stack heights is unsupported and reported, never guessed',()=>{
 const inner=[{...swapIx(),stackHeight:undefined},{...buyIn(3),stackHeight:undefined},{...buyOut(3),stackHeight:undefined}];
 const r=decodeSwaps(tx([{programId:'route',data:'1'}],[{index:0,instructions:inner}]),POOL);
 assert.deepEqual(r.swaps,[]);assert.match(r.skipped[0].reason,/stack heights/);
});
test('a transfer whose mint or decimals contradict the vault is rejected',()=>{
 const wrongMint=tx([swapIx()],[{index:0,instructions:[buyIn(2),xfer(POOL.vault1,'u',POOL.authority,'5','WrongMint1111111111111111111111111111111111',6,2)]}]);
 assert.match(decodeSwaps(wrongMint,POOL).skipped[0].reason,/mint/);
 const wrongDecimals=tx([swapIx()],[{index:0,instructions:[buyIn(2),xfer(POOL.vault1,'u',POOL.authority,'5',POOL.mint1,9,2)]}]);
 assert.match(decodeSwaps(wrongDecimals,POOL).skipped[0].reason,/decimals/);
});
test('plain (unchecked) transfers are accepted and mapped to the vault mint; a missing block time stays null',()=>{
 const plain=(source,destination,authority,amount)=>({programId:TOKEN,program:'spl-token',stackHeight:2,parsed:{type:'transfer',info:{source,destination,authority,amount}}});
 const t=tx([swapIx()],[{index:0,instructions:[plain('u',POOL.vault1,'trader','1000000'),plain(POOL.vault0,'u2',POOL.authority,'1000000000')]}]);t.blockTime=null;
 const r=decodeSwaps(t,POOL);assert.equal(r.swaps.length,1);assert.equal(r.swaps[0].side,'sell');assert.equal(r.swaps[0].priceScaled,'1000000000000000000');assert.equal(r.swaps[0].blockTime,null);
});
