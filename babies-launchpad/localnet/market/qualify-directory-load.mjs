// Opt-in read qualification against a retained owned scale fixture. No signing,
// deployment, public RPC or per-viewer chain reads. This measures HTTP clients,
// not wallet signing UX or geographically distributed browser sessions.
import assert from 'node:assert/strict';
import httpClient from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {join,isAbsolute} from 'node:path';import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createPublicMarketWorker} from './public-service.mjs';
import {createPublicCampaignStore} from './public-campaign-store.mjs';
import {campaignsPlugin} from '../../interaction-review/server/campaigns-plugin.mjs';
import {createApiServer} from '../../interaction-review/server/runtime.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function readLoadParameters({clients=1000,rounds=3}={}){
 if(!Number.isInteger(clients)||clients<1||clients>1000||!Number.isInteger(rounds)||rounds<1||rounds>10)throw Error('Read load requires 1..1000 clients and 1..10 rounds');return {clients,rounds};
}
export async function qualifyDirectoryLoad({postgresUrl,directory,clients=1000,rounds=3}){
 ({clients,rounds}=readLoadParameters({clients,rounds}));
 if(!postgresUrl?.startsWith('postgresql:///kids_registry_test?')||!isAbsolute(directory??'')||!directory.split('/').at(-1).startsWith('kids-fleet-'))throw Error('Owned retained fleet and test database required');
 const scope=JSON.parse(readFileSync(join(directory,'scope.json'))),manifest=JSON.parse(readFileSync(new URL('../.runtime/kids-scale-v3-program.json',import.meta.url)));
 assert.equal(scope.rpcUrl,'http://127.0.0.1:19499');assert.equal(scope.genesisHash,manifest.genesisHash);assert.equal(scope.programId,manifest.programId);assert.match(scope.schema,/^kids_test_[a-f0-9]{32}$/);assert.equal(manifest.scaleQualification,true);
 const pool=new pg.Pool({connectionString:postgresUrl,max:8,options:'-c search_path='+scope.schema}),registry=new PostgresRegistry({pool});let worker,http,serving;let rpcCalls=0;const agent=new httpClient.Agent({keepAlive:true,maxSockets:64,maxFreeSockets:64});
 const fetchImpl=async(...args)=>{rpcCalls++;return fetch(...args);};
 try{
  const records=JSON.parse(readFileSync(join(directory,'campaigns.json'))),ids=records.map(r=>({genesisHash:scope.genesisHash,programId:scope.programId,campaign:r.campaign}));assert.equal(ids.length,scope.campaigns);
  // Independent service allocations: financial 180, interactive 30, signer 30
  // and indexing 30 RPC/s. Test-driver verification probes are separate. This
  // local experiment is not a qualified hosted provider quota.
  const policy={ratePerSecond:30,burst:30,lanes:{indexing:{ratePerSecond:30,burst:30}}};
  worker=await createPublicMarketWorker({registry,fetchImpl,config:{mode:'localnet-rehearsal',programVersion:3,lane:'indexing',genesisHash:scope.genesisHash,programId:scope.programId,rpcUrl:scope.rpcUrl,concurrency:4,rpcAdmission:{resource:'fleet-directory-read',policy}}});
  const registered=(await registry.query('SELECT campaign FROM campaigns WHERE genesis_hash=? AND program_id=?',[scope.genesisHash,scope.programId])).rows;
  const indexedCampaigns=registered.length;assert.ok(indexedCampaigns>=ids.length&&indexedCampaigns<=500);
  for(const row of registered)await registry.jobs.enqueue({genesisHash:scope.genesisHash,programId:scope.programId,campaign:row.campaign,jobClass:'campaign-index',operationKey:'campaign:0'});
  const indexStart=Number((await registry.query('SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms')).rows[0].ms);
  serving=worker.start();serving.catch(()=>{});const store=createPublicCampaignStore(registry),until=Date.now()+120000;
  for(;;){const rows=(await registry.query('SELECT count(*) n FROM public_campaign_snapshots WHERE genesis=? AND program_id=? AND updated_at>=?',[scope.genesisHash,scope.programId,indexStart])).rows;if(Number(rows[0].n)===indexedCampaigns)break;if(Date.now()>until)throw Error('Indexing did not cover the retained fleet');await pause(500);}
  await worker.stop();await serving;worker=null;
  const token=randomBytes(32).toString('hex');let sharedReads=0;
  http=createApiServer({plugins:[campaignsPlugin({registry,authorize:req=>req.headers.authorization==='Bearer '+token,readView:async row=>{sharedReads++;return store.read(row);}})],probe:async()=>true,probeInterval:60000});await new Promise(r=>http.server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+http.server.address().port,headers={authorization:'Bearer '+token};
  assert.equal((await fetch(origin+'/api/campaigns')).status,403);
  const paths=[];let cursor=null;
  do{const path='/api/campaigns?limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):'');paths.push(path);const res=await fetch(origin+path,{headers}),body=await res.json();assert.equal(res.status,200);assert.ok(body.campaigns.length);for(const row of body.campaigns){assert.equal(row.view?.source.commitment,'finalized');assert.equal(row.view.terms.fee.totalBps,250);}cursor=body.nextCursor;}while(cursor);
  const pooled=path=>new Promise((resolve,reject)=>{
   const request=httpClient.get(origin+path,{headers,agent},res=>{const chunks=[];let bytes=0;res.on('data',chunk=>{bytes+=chunk.length;if(bytes>2000000){res.destroy();reject(Error('Oversized load response'));}else chunks.push(chunk);});res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))});}catch(e){reject(e);}});});
   const timer=setTimeout(()=>request.destroy(Error('Read load deadline exceeded')),15000);request.once('close',()=>clearTimeout(timer));request.on('error',reject);
  });
  const baselineRpc=rpcCalls,metrics=[];
  for(let round=0;round<rounds;round++){
   const outcomes=await Promise.allSettled(Array.from({length:clients},async(_,i)=>{const start=performance.now(),res=await pooled(paths[i%paths.length]),body=res.body;assert.equal(res.status,200);assert.ok(body.campaigns.length);assert.ok(body.campaigns.every(row=>row.view?.source.commitment==='finalized'));return performance.now()-start;}));
   const samples=outcomes.filter(x=>x.status==='fulfilled').map(x=>x.value).sort((a,b)=>a-b),failures={};for(const x of outcomes.filter(x=>x.status==='rejected')){const code=x.reason?.cause?.code||x.reason?.code||x.reason?.name||'unknown';failures[code]=(failures[code]||0)+1;}
   const percentile=p=>samples.length?Math.round(samples[Math.ceil(p*samples.length)-1]):null;metrics.push({round:round+1,requests:clients,successful:samples.length,failures,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),maxMs:samples.length?Math.round(samples.at(-1)):null});
  }
  assert.equal(rpcCalls,baselineRpc,'HTTP clients must never multiply RPC');
  const report={network:'isolated-localnet',campaigns:indexedCampaigns,clients,rounds,requests:clients*rounds,upstreamConnections:64,latencyIncludesClientQueue:true,metrics,sharedReads,viewerRpcCalls:rpcCalls-baselineRpc,authentication:'local service-token boundary; not external wallet UX',cache:'warm campaign views; real PostgreSQL directory queries',transportPassed:metrics.every(x=>x.successful===clients),latencyTargetMet:metrics.every(x=>x.p95Ms!==null&&x.p95Ms<1000),passed:metrics.every(x=>x.successful===clients&&x.p95Ms!==null&&x.p95Ms<1000),hostedActivation:false};writeFileSync(join(directory,'directory-load-'+randomUUID()+'.json'),JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});return report;
 }finally{agent.destroy();await http?.shutdown();await worker?.stop();if(serving)await serving.catch(()=>{});await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyDirectoryLoad({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,directory:process.env.KIDS_FLEET_RESUME}).then(r=>{console.log(JSON.stringify(r));if(!r.passed)process.exitCode=1;}).catch(e=>{console.error(e.stack);process.exitCode=1;});
