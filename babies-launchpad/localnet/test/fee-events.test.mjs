import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {feeDelta,appendFeeEvent} from '../active-fee-keeper.mjs';import {readFeeEvents} from '../postlaunch-state.mjs';
test('fee delta lists only the counters that moved, as strings',()=>{
 const before={totalSol:100n,parentASpent:0n,parentABurned:0n},after={totalSol:100n,parentASpent:2598641n,parentABurned:254555896n};
 assert.deepEqual(feeDelta(before,after),{parentASpent:'2598641',parentABurned:'254555896'});assert.equal(feeDelta(null,after),null);
});
test('history is bounded and served newest first for the matching campaign only',()=>{
 const j={identity:{campaign:'C'},history:[]};for(let i=0;i<505;i++)appendFeeEvent(j,{id:'fee:'+i,kind:'buy-burn',index:0,amount:'1',signature:'s'+i,at:i,delta:{parentABurned:'5'}});
 assert.equal(j.history.length,500);const dir=mkdtempSync(join(tmpdir(),'kids-fee-'));const p=join(dir,'j.json');writeFileSync(p,JSON.stringify(j));
 const events=readFeeEvents('C',p);assert.equal(events.length,60);assert.equal(events[0].id,'fee:504');assert.deepEqual(Object.keys(events[0]).sort(),['amount','at','delta','id','index','kind','signature']);
 assert.deepEqual(readFeeEvents('other',p),[]);assert.deepEqual(readFeeEvents('C',join(dir,'missing.json')),[]);
});
test('wallet balances come back as strings with the fee reserve, missing coin account means 0',async()=>{
 const {walletBalances}=await import('../postlaunch-state.mjs');
 const conn={getBalance:async()=>1234567890,getTokenAccountBalance:async()=>{throw Error('no account');}};
 const b=await walletBalances(conn,'6EU5CHrLWCvQUZUsRQNPnsPRCs8VJexDeHypwnBgArzi','8wxqJJeeNeJsBKa3Q7JRFxvop6uRryS1JeY3hbhhBdvA');
 assert.deepEqual(b,{owner:'6EU5CHrLWCvQUZUsRQNPnsPRCs8VJexDeHypwnBgArzi',solLamports:'1234567890',coinRaw:'0',coinDecimals:6,feeReserveLamports:'10000000'});
});
