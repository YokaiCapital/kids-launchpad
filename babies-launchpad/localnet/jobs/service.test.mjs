import test from 'node:test';import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {validateWorkerConfig,createPublicWorker} from './service.mjs';
import {REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const policy={ratePerSecond:20,burst:20,lanes:{lifecycle:{ratePerSecond:10,burst:10},recovery:{ratePerSecond:10,burst:10}}};
const config=()=>({mode:'localnet-rehearsal',lane:'recovery',genesisHash:addr(1),programId:addr(2),concurrency:2,rpcUrl:'http://127.0.0.1:8899',signer:{url:'http://127.0.0.1:4176',token:'synthetic-rehearsal-test-token'.padEnd(40,'x'),publicKey:addr(3)},rpcAdmission:{resource:'rpc-local',policy},signerAdmission:{resource:'signer-local',policy}});
test('worker refuses public activation, unimplemented lanes, external endpoints and SQLite',async()=>{
 assert.throws(()=>validateWorkerConfig({...config(),mode:'production'}),/limited/);
 assert.throws(()=>validateWorkerConfig({...config(),lane:'indexing'}),/No qualified/);
 assert.throws(()=>validateWorkerConfig({...config(),rpcUrl:'https://api.mainnet-beta.solana.com'}),/loopback/);
 await assert.rejects(createPublicWorker({config:config(),registry:{driver:'sqlite'}}),/PostgreSQL/);
});
test('worker probes exact ledger, requires admission and leases only its supported program/version/classes',async()=>{
 const calls=[],requests=[];let wrongGenesis=false,denied=false;
 const registry={driver:'postgres',operatorPackets:Object.fromEntries(['latest','prepare','sign','progress'].map(k=>[k,()=>{throw Error('unexpected packet write');}])),schemaVersion:async()=>REGISTRY_SCHEMA_VERSION,
  admission:{async consume(input){calls.push(input);return {allowed:!denied,retryAfterMs:1000};}},
  jobs:{async leaseNext(input){requests.push(input);return null;}}};
 const fetchImpl=async(_url,init)=>{
  const p=JSON.parse(init.body);const result=p.method==='getGenesisHash'?(wrongGenesis?addr(4):addr(1)):{context:{slot:1},value:{data:['','base64'],executable:true,lamports:1,owner:addr(5),rentEpoch:0}};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:p.id,result}),{headers:{'content-type':'application/json'}});
 };
 const worker=await createPublicWorker({config:config(),registry,fetchImpl});
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.lane==='recovery'&&c.resource==='rpc-local'));
 await worker.tick();assert.equal(requests.length,1);assert.deepEqual(requests[0].jobClasses,['refunds']);assert.deepEqual(requests[0].scope,{genesisHash:addr(1),programId:addr(2),campaignVersion:2});
 await worker.stop();assert.throws(()=>worker.start(),/Stopped/);
 wrongGenesis=true;await assert.rejects(createPublicWorker({config:config(),registry,fetchImpl}),/genesis mismatch/);
 wrongGenesis=false;denied=true;await assert.rejects(createPublicWorker({config:config(),registry,fetchImpl}),{code:'CAPACITY_WAIT'});
 assert.equal(requests.length,1,'failed startup never leased a job');
});
test('fee services reserve different admission lanes and cannot lease buybacks or lifecycle jobs',async()=>{
 const reads=[],leases=[];
 const registry={driver:'postgres',operatorPackets:Object.fromEntries(['latest','prepare','sign','progress'].map(k=>[k,()=>{throw Error('unexpected packet write');}])),schemaVersion:async()=>REGISTRY_SCHEMA_VERSION,
  admission:{async consume(input){reads.push(input);return {allowed:true};}},jobs:{async leaseNext(input){leases.push(input);return null;},async get(){return null;}}};
 const fetchImpl=async(_url,init)=>{const p=JSON.parse(init.body),result=p.method==='getGenesisHash'?addr(1):{context:{slot:1},value:{data:['','base64'],executable:true,lamports:1,owner:addr(5),rentEpoch:0}};return new Response(JSON.stringify({jsonrpc:'2.0',id:p.id,result}),{headers:{'content-type':'application/json'}});};
 const policy={ratePerSecond:20,burst:20,lanes:{harvest:{ratePerSecond:10,burst:10},economics:{ratePerSecond:10,burst:10}}};
 for(const lane of ['harvest','economics']){
  const c={...config(),lane,rpcAdmission:{resource:'rpc-fees',policy},signerAdmission:{resource:'signer-fees',policy}};
  const worker=await createPublicWorker({registry,config:c,fetchImpl});await worker.tick();await worker.stop();
 }
 assert.deepEqual(leases.map(x=>x.jobClasses),[['fee-harvest'],['distribution','token-burn']]);
 assert.deepEqual(reads.map(x=>x.lane),['harvest','harvest','economics','economics']);
});

test('new issuer version is explicit and old workers retain their scope',()=>{
 assert.equal(validateWorkerConfig(config()).scope.campaignVersion,2);
 assert.equal(validateWorkerConfig({...config(),programVersion:3}).scope.campaignVersion,3);
 for(const programVersion of [1,4,'3',null])assert.throws(()=>validateWorkerConfig({...config(),programVersion}),/Unsupported/);
});
test('lifecycle control is an explicit v3 policy, never an implicit legacy-worker expansion',()=>{
 const lifecycle={setupHandoff:true,policy:'local-lifecycle',minimumReserveLamports:'1000000'};
 assert.equal(validateWorkerConfig({...config(),lane:'lifecycle',programVersion:3,lifecycle}).lifecycle.setupHandoff,true);
 for(const patch of [{programVersion:2},{lane:'recovery'},{lifecycle:{...lifecycle,setupHandoff:false}},{lifecycle:{...lifecycle,minimumReserveLamports:'0'}}])assert.throws(()=>validateWorkerConfig({...config(),lane:'lifecycle',programVersion:3,lifecycle,...patch}));
});

test('receipt batch configuration is explicit v3-only and never borrows a fee lane',()=>{
 assert.equal(validateWorkerConfig(config()).receiptBatchSize,1);
 assert.equal(validateWorkerConfig({...config(),programVersion:3,receiptBatchSize:8}).receiptBatchSize,8);
 for(const patch of [{receiptBatchSize:8},{programVersion:3,receiptBatchSize:9},{programVersion:3,receiptBatchSize:0},{programVersion:3,receiptBatchSize:'8'},{programVersion:3,receiptBatchSize:8,lane:'harvest'}])assert.throws(()=>validateWorkerConfig({...config(),...patch}),/Receipt batching/);
});

test('accounting service has a distinct RPC partition and needs no signer credentials',async()=>{
 const leases=[],reads=[];const registry={driver:'postgres',operatorPackets:{},schemaVersion:async()=>REGISTRY_SCHEMA_VERSION,admission:{async consume(x){reads.push(x);return {allowed:true};}},jobs:{async leaseNext(x){leases.push(x);return null;}}};
 const c={...config(),lane:'accounting',programVersion:3,signer:undefined,signerAdmission:undefined,operating:{payer:addr(3),policy:'funded-v3'},rpcAdmission:{resource:'rpc-accounting',policy:{ratePerSecond:20,burst:20,lanes:{accounting:{ratePerSecond:20,burst:20}}}}};
 const fetchImpl=async(_url,init)=>{const p=JSON.parse(init.body),result=p.method==='getGenesisHash'?addr(1):{context:{slot:1},value:{data:['','base64'],executable:true,lamports:1,owner:addr(5),rentEpoch:0}};return new Response(JSON.stringify({jsonrpc:'2.0',id:p.id,result}),{headers:{'content-type':'application/json'}});};
 const worker=await createPublicWorker({registry,config:c,fetchImpl,reconciliationFactory:()=>({reconcile:async()=>{throw Error('unexpected proof request');}}),adapterFactory:()=>{throw Error('Accounting must never construct a signing adapter');}});
 await worker.tick();assert.deepEqual(leases[0].jobClasses,['operating-reconcile','operating-refill']);assert.equal(leases[0].scope.operatingPayer,addr(3));assert.equal(leases[0].scope.operatingPolicy,'funded-v3');assert.ok(reads.every(x=>x.resource==='rpc-accounting'&&x.lane==='accounting'));await worker.stop();
 assert.throws(()=>validateWorkerConfig({...c,programVersion:2}),/v3/);
});

test('fee setup worker serves only the isolated v3 provisioning class',async()=>{
 const leases=[],reads=[],registry={driver:'postgres',operatorPackets:{latest(){},prepare(){},sign(){},progress(){}},schemaVersion:async()=>REGISTRY_SCHEMA_VERSION,admission:{async consume(x){reads.push(x);return {allowed:true};}},jobs:{async leaseNext(x){leases.push(x);return null;}}};
 const policy={ratePerSecond:10,burst:10,lanes:{provisioning:{ratePerSecond:10,burst:10}}};
 const c={...config(),lane:'provisioning',programVersion:3,feeOperator:addr(7),rpcAdmission:{resource:'rpc-setup',policy},signerAdmission:{resource:'signer-setup',policy}};
 const fetchImpl=async(_url,init)=>{const p=JSON.parse(init.body),result=p.method==='getGenesisHash'?addr(1):{context:{slot:1},value:{data:['','base64'],executable:true,lamports:1,owner:addr(5),rentEpoch:0}};return new Response(JSON.stringify({jsonrpc:'2.0',id:p.id,result}),{headers:{'content-type':'application/json'}});};
 const worker=await createPublicWorker({registry,config:c,fetchImpl,adapterFactory:args=>{assert.equal(args.commitment,'finalized');assert.equal(args.confirmationWaitMs,0);return {programId:addr(2),keeper:addr(3),readCampaign:async()=>{},send:async()=>{throw Error('No jobs');}};}});await worker.tick();await worker.stop();
 assert.deepEqual(leases[0].jobClasses,['fee-setup']);assert.ok(reads.every(x=>x.lane==='provisioning'));
 for(const patch of [{programVersion:2},{feeOperator:null}])assert.throws(()=>validateWorkerConfig({...c,...patch}),/explicit v3/);
});

test('hosted worker mode: verified release only, no loopback or credential-bearing endpoints, private-network signer allowed',async()=>{
 const {releaseFixture}=await import('../hosted/release-manifest.test.mjs');
 const {readFileSync}=await import('node:fs');const {createHash}=await import('node:crypto');
 const presets=readFileSync(new URL('../../deployment/presets/public-presets-v1.json',import.meta.url));
 const fx=releaseFixture({presets,schema:REGISTRY_SCHEMA_VERSION});
 const hosted=()=>({mode:'hosted',lane:'recovery',programVersion:3,receiptBatchSize:8,genesisHash:addr(1),programId:addr(2),concurrency:2,rpcUrl:'https://rpc.example.test/v1',release:fx.manifest,signer:{url:'http://kids-signer.railway.internal:4176',token:'synthetic-hosted-test-token'.padEnd(40,'x'),publicKey:addr(3)},rpcAdmission:{resource:'rpc-hosted',policy},signerAdmission:{resource:'signer-hosted',policy}});
 assert.equal(validateWorkerConfig(hosted()).release.network,'mainnet');
 assert.throws(()=>validateWorkerConfig({...hosted(),rpcUrl:'http://127.0.0.1:8899'}),/loopback/);
 assert.throws(()=>validateWorkerConfig({...hosted(),rpcUrl:'https://user:key@rpc.example.test/'}),/credentials/);
 assert.throws(()=>validateWorkerConfig({...hosted(),rpcUrl:'http://rpc.example.test/'}),/https or a private-network/);
 assert.throws(()=>validateWorkerConfig({...hosted(),signer:{...hosted().signer,url:'http://127.0.0.1:4176'}}),/loopback/);
 assert.throws(()=>validateWorkerConfig({...hosted(),programVersion:2}),/match its release/);
 assert.throws(()=>validateWorkerConfig({...hosted(),genesisHash:addr(4)}),/match its release/);
 assert.throws(()=>validateWorkerConfig({...hosted(),release:{...fx.manifest,network:'localnet'}}),/mainnet or devnet/);
 assert.equal(validateWorkerConfig({...hosted(),signer:{...hosted().signer,url:'https://signer.example.test'}}).mode,'hosted');
 // Startup verifies the whole release against the ledger before leasing anything.
 const b64=b=>Buffer.from(b).toString('base64');
 const rpc=(accounts)=>async(_url,init)=>{const p=JSON.parse(init.body);let result;
  if(p.method==='getGenesisHash')result=addr(1);
  else if(p.method==='getAccountInfo'){const a=accounts.get(p.params[0]);result={context:{slot:1},value:a?{data:[b64(a.data),'base64'],executable:a.executable,lamports:1,owner:addr(5),rentEpoch:0,space:a.data.length}:null};}
  else result={context:{slot:1},value:null};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:p.id,result}),{headers:{'content-type':'application/json'}});};
 const registry={driver:'postgres',operatorPackets:Object.fromEntries(['latest','prepare','sign','progress'].map(k=>[k,()=>{throw Error('unexpected packet write');}])),schemaVersion:async()=>REGISTRY_SCHEMA_VERSION,admission:{async consume(){return {allowed:true,retryAfterMs:0};}},jobs:{async leaseNext(){return null;}}};
 const worker=await createPublicWorker({config:hosted(),registry,fetchImpl:rpc(fx.accounts)});assert.equal(worker.status().mode,'hosted');await worker.stop();
 const tampered=new Map(fx.accounts);tampered.set(fx.programData.toBase58(),{executable:false,data:Buffer.concat([Buffer.alloc(45,1),Buffer.from('other'),Buffer.alloc(8,0)])});
 await assert.rejects(createPublicWorker({config:hosted(),registry,fetchImpl:rpc(tampered)}),e=>e.code==='RELEASE_MISMATCH'&&e.check==='binary');
 await assert.rejects(createPublicWorker({config:hosted(),registry:{...registry,schemaVersion:async()=>REGISTRY_SCHEMA_VERSION},fetchImpl:rpc(new Map([...fx.accounts].filter(([k])=>k!==addr(7))))}),e=>e.code==='RELEASE_MISMATCH'&&e.check==='amm-config');
});
