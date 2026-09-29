import test from 'node:test';import assert from 'node:assert/strict';import {PublicKey} from '@solana/web3.js';
import {createPublicMarketWorker,validateMarketConfig} from './public-service.mjs';import {REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
const key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const policy={ratePerSecond:20,burst:20,lanes:{indexing:{ratePerSecond:10,burst:10},backfill:{ratePerSecond:10,burst:10}}};
const config={mode:'localnet-rehearsal',lane:'indexing',genesisHash:key(1),programId:key(2),rpcUrl:'http://127.0.0.1:19199',concurrency:2,rpcAdmission:{resource:'test-market',policy}};
test('market roles require local rehearsal, current shared schema and reserved RPC capacity',async()=>{
 assert.throws(()=>validateMarketConfig({...config,mode:'production'}),/localnet/);
 assert.throws(()=>validateMarketConfig({...config,lane:'lifecycle'}),/localnet/);
 assert.throws(()=>validateMarketConfig({...config,rpcUrl:'https://example.com'}),/loopback/);
 await assert.rejects(createPublicMarketWorker({registry:{driver:'sqlite'},config}),/shared schema/);
});
test('indexing and backfill lease separate exact-scope lanes without a wallet signer',async()=>{
 const admissions=[],leases=[],methods=[];
 const registry={driver:'postgres',schemaVersion:async()=>REGISTRY_SCHEMA_VERSION,admission:{consume:async c=>{admissions.push(c);return {allowed:true};}},jobs:{leaseNext:async q=>{leases.push(q);return null;}}};
 const fetchImpl=async(_url,init)=>{const req=JSON.parse(init.body);methods.push(req.method);return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result:req.method==='getGenesisHash'?key(1):{value:{executable:true}}}),{headers:{'content-type':'application/json'}});};
 for(const lane of ['indexing','backfill']){const worker=await createPublicMarketWorker({registry,config:{...config,lane},fetchImpl});await worker.tick();await worker.stop();}
 assert.deepEqual(leases.map(x=>x.jobClasses),[['market-index'],['market-backfill']]);
 assert.ok(leases.every(x=>x.scope.genesisHash===key(1)&&x.scope.programId===key(2)&&x.scope.campaignVersion===2));
 assert.deepEqual(admissions.map(x=>x.lane),['indexing','indexing','backfill','backfill']);assert.deepEqual(methods,['getGenesisHash','getAccountInfo','getGenesisHash','getAccountInfo']);
});

test('market indexing does not infer issuer version from its shared account layout',()=>{
 assert.equal(validateMarketConfig(config).scope.campaignVersion,2);
 assert.equal(validateMarketConfig({...config,programVersion:3}).scope.campaignVersion,3);
 assert.throws(()=>validateMarketConfig({...config,programVersion:4}),/Unsupported/);
});

test('hosted market mode: verified release only, no loopback RPC, manifest and endpoint from the environment',async()=>{
 const {releaseFixture}=await import('../hosted/release-manifest.test.mjs');
 const {readFileSync}=await import('node:fs');
 const presets=readFileSync(new URL('../../deployment/presets/public-presets-v1.json',import.meta.url));
 const fx=releaseFixture({presets,schema:REGISTRY_SCHEMA_VERSION});
 const hosted={mode:'hosted',lane:'indexing',programVersion:3,genesisHash:key(1),programId:key(2),rpcUrl:'https://rpc.example.test/v1',release:fx.manifest,concurrency:2,rpcAdmission:{resource:'hosted-market',policy}};
 assert.equal(validateMarketConfig(hosted).release.network,'mainnet');
 assert.throws(()=>validateMarketConfig({...hosted,rpcUrl:'http://127.0.0.1:19199'}),/loopback/);
 assert.throws(()=>validateMarketConfig({...hosted,rpcUrl:'http://rpc.example.test/'}),/https or a private-network/);
 assert.throws(()=>validateMarketConfig({...hosted,programVersion:2}),/match its release/);
 assert.throws(()=>validateMarketConfig({...hosted,release:undefined}),/Release manifest/);
 const b64=b=>Buffer.from(b).toString('base64');
 const rpc=accounts=>async(_url,init)=>{const p=JSON.parse(init.body);let result;
  if(p.method==='getGenesisHash')result=key(1);
  else if(p.method==='getAccountInfo'){const a=accounts.get(p.params[0]);result={context:{slot:1},value:a?{data:[b64(a.data),'base64'],executable:a.executable,lamports:1,owner:key(5),rentEpoch:0,space:a.data.length}:null};}
  else result={context:{slot:1},value:null};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:p.id,result}),{headers:{'content-type':'application/json'}});};
 const registry={driver:'postgres',schemaVersion:async()=>REGISTRY_SCHEMA_VERSION,admission:{consume:async()=>({allowed:true})},jobs:{leaseNext:async()=>null}};
 const worker=await createPublicMarketWorker({registry,config:hosted,fetchImpl:rpc(fx.accounts)});await worker.stop();
 const tampered=new Map(fx.accounts);tampered.set(fx.programData.toBase58(),{executable:false,data:Buffer.concat([Buffer.alloc(45,1),Buffer.from('other'),Buffer.alloc(8,0)])});
 await assert.rejects(createPublicMarketWorker({registry,config:hosted,fetchImpl:rpc(tampered)}),e=>e.code==='RELEASE_MISMATCH'&&e.check==='binary');
});
