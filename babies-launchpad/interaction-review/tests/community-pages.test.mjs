import test from 'node:test';import assert from 'node:assert/strict';
import {fetchCommunity,readFailureText,utcClock,utcDay,nextRefreshAt,refreshLine,rankSupporters,walletIndex,shortWallet,filterSupporters,findSupporter,howCounts,newestSupporters,countUpValue,compactCount,normaliseDenylist,denylistHeadline,enforcementBadges,filterDenylist,reasonLabel,statusLabel,HOW_KINDS} from '../src/community-data.mjs';

const entries=[
 {xId:'3',username:'Late',name:'Late Larry',followers:12,how:['retweeted'],since:'2026-09-22T10:00:00Z'},
 {xId:'2',username:'tie_b',name:'B',followers:1500,how:['agreed in a reply','liked the ask'],since:'2026-09-21T10:00:00Z'},
 {xId:'1',username:'tie_a',name:'A',followers:25858,how:['answered the ask'],since:'2026-09-21T10:00:00Z'},
 {xId:'0',username:'First',name:'First',followers:5,how:['answered the ask','agreed in a quote'],since:'2026-09-20T08:30:00Z'},
 {xId:'9',username:'broken',name:'no since',how:['retweeted'],since:'not a date'},
 {username:'no id',since:'2026-09-21T10:00:00Z'}
];
const wallet='AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE';
const proofs=[{xId:'1',wallet,provedAt:'2026-09-22T09:00:00Z',tweetUrl:'https://x.com/tie_a/status/1'},{xId:'1',wallet:'B'.repeat(44),provedAt:'2026-09-22T11:00:00Z',tweetUrl:'https://x.com/tie_a/status/2'},{xId:'0',wallet:'short'}];

test('rank 1 is the earliest since; ties break on xId; rows without an id, a handle or a readable since are dropped',()=>{
 const ranked=rankSupporters(entries);
 assert.deepEqual(ranked.map(e=>[e.rank,e.username]),[[1,'First'],[2,'tie_a'],[3,'tie_b'],[4,'Late']]);
 assert.equal(ranked[0].since,'2026-09-20T08:30:00Z','since is kept exactly as served');
 assert.deepEqual(rankSupporters(null),[]);assert.deepEqual(rankSupporters({entries:[]}),[]);
 assert.deepEqual(rankSupporters([{xId:'5',username:'x',since:'2026-09-21T00:00:00Z',how:'bad',followers:'12'}])[0].how,[],'a bad how becomes an empty list, a bad follower count becomes null');
});
test('the refresh line is computed from generatedAt plus the refresh period, in UTC',()=>{
 assert.equal(utcClock('2026-09-23T08:05:00Z'),'08:05');assert.equal(utcClock('nonsense'),null);
 assert.equal(utcDay('2026-09-21T23:59:00Z'),'21 Sep 2026');assert.equal(utcDay(undefined),null);
 assert.equal(nextRefreshAt('2026-09-23T08:05:00Z').toISOString(),'2026-09-23T08:35:00.000Z');
 assert.equal(nextRefreshAt('2026-09-23T23:50:00Z',30).toISOString(),'2026-09-24T00:20:00.000Z','rolls over midnight');
 assert.equal(nextRefreshAt('2026-09-23T08:05:00Z',15).toISOString(),'2026-09-23T08:20:00.000Z','honours the served period');
 assert.equal(nextRefreshAt('2026-09-23T08:05:00Z',0).toISOString(),'2026-09-23T08:35:00.000Z','a bad period falls back to 30');
 assert.equal(nextRefreshAt('bad'),null);
 const line=refreshLine('2026-09-23T08:05:00Z',30);
 assert.deepEqual([line.refreshed,line.every,line.next],['08:05',30,'08:35']);
 assert.equal(line.text,'refreshed 08:05 UTC · refreshes every 30 minutes · not here yet? next refresh at 08:35 UTC');
 assert.deepEqual(refreshLine(null),{refreshed:null,every:30,next:null,text:'Refresh time unknown'});
});
test('filters: handle or name (leading @ ignored), one how at a time, wallet linked; rank never moves',()=>{
 const ranked=rankSupporters(entries),wallets=walletIndex(proofs);
 assert.deepEqual(filterSupporters(ranked,{query:'@TIE'}).map(e=>e.rank),[2,3]);
 assert.deepEqual(filterSupporters(ranked,{query:'larry'}).map(e=>e.username),['Late'],'display name matches too');
 assert.deepEqual(filterSupporters(ranked,{how:'answered the ask'}).map(e=>e.rank),[1,2]);
 assert.deepEqual(filterSupporters(ranked,{how:'answered the ask',query:'tie'}).map(e=>e.rank),[2]);
 assert.deepEqual(filterSupporters(ranked,{walletLinked:true},wallets).map(e=>e.rank),[2]);
 assert.equal(filterSupporters(ranked,{}).length,4);
 assert.equal(findSupporter(ranked,'@tie_A').rank,2);assert.equal(findSupporter(ranked,'tie'),null,'exact handle only');assert.equal(findSupporter(ranked,''),null);
 assert.deepEqual(howCounts(ranked,wallets),{'answered the ask':2,'agreed in a reply':1,'agreed in a quote':1,retweeted:1,'liked the ask':1,walletLinked:1});
 assert.deepEqual(newestSupporters(ranked,2).map(e=>e.username),['Late','tie_b']);
 assert.equal(HOW_KINDS.length,5);
});
test('wallet index keeps the first proved wallet per account and drops rows that are not addresses',()=>{
 const wallets=walletIndex(proofs);
 assert.equal(wallets.size,1);assert.equal(wallets.get('1').wallet,wallet);assert.equal(wallets.get('1').tweetUrl,'https://x.com/tie_a/status/1');
 assert.equal(shortWallet(wallet),'AAuw…sdoE');assert.equal(shortWallet(''),'');
 assert.equal(walletIndex(undefined).size,0);
});
test('count-up lands exactly on the total and never overshoots; follower counts are compact',()=>{
 assert.equal(countUpValue(0,1070),0);assert.equal(countUpValue(1,1070),1070);assert.equal(countUpValue(2,1070),1070);assert.equal(countUpValue(-1,1070),0);
 const half=countUpValue(.5,1070);assert.ok(half>535&&half<1070,'ease-out is ahead of linear at the midpoint');
 assert.equal(compactCount(999),'999');assert.equal(compactCount(1500),'1.5K');assert.equal(compactCount(25858),'26K');assert.equal(compactCount(1200000),'1.2M');assert.equal(compactCount(null),'');
});
test('denylist: plain-word labels, headline from the served counts, badges from each flag, search by wallet or cluster',()=>{
 const data=normaliseDenylist({wallets:[
  {wallet:wallet,clusterId:'c-1',reason:'bundler',evidenceUrl:'https://x.com/a/status/1',addedAt:'2026-09-23T07:00:00Z',addedBy:'ops',status:'active',history:[{status:'active',addedAt:'2026-09-23T07:00:00Z',reason:'bundler',evidenceUrl:'https://x.com/a/status/1'}]},
  {wallet:'B'.repeat(44),clusterId:'c-2',reason:'made-up',evidenceUrl:'javascript:alert(1)',addedAt:'2026-09-22T07:00:00Z',status:'appealed',history:'nope'},
  {wallet:'C'.repeat(44),clusterId:'c-1',reason:'vamp',addedAt:'2026-09-21T07:00:00Z',status:'removed'},
  {wallet:'short',status:'active'}
 ],counts:{active:1,total:3,addedToday:1},enforcement:{site:true,program:false,note:'Refused at commit time on kids.fun.'},updatedAt:'2026-09-23T08:00:00Z'});
 assert.equal(data.wallets.length,3,'a non-address row is dropped');
 assert.equal(data.wallets[1].reason,'made-up');assert.equal(reasonLabel(data.wallets[1].reason),'Other, see the receipt');
 assert.equal(data.wallets[1].evidenceUrl,null,'only http(s) receipts are linked');assert.deepEqual(data.wallets[1].history,[]);
 assert.equal(reasonLabel('bundler'),'Bundled buys: one buyer behind many wallets');assert.equal(reasonLabel('drained-funds'),'Drained funds from holders');
 assert.equal(statusLabel('appealed'),'Under appeal');assert.equal(statusLabel('removed'),'Removed');assert.equal(statusLabel('weird'),'Blocked');
 assert.equal(denylistHeadline(data.counts),'1 wallet blocked · 1 added today');assert.equal(denylistHeadline({active:3,addedToday:0}),'3 wallets blocked · 0 added today');
 assert.deepEqual(enforcementBadges(data.enforcement).map(b=>[b.on,b.label]),[[true,'enforced on kids.fun today'],[false,'program enforcement: later build']]);
 assert.deepEqual(enforcementBadges({site:false,program:true}).map(b=>b.label),['not enforced on kids.fun yet','enforced in the program']);
 assert.deepEqual(filterDenylist(data.wallets,'c-1').map(w=>w.status),['active','removed']);
 assert.deepEqual(filterDenylist(data.wallets,'bbbb').map(w=>w.status),['appealed']);
 assert.equal(filterDenylist(data.wallets,'  ').length,3);
 const empty=normaliseDenylist({});assert.deepEqual(empty,{wallets:[],counts:{active:0,total:0,addedToday:0},enforcement:{site:false,program:false,note:''},updatedAt:null});
 assert.equal(normaliseDenylist({wallets:[{wallet:wallet,status:'active'}]}).counts.active,1,'counts fall back to the rows only when the server sends none');
});
test('fetch: 404 is "not published", 5xx and non-JSON are "unavailable", a thrown fetch is "network", bad JSON is "malformed"',async()=>{
 const reply=(status,body,type='application/json')=>async()=>({status,ok:status>=200&&status<300,headers:{get:()=>type},json:async()=>{if(typeof body==='string')throw Error('bad');return body;}});
 assert.deepEqual(await fetchCommunity('supporters',{fetchImpl:reply(404,{})}),{ok:false,reason:'not-published',status:404});
 assert.deepEqual(await fetchCommunity('supporters',{fetchImpl:reply(503,{error:'x'})}),{ok:false,reason:'unavailable',status:503});
 assert.deepEqual(await fetchCommunity('supporters',{fetchImpl:reply(200,{},'text/html')}),{ok:false,reason:'unavailable',status:200});
 assert.deepEqual(await fetchCommunity('supporters',{fetchImpl:reply(200,'<html>')}),{ok:false,reason:'malformed',status:200});
 assert.deepEqual(await fetchCommunity('supporters',{fetchImpl:reply(200,[1])}),{ok:false,reason:'malformed',status:200});
 assert.deepEqual(await fetchCommunity('supporters',{fetchImpl:async()=>{throw Error('offline');}}),{ok:false,reason:'network',status:null});
 const ok=await fetchCommunity('denylist',{fetchImpl:reply(200,{wallets:[]})});assert.equal(ok.ok,true);assert.deepEqual(ok.data,{wallets:[]});
 let seen;await fetchCommunity('supporter-wallets',{fetchImpl:async(url,init)=>{seen={url,init};return reply(200,{})();}});
 assert.equal(seen.url,'/api/community/supporter-wallets');assert.equal(seen.init.credentials,'same-origin');
 assert.match(readFailureText('not-published','believers list'),/not published yet/);assert.match(readFailureText('network','blocked list'),/connection/);assert.match(readFailureText('unavailable','x'),/Try again/);
});
