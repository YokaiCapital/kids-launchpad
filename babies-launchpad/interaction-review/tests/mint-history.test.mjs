import test from 'node:test';
import assert from 'node:assert/strict';
import {isMintAddress,parseMint,TOKEN_PROGRAM,TOKEN_2022,thresholdRaw,tokenAmount} from '../src/mint.js';
import {fetchMint} from '../server/parent-lookup.mjs';
import {submitVersion,reviewVersion,normalizeDraft,draftError,restoreProposal} from '../src/model.js';
const mint='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const fixture={context:{slot:123},value:{owner:TOKEN_PROGRAM,data:{parsed:{type:'mint',info:{isInitialized:true,supply:'18446744073709551615',decimals:9,mintAuthority:null,freezeAuthority:null}}}}};
const draft={a:'ALPHA',b:'BETA',name:'Sprout',ticker:'SPROUT',description:'A kid.',art:'/assets/sprout.png',rights:true};
test('mint identity and thresholds use exact raw units, including u64 maximum',()=>{
 assert(isMintAddress(mint));assert(!isMintAddress('ALPHA'));assert(!isMintAddress('1'.repeat(33)));assert(!isMintAddress('0'.repeat(44)));
 assert.equal(thresholdRaw('10001'),6n);assert.equal(thresholdRaw('1000000000'),500000n);
 assert.equal(thresholdRaw('18446744073709551615'),9223372036854776n);
 assert.equal(tokenAmount('9223372036854776',9),'9,223,372.036854776');
});
test('RPC mint verification rejects missing accounts, wallet accounts and uninitialized mints',()=>{
 assert.throws(()=>parseMint(mint,{value:null}),/No account/);
 const account=structuredClone(fixture);account.value.data.parsed.type='account';assert.throws(()=>parseMint(mint,account),/not an initialized/);
 const unknown=structuredClone(fixture);unknown.value.owner='11111111111111111111111111111111';assert.throws(()=>parseMint(mint,unknown),/not an initialized/);
 const uninit=structuredClone(fixture);uninit.value.data.parsed.info.isInitialized=false;assert.throws(()=>parseMint(mint,uninit),/not an initialized/);
 const extension=structuredClone(fixture);extension.value.owner=TOKEN_2022;assert.equal(parseMint(mint,extension).supported,false);
 const zero=structuredClone(fixture);zero.value.data.parsed.info.supply='0';assert.equal(parseMint(mint,zero).supported,false);
});
test('lookup only requests finalized read-only mint data and preserves RPC failures',async()=>{
 const data=await fetchMint(mint,{fetchImpl:async(url,options)=>{assert.equal(url,'https://api.mainnet-beta.solana.com');const body=JSON.parse(options.body);assert.equal(body.method,'getAccountInfo');assert.equal(body.params[1].commitment,'finalized');return {ok:true,json:async()=>({result:fixture})};}});
 assert.equal(data.supply,fixture.value.data.parsed.info.supply);
 await assert.rejects(fetchMint(mint,{fetchImpl:async()=>({ok:false,status:429})}),/rate limited/);
});
test('real parents persist with supply evidence and reject duplicate mints',()=>{
 const record=parseMint(mint,fixture);const d=normalizeDraft({...draft,a:mint,parentData:{a:record}});
 assert.equal(d.a,mint);assert.equal(draftError(d),'');assert.ok(draftError({...d,b:mint,parentData:{a:record,b:record}}));
});
test('approved version is immutable across revision submission and later review',()=>{
 const first=submitVersion([],draft,100);const approved=reviewVersion(first.records,first.proposal.id,1,'Approved for next round');
 const before=JSON.stringify(approved[0]);
 const revision=submitVersion(approved,{...draft,name:'Sprout II',proposalId:first.proposal.id},200);
 assert.equal(revision.proposal.version,2);assert.equal(revision.proposal.id,first.proposal.id);assert.equal(JSON.stringify(revision.records[0]),before);
 const changes=reviewVersion(revision.records,first.proposal.id,2,'Changes requested');assert.equal(JSON.stringify(changes[0]),before);
 assert.equal(restoreProposal(changes[1]).version,2);
 const third=submitVersion(changes,{...draft,proposalId:first.proposal.id},300);assert.equal(third.proposal.version,3);assert.equal(third.records[1].status,'Superseded');assert.equal(JSON.stringify(third.records[0]),before);
});
test('new proposals get independent IDs even within the same timestamp',()=>{
 const a=submitVersion([],draft,100);const b=submitVersion(a.records,draft,100);assert.notEqual(a.proposal.id,b.proposal.id);assert.equal(b.proposal.version,1);
});
