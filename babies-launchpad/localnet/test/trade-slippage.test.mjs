import test from 'node:test';import assert from 'node:assert/strict';
import {tradeMath,validSlippageBps,SLIPPAGE_BPS,validateTradeInput} from '../postlaunch-trade.mjs';
test('user slippage: 10 % default bound, 0.01 %..50 % accepted, minimum output follows the chosen value',()=>{
 assert.equal(SLIPPAGE_BPS.default,1000);
 const r=tradeMath(1_000_000_000n,100_000_000_000n,50_000_000_000_000n,1000);assert.equal(r.minimum,r.output*9000n/10000n);
 assert.equal(tradeMath(1_000_000_000n,100_000_000_000n,50_000_000_000_000n,1).minimum,r.output*9999n/10000n);
 assert.equal(tradeMath(1_000_000_000n,100_000_000_000n,50_000_000_000_000n,5000).minimum,r.output/2n);
 for(const bad of [0,5001,-1,1.5,'10',NaN])assert.throws(()=>tradeMath(1_000_000_000n,1n,1n,bad),/Slippage/,String(bad));
 assert.equal(validSlippageBps(5000),true);assert.equal(validSlippageBps(5001),false);
 assert.throws(()=>validateTradeInput({side:'buy',amountRaw:'1000',requestId:'abcdefghijklmnop',slippageBps:0}),/Slippage/);
 assert.doesNotThrow(()=>validateTradeInput({side:'buy',amountRaw:'1000',requestId:'abcdefghijklmnop',slippageBps:1000}));
});
test('the pool fee rate comes from the pool tier: 2 % and 2.5 % pools quote differently',()=>{
 const two=tradeMath(1_000_000_000n,100_000_000_000n,50_000_000_000_000n,1000,20000n),twoHalf=tradeMath(1_000_000_000n,100_000_000_000n,50_000_000_000_000n,1000,25000n);
 assert.equal(two.fee,20_000_000n);assert.equal(twoHalf.fee,25_000_000n);assert.ok(twoHalf.output<two.output);
 assert.throws(()=>tradeMath(1n,1n,1n,1000,0n),/trade rate/);assert.throws(()=>tradeMath(1n,1n,1n,1000,1000000n),/trade rate/);
});
