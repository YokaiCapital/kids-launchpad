// Health fields, gateway route acceptance and the feed bootstrap guards (kill switch, not launched, identity derivation).
import test from 'node:test';import assert from 'node:assert/strict';
import {setMarketStatus,statusSnapshot,evaluateStatus,marketWarnings} from '../../shared/service-status.mjs';
import {authorizeGateway,classifyRequest} from '../../interaction-review/staging/gateway.mjs';
import {createMarketFeed,identityFromCampaign,marketFeedEnabled} from '../market/feed.mjs';
import {PublicKey,Keypair} from '@solana/web3.js';
test('status snapshot carries the market fields; lag above 120 s and open gaps are warnings, growing decode failures are a problem',()=>{
 setMarketStatus(null);assert.equal(statusSnapshot({ready:true}).market,null);
 setMarketStatus({enabled:true,running:true,connected:true,lagSeconds:5,openGaps:0,decodeFailures:0},1000);
 let snap=statusSnapshot({ready:true});assert.equal(snap.market.connected,true);assert.deepEqual(snap.market.warnings,[]);assert.equal(snap.market.decodeFailuresGrowing,false);
 assert.deepEqual(evaluateStatus(snap,{campaignConfigured:false}),[]);
 setMarketStatus({enabled:true,running:true,connected:false,lagSeconds:130,openGaps:2,decodeFailures:0},2000);
 snap=statusSnapshot({ready:true});assert.deepEqual(snap.market.warnings,['market feed disconnected','market feed lag: 130 s','market history has 2 open gaps']);
 assert.deepEqual(evaluateStatus(snap,{campaignConfigured:false}),[],'warnings never fail the required health check');
 setMarketStatus({enabled:true,running:true,connected:true,lagSeconds:1,openGaps:0,decodeFailures:3},Date.now());
 snap=statusSnapshot({ready:true});assert.equal(snap.market.decodeFailuresGrowing,true);assert.deepEqual(evaluateStatus(snap,{campaignConfigured:false}),['market decode failures growing: 3']);
 setMarketStatus({enabled:true,running:true,connected:true,lagSeconds:1,openGaps:0,decodeFailures:3},Date.now());
 assert.equal(statusSnapshot({ready:true}).market.decodeFailuresGrowing,true,'still inside the ten-minute window');
 assert.deepEqual(marketWarnings({enabled:true,running:true,connected:true,lagSeconds:1,openGaps:0,unsupported:1}),['market skipped 1 transaction of an unsupported version']);
 assert.deepEqual(marketWarnings({enabled:false,running:false,lagSeconds:999}),[],'a switched-off feed has nothing to warn about');
 assert.deepEqual(marketWarnings({enabled:true,running:false}),[],'not started yet is not a warning');
 setMarketStatus(null);
});
test('gateway: market reads with a query string are public reads; other query strings and writes stay refused',()=>{
 const cfg={host:'kids.example',service:'s'.repeat(40),operator:'o'.repeat(40),internal:'i'.repeat(40)};
 const req=(url,method='GET')=>({url,method,headers:{host:cfg.host,origin:'https://kids.fun',authorization:'Bearer '+cfg.service,'content-type':'application/json'}});
 for(const path of ['/api/market/summary?campaign=Campaign1111111111111111111111111111111111','/api/market/candles?campaign=abc&interval=1m&from=1&to=2','/api/market/trades?campaign=abc&cursor=eyJhIjoxfQ&limit=50'])assert.equal(authorizeGateway(req(path),cfg).role,'viewer',path);
 for(const path of ['/api/market/summary','/api/market/other?campaign=x','/api/market/summary?campaign=<script>','/api/market/summary?'+'x'.repeat(700),'/api/account/state?x=1','/api/market/../admin/state?x=1'])assert.equal(authorizeGateway(req(path),cfg).status,404,path);
 assert.equal(authorizeGateway(req('/api/market/summary?campaign=abc','POST'),cfg).status,404);
 assert.equal(classifyRequest('GET','/api/market/summary?campaign=abc',{}),'public-read');
});
test('feed bootstrap: kill switch reports disabled and serves 503; no launched campaign waits and serves 503; identity is derived from launch state',async()=>{
 const reports=[];const off=createMarketFeed({env:{KIDS_MARKET_FEED:'0'},resolve:async()=>{throw Error('never called');},report:r=>reports.push(r),log:()=>{}});
 assert.equal(marketFeedEnabled({KIDS_MARKET_FEED:'0'}),false);assert.equal(marketFeedEnabled({}),true);
 off.start();assert.equal(reports[0].enabled,false);assert.equal(reports[0].running,false);
 let status,body;const res={writableEnded:false,writeHead(s){status=s;},end(b){body=JSON.parse(b);}};
 await off.api.handle({method:'GET',url:'/api/market/summary?campaign=Campaign1111111111111111111111111111111111'},res);assert.equal(status,503);assert.equal(body.status,'disabled');await off.stop();
 const waiting=createMarketFeed({env:{},resolve:async()=>null,report:r=>reports.push(r),log:()=>{},retryMs:100000});
 waiting.start();await waiting.attempt();assert.equal(waiting.lastResolveError(),'no launched campaign yet');assert.equal(waiting.identity(),null);
 await waiting.api.handle({method:'GET',url:'/api/market/summary?campaign=Campaign1111111111111111111111111111111111'},res);assert.equal(status,503);assert.equal(body.status,'not-launched');await waiting.stop();
 const mint=new PublicKey('8P47V2fj1yfg1C76YAZEXJBVzDJBFfURUUTeJjVJq5bz'),pool=new PublicKey('FAThun8yCqyatCAmcUAfqdmD83zHN3RZieEk6FkB5Zcn');
 const {campaignPoolAddresses}=await import('../atomic-launch.mjs');const campaignKey=Keypair.generate().publicKey;
 const id=await identityFromCampaign({ctx:{manifest:{genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'}},state:{mint,pool},campaign:campaignKey,scope:'active-mainnet'},{campaignPoolAddresses,decimalsOf:async()=>6});
 assert.equal(id.pool,pool.toBase58());assert.equal(id.authority,'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL');assert.equal(id.vault0,'8PCBD5FXw9Za77poHpXP31uZAjnoAfF7UDHn8QgWBiee');assert.equal(id.vault1,'D2ewJqiiric6qAqEGMzx2AZ3vEQqrJpB4SiJkUPsysyK');
 assert.equal(id.decimals0,9);assert.equal(id.decimals1,6);assert.equal(id.coinDecimals,6);assert.equal(id.mint,mint.toBase58());assert.equal(id.campaign,campaignKey.toBase58());
 await assert.rejects(identityFromCampaign({ctx:{manifest:{genesisHash:'g'}},state:{mint,pool},campaign:mint,scope:'x'},{campaignPoolAddresses,decimalsOf:async()=>null}),/decimals/);
});
