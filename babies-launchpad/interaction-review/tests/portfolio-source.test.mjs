import test from 'node:test';import assert from 'node:assert/strict';
import {loadPortfolioPage} from '../src/public/portfolio-source.mjs';import {createPublicPortfolioReader} from '../server/public-portfolio.mjs';
const key=n=>String(n).repeat(32),owner=key(4),id=n=>key(1)+':'+key(2)+':'+key(n),coverage={campaigns:100,indexed:90,fresh:80,complete:false,includes:'launch-receipts-and-creator-allocations',tokenHoldingsIndexed:false};
test('portfolio fetches only discovered campaigns with at most four concurrent detail reads',async()=>{
 let active=0,max=0;const ids=[3,4,5,6,7,8].map(id),api=async p=>p==='state'?{owner,csrf:'csrf'}:{owner,campaignIds:ids,nextCursor:null,coverage};
 const load=async id=>{max=Math.max(max,++active);await new Promise(r=>setTimeout(r,(9-Number(id.at(-1)))*2));active--;return {id};};const p=await loadPortfolioPage({owner},api,load);assert.equal(max,4);assert.deepEqual(p.campaigns.map(c=>c.id),ids);assert.equal(p.coverage.complete,false);assert.equal(p.failures.length,0);
});
test('incomplete records remain errors; owner/scope/coverage mismatches are rejected',async()=>{
 const base={owner,campaignIds:[id(3)],nextCursor:null,coverage};
 const api=result=>async p=>p==='state'?{owner}:result;
 const missing=await loadPortfolioPage({owner},api(base),async()=>null);assert.equal(missing.failures.length,1);assert.equal(missing.campaigns.length,0);
 for(const bad of [{...base,owner:key(9)},{...base,campaignIds:['wrong']},{...base,campaignIds:[id(3),id(3)]},{...base,coverage:{...coverage,complete:true}},{...base,nextCursor:'-1'}])await assert.rejects(loadPortfolioPage({owner},api(bad),async()=>{throw Error('No detail read');}),/verified/);
 const reader=createPublicPortfolioReader({genesisHash:key(1),programId:key(2),store:{discover:async({owner:actual})=>{assert.equal(actual,owner);return {campaignIds:[id(3)],nextCursor:null,coverage};}}});assert.equal((await reader.read(owner,{owner:key(9)})).owner,owner);await assert.rejects(reader.read(owner,{cursor:'-1'}),/cursor/);
});
test('aborting portfolio discovery never continues through the remaining pages',async()=>{
 const controller=new AbortController();let n=0;const p=loadPortfolioPage({owner,signal:controller.signal},async p=>p==='state'?{owner}:{owner,campaignIds:[3,4,5,6,7,8].map(id),nextCursor:null,coverage},async id=>{n++;controller.abort();return {id};});await assert.rejects(p,{name:'AbortError'});assert.ok(n<=4);
});
