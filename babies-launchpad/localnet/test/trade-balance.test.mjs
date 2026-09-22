import test from 'node:test';import assert from 'node:assert/strict';import {assertTradeBalance} from '../postlaunch-trade.mjs';
const owner='6EU5CHrLWCvQUZUsRQNPnsPRCs8VJexDeHypwnBgArzi',mint='8wxqJJeeNeJsBKa3Q7JRFxvop6uRryS1JeY3hbhhBdvA';
const conn=(sol,coins)=>({getBalance:async()=>sol,getTokenAccountBalance:async()=>{if(coins===null)throw Error('could not find account');return {value:{amount:String(coins)}};}});
test('a sell above the wallet holding is refused in plain words before any signing',async()=>{
 await assert.rejects(assertTradeBalance(conn(0,12500000),owner,'sell',20000000n,mint),/You hold 12\.5 \$Shartcoin\. Enter at most that amount\./);
 await assert.rejects(assertTradeBalance(conn(0,null),owner,'sell',1n,mint),/hold no \$Shartcoin/);
 await assert.equal(await assertTradeBalance(conn(0,12500000),owner,'sell',12500000n,mint),undefined);
});
test('a buy keeps 0.01 SOL for fees and says the maximum',async()=>{
 await assert.rejects(assertTradeBalance(conn(500000000,0),owner,'buy',495000000n,mint),/You have 0\.5 SOL on the test ledger\. Enter at most 0\.49 SOL/);
 await assert.equal(await assertTradeBalance(conn(500000000,0),owner,'buy',490000000n,mint),undefined);
});
