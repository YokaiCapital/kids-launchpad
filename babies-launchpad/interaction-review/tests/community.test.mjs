import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {validateEnvelope,writeCommunityFile,readCommunityFile} from '../server/community-plugin.mjs';
import {authorizeGateway,gatewayConfig} from '../staging/gateway.mjs';
const ok={generatedAt:'2026-09-23T08:00:00Z',entries:[{xId:'123',username:'nico',name:'N',followers:10,how:['replied'],since:'2026-09-21T10:00:00Z'}]};
test('community envelopes are validated strictly',()=>{
 assert.equal(validateEnvelope('supporters',ok),null);
 assert.match(validateEnvelope('supporters',{...ok,entries:[{...ok.entries[0],xId:'abc'}]}),/entry 0/);
 assert.match(validateEnvelope('supporters',{...ok,entries:[ok.entries[0],ok.entries[0]]}),/repeats/);
 assert.match(validateEnvelope('supporters',{...ok,extra:1}),/unexpected/);
 assert.equal(validateEnvelope('supporter-wallets',{generatedAt:ok.generatedAt,entries:[{xId:'1',wallet:'AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE',provedAt:ok.generatedAt,tweetUrl:'https://x.com/a/status/1'}]}),null);
 assert.match(validateEnvelope('supporter-wallets',{generatedAt:ok.generatedAt,entries:[{xId:'1',wallet:'nope',provedAt:ok.generatedAt,tweetUrl:'https://x.com/a/status/1'}]}),/entry 0/);
 assert.equal(validateEnvelope('blocklist',ok),'unknown file');
});
test('files are written atomically with a bounded history and read back',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-community-'))+'/';
 for(let i=0;i<8;i++)writeCommunityFile('supporters',{...ok,generatedAt:'2026-09-23T08:0'+i+':00Z'},dir,3);
 assert.equal(readCommunityFile('supporters',dir).generatedAt,'2026-09-23T08:07:00Z');
 const {readdirSync}=await import('node:fs');assert.equal(readdirSync(dir).length,4,'current + 3 kept');
});
test('gateway: community uploads need their own token and JSON with a bounded length; reads follow the normal route set',()=>{
 const env={KIDS_BACKEND_TOKEN:'s'.repeat(40),KIDS_OPERATOR_BACKEND_TOKEN:'o'.repeat(40),KIDS_GATEWAY_INTERNAL_TOKEN:'i'.repeat(40),KIDS_GATEWAY_HOST:'api.test',KIDS_COMMUNITY_TOKEN:'c'.repeat(40)};
 const config=gatewayConfig(env);
 const post=(headers)=>authorizeGateway({method:'POST',url:'/api/community/supporters',headers:{host:'api.test','content-type':'application/json','content-length':'100',...headers}},config);
 assert.equal(post({'x-kids-community-token':'c'.repeat(40)}).role,'community');
 assert.equal(post({'x-kids-community-token':'wrong'}).status,401);
 assert.equal(post({'x-kids-community-token':'c'.repeat(40),'content-length':'3000000'}).status,413);
 assert.equal(post({'x-kids-community-token':'c'.repeat(40),'content-type':'text/plain'}).status,415);
 assert.equal(authorizeGateway({method:'POST',url:'/api/community/blocklist',headers:{host:'api.test','x-kids-community-token':'c'.repeat(40),'content-type':'application/json','content-length':'10'}},config).status,403,'unknown community path falls through to the site rules');
 assert.equal(authorizeGateway({method:'POST',url:'/api/community/supporters',headers:{host:'api.test','x-kids-community-token':'c'.repeat(40),'content-type':'application/json','content-length':'10'}},gatewayConfig({...env,KIDS_COMMUNITY_TOKEN:undefined})).status,404,'no token configured, no route');
 const read=authorizeGateway({method:'GET',url:'/api/community/supporters',headers:{host:'api.test',origin:'https://kids.fun',authorization:'Bearer '+'s'.repeat(40)}},config);assert.equal(read.role,'viewer');
});
