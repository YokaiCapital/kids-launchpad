import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteCampaignCosts} from '../budgets.mjs';
import {quoteAuthorityFunding} from './setup-funding.mjs';
const costs=()=>JSON.parse(JSON.stringify(quoteCampaignCosts({live:{ammCreationFeeLamports:150000000n,baseFeeLamports:5000n,priorityFeeLamports:10000n},counts:{ataCreates:9,transactions:8,signatures:11,lockedPositions:1,feeStates:1}}),(_,v)=>typeof v==='bigint'?String(v):v));
test('pool reserve contains only pool CPI costs and its margin, not a second payment for mint or keeper costs',()=>{
 const c=costs(),f=quoteAuthorityFunding(c),line=name=>BigInt(c.lines.find(l=>l.item===name).lamports);
 const subtotal=line('pool creation fee (AMM config)')+line('pool accounts rent (pool, observation, LP mint)')+line('associated token accounts')/3n;
 assert.equal(BigInt(f.amountLamports),subtotal+(subtotal*1500n+9999n)/10000n);assert.equal(f.coverage,'pool-initialization-only');assert.ok(BigInt(f.amountLamports)<BigInt(c.totalLamports));assert.equal(f.destination,'launch-authority');
 for(const mutate of [x=>x.totalLamports='1',x=>x.marginLamports='0',x=>x.lines.push(x.lines[0]),x=>x.lines[7].count=0,x=>x.lines[0].lamports='-1',x=>x.lines[3].payer='operator',x=>x.lines[7].lamports='1']){const changed=costs();mutate(changed);assert.throws(()=>quoteAuthorityFunding(changed));}
});
test('the margin left on the launch authority must reach the rent floor, or the launch would leave a non-rent-exempt account',async()=>{
 const {AUTHORITY_RENT_FLOOR_LAMPORTS}=await import('./setup-funding.mjs');assert.equal(AUTHORITY_RENT_FLOOR_LAMPORTS,890880n);
 const healthy=costs();assert.ok(BigInt(quoteAuthorityFunding(healthy).marginLamports)>=AUTHORITY_RENT_FLOOR_LAMPORTS);
 const thin=JSON.parse(JSON.stringify(quoteCampaignCosts({live:{ammCreationFeeLamports:150000000n,baseFeeLamports:5000n,priorityFeeLamports:10000n},counts:{ataCreates:9,transactions:8,signatures:11,lockedPositions:1,feeStates:1},marginBps:10}),(_,v)=>typeof v==='bigint'?String(v):v));
 assert.throws(()=>quoteAuthorityFunding(thin),/rent floor/);
});
