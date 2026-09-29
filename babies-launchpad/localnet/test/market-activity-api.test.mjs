// Activity read API, gateway route acceptance and the feed bootstrap: campaign binding, bounded pages, kind filters,
// counts by kind, explicit status, floats beside exact strings, the shared 2 s single-flight cache; the identity
// derivation reproduces the real fee-state PDA; kill switches and the not-launched state.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PublicKey} from '@solana/web3.js';
import {openActivityStore,createActivityApi,createActivityFeed,activityIdentityFromCampaign,activityFeedEnabled,activityStatus,shapeEvent} from '../market/activity.mjs';
import {decodeActivity} from '../market/activity-decode.mjs';
import {authorizeGateway,classifyRequest} from '../../interaction-review/staging/gateway.mjs';
const fixture=name=>JSON.parse(readFileSync(new URL('./fixtures/market/activity/'+name+'.json',import.meta.url),'utf8'));
const ID=fixture('identity'),scope={genesis:ID.genesis,campaign:ID.campaign};
const NAMES=['campaign-init-configure','commit','finalize','settle','launch','fees-init','fees-collect','fees-sell','fees-distribute','buy-burn','claim-participant','burn-child'];
function filledStore(){const store=openActivityStore();store.insertEvents(scope,NAMES.flatMap(n=>decodeActivity(fixture(n),ID).events),{commitment:'finalized',observedAt:1});return store;}
const STATS={connected:true,lagSeconds:3,lastPollAt:1790129400000,lastPollOk:true,lastEventAgeSeconds:60,backfillComplete:true,openGaps:0,decodeFailures:0,unsupportedRecorded:0,store:{provisional:0}};
function fakeFeed({enabled=true,identity=true,store=filledStore(),stats=STATS,coverage=[{address:ID.campaign,role:'campaign',completeToStart:true,gaps:[]},{address:ID.feeState,role:'fees',completeToStart:true,gaps:[]}]}={}){
 return {enabled,identity:()=>identity?ID:null,store:()=>store,stats:()=>stats,coverage:()=>coverage};
}
async function get(api,url){
 let status=null,body=null;const res={writableEnded:false,writeHead(s){status=s;},end(b){body=JSON.parse(b);this.writableEnded=true;}};
 const handled=await api.handle({method:'GET',url},res);return {handled,status,body};
}
test('activity: newest first, counts by kind, exact strings beside floats, status live, coverage per watched address',async()=>{
 const api=createActivityApi({feed:fakeFeed(),now:()=>1790129400000});
 const r=await get(api,'/api/market/activity?campaign='+ID.campaign+'&limit=3');
 assert.equal(r.status,200);const b=r.body;
 assert.equal(b.campaign,ID.campaign);assert.equal(b.mint,ID.mint);assert.deepEqual(b.events.map(e=>e.kind),['fees-collect','burn-child','claim-participant']);
 const burn=b.events[1];assert.equal(burn.status,'finalized');assert.equal(burn.path,'1');assert.equal(burn.time,1790137077);
 assert.deepEqual(burn.assets,[{mint:ID.mint,amountRaw:'670345318218',decimals:6,amount:670345.318218,direction:'burn',role:null,account:'3J8bPRku3cTzVkD8fwHfrEusamJaERYfbEtsaWFPfanb'}]);
 assert.equal(b.counts.total,15);assert.equal(b.counts.failed,0);assert.equal(b.counts.byKind.launch,1);assert.equal(b.counts.byKind['authority-revoked'],2);
 assert.equal(b.status,'live');assert.equal(b.feed.lagSeconds,3);assert.equal(b.coverage.addresses.length,2);assert.equal(b.coverage.oldestBlockTime,1790128703);
 assert.ok(b.nextCursor);const next=await get(api,'/api/market/activity?campaign='+ID.campaign+'&limit=3&cursor='+b.nextCursor);assert.deepEqual(next.body.events.map(e=>e.kind),['buy-burn','fees-distribute','fees-sell']);
 const filtered=await get(api,'/api/market/activity?campaign='+ID.campaign+'&kinds=commit,launch');assert.deepEqual(filtered.body.events.map(e=>e.kind),['launch','commit']);
 const encoded=await get(api,'/api/market/activity?campaign='+ID.campaign+'&kinds=commit%2Csettle');assert.deepEqual(encoded.body.events.map(e=>e.kind),['settle','commit']);
});
test('activity: validation and binding: wrong campaign 404, missing 400, bad limit, unknown kind, bad cursor 400, not launched 503, switched off 503, POST 405, other paths untouched',async()=>{
 const api=createActivityApi({feed:fakeFeed(),now:()=>1});
 assert.equal((await get(api,'/api/market/activity?campaign=Campaign2222222222222222222222222222222222')).status,404);
 assert.equal((await get(api,'/api/market/activity')).status,400);
 assert.equal((await get(api,'/api/market/activity?campaign='+ID.campaign+'&limit=0')).status,400);
 assert.equal((await get(api,'/api/market/activity?campaign='+ID.campaign+'&limit=201')).status,400);
 assert.match((await get(api,'/api/market/activity?campaign='+ID.campaign+'&kinds=swap')).body.error,/unknown kind/);
 assert.equal((await get(api,'/api/market/activity?campaign='+ID.campaign+'&cursor=zzz')).status,400);
 assert.equal((await get(api,'/api/market/summary?campaign='+ID.campaign)).handled,false,'the swap API owns the other market routes');
 assert.equal((await get(api,'/api/account/state')).handled,false);
 let status;const res={writableEnded:false,writeHead(s){status=s;},end(){}};await api.handle({method:'POST',url:'/api/market/activity'},res);assert.equal(status,405);
 assert.equal((await get(createActivityApi({feed:fakeFeed({identity:false}),now:()=>1}),'/api/market/activity?campaign='+ID.campaign)).body.status,'not-launched');
 assert.equal((await get(createActivityApi({feed:fakeFeed({enabled:false}),now:()=>1}),'/api/market/activity?campaign='+ID.campaign)).status,503);
});
test('activity: shared cache with single flight; entries expire after 2 s; status reflects stale, backfilling and empty feeds',async()=>{
 let t=1790129400000;const store=filledStore();let reads=0;const counted={...store,events:(...a)=>{reads++;return store.events(...a);}};
 const api=createActivityApi({feed:fakeFeed({store:counted}),now:()=>t});
 const url='/api/market/activity?campaign='+ID.campaign+'&limit=5';
 await Promise.all([get(api,url),get(api,url),get(api,url)]);assert.equal(reads,1,'three concurrent viewers share one computation');
 t+=1000;await get(api,url);assert.equal(reads,1);t+=1500;await get(api,url);assert.equal(reads,2,'recomputed after the cache window');
 assert.equal(activityStatus({...STATS,lagSeconds:500},[],{total:1}),'stale');
 assert.equal(activityStatus(STATS,[{completeToStart:false,gaps:[]}],{total:1}),'backfilling');
 assert.equal(activityStatus(STATS,[{completeToStart:true,gaps:[{}]}],{total:1}),'backfilling');
 assert.equal(activityStatus(STATS,[{completeToStart:true,gaps:[]}],{total:0}),'no-activity');
 assert.equal(activityStatus(null,[],{total:0}),'disabled');assert.equal(activityStatus({...STATS,lastPollAt:null,lastPollOk:null,lagSeconds:null},[],{total:0}),'starting');
 assert.equal(shapeEvent({signature:'s',instructionPath:'1.2',slot:1,blockTimeUnix:2,program:'launch',kind:'commit',actor:'a',assets:[{mint:'SOL',amountRaw:'1500000000',decimals:9,direction:'in'}],status:'confirmed',nested:true,detail:null,decoderVersion:1}).assets[0].amount,1.5);
 store.close();
});
test('gateway: the activity route with campaign, cursor, limit and a comma list of kinds is a public read; the swap routes still pass',()=>{
 const cfg={host:'kids.example',service:'s'.repeat(40),operator:'o'.repeat(40),internal:'i'.repeat(40)};
 const req=(url,method='GET')=>({url,method,headers:{host:cfg.host,origin:'https://kids.fun',authorization:'Bearer '+cfg.service,'content-type':'application/json'}});
 for(const path of ['/api/market/activity?campaign='+ID.campaign,'/api/market/activity?campaign='+ID.campaign+'&kinds=commit,refund,buy-burn&limit=50&cursor=eyJhIjoxfQ','/api/market/summary?campaign='+ID.campaign,'/api/market/trades?campaign=abc&limit=5'])assert.equal(authorizeGateway(req(path),cfg).role,'viewer',path);
 for(const path of ['/api/market/activity','/api/market/activity?campaign=<x>','/api/market/activities?campaign=x'])assert.equal(authorizeGateway(req(path),cfg).status,404,path);
 assert.equal(authorizeGateway(req('/api/market/activity?campaign=x','POST'),cfg).status,404);
 assert.equal(classifyRequest('GET','/api/market/activity?campaign=abc',{}),'public-read');
});
test('feed bootstrap: the identity derives the real fee-state PDA and the distribution record; kill switches; not launched keeps waiting; a launched campaign starts the worker',async()=>{
 const programId=new PublicKey(ID.launchProgram),campaign=new PublicKey(ID.campaign);
 const selected={ctx:{programId,manifest:{genesisHash:ID.genesis}},campaign,state:{mint:new PublicKey(ID.mint),distributionProgram:null},scope:'active-mainnet'};
 const distributionAddress=(program,c)=>PublicKey.findProgramAddressSync([Buffer.from('distribution'),c.toBuffer()],new PublicKey(program))[0];
 const identity=await activityIdentityFromCampaign(selected,{decimalsOf:async()=>6,PublicKey,distributionAddress});
 assert.equal(identity.feeState,ID.feeState,'the same PDA the real fee transactions carry as account 2');
 assert.deepEqual([identity.campaign,identity.launchProgram,identity.mint,identity.coinDecimals,identity.distributionProgram,identity.distribution,identity.scope],[ID.campaign,ID.launchProgram,ID.mint,6,null,null,'active-mainnet']);
 const dp=new PublicKey('BLiaZWNQoPm4mG4cXNm4sXifFqs1Xmxx12qD9T4Y5NeN');
 const vault=await activityIdentityFromCampaign({...selected,state:{...selected.state,distributionProgram:dp}},{decimalsOf:async()=>6,PublicKey,distributionAddress});
 assert.equal(vault.distributionProgram,dp.toBase58());assert.equal(vault.distribution,distributionAddress(dp,campaign).toBase58());
 await assert.rejects(activityIdentityFromCampaign(selected,{decimalsOf:async()=>null,PublicKey,distributionAddress}),/decimals unavailable/);
 assert.equal(activityFeedEnabled({}),true);assert.equal(activityFeedEnabled({KIDS_MARKET_FEED:'0'}),false);assert.equal(activityFeedEnabled({KIDS_MARKET_ACTIVITY:'0'}),false);
 const lines=[];const off=createActivityFeed({env:{KIDS_MARKET_ACTIVITY:'0'},log:l=>lines.push(l),resolve:async()=>{throw Error('never');}});off.start();assert.equal(lines[0].event,'activity-feed-disabled');assert.equal(off.status().enabled,false);await off.stop();
 const waiting=createActivityFeed({env:{},log:l=>lines.push(l),resolve:async()=>null,rpcUrl:'http://127.0.0.1:9',storePath:':memory:'});await waiting.attempt();assert.equal(waiting.status().running,false);assert.equal(waiting.status().lastError,'no launched campaign yet');await waiting.stop();
 const originalFetch=globalThis.fetch;const rpcCalls=[];
 globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);rpcCalls.push(body.method);return {ok:true,status:200,headers:{get:()=>null},json:async()=>({jsonrpc:'2.0',id:body.id,result:[]})};};
 try{
  const live=createActivityFeed({env:{},log:l=>lines.push(l),resolve:async()=>identity,rpcUrl:'http://127.0.0.1:9',storePath:':memory:',options:{pollIntervalMs:3600000}});
  await live.attempt();await new Promise(r=>setTimeout(r,20));
  assert.equal(live.status().running,true);assert.equal(live.status().campaign,ID.campaign);assert.ok(rpcCalls.filter(m=>m==='getSignaturesForAddress').length>=2,'both watched addresses were polled');
  assert.ok(lines.some(l=>l.event==='activity-feed-started'&&l.watched.join()==='campaign,fees'));assert.ok(!JSON.stringify(lines).includes('127.0.0.1:9'),'no RPC URL in logs');
  const r=await new Promise(resolve=>{let status=null;const res={writableEnded:false,writeHead(s){status=s;},end(b){resolve({status,body:JSON.parse(b)});}};live.api.handle({method:'GET',url:'/api/market/activity?campaign='+ID.campaign},res);});
  assert.equal(r.status,200);assert.deepEqual(r.body.events,[]);assert.equal(r.body.status,'no-activity');
  await live.stop();assert.equal(live.status().running,false);
 }finally{globalThis.fetch=originalFetch;}
});
