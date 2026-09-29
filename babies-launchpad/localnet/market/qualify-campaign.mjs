import {campaignsPlugin} from '../../interaction-review/server/campaigns-plugin.mjs';
import {createApiServer} from '../../interaction-review/server/runtime.mjs';
// Read-only finalized directory qualification; no per-visitor RPC fan-out.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';import pg from 'pg';
import {Connection,PublicKey} from '@solana/web3.js';import {boundedRpcFetch} from '../rpc-transport.mjs';import {PostgresRegistry} from '../registry/registry.mjs';import * as client from '../protocol-v2/client.mjs';
import {createPublicMarketWorker} from './public-service.mjs';import {createPublicCampaignStore} from './public-campaign-store.mjs';
export async function qualifyCampaign({postgresUrl,campaign}){
 if(!postgresUrl||!campaign)throw Error('Explicit local test database and campaign required');const m=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v3-program.json',import.meta.url),'utf8'));
 if(m.network!=='localnet'||m.programVersion!==3||m.rpcUrl!=='http://127.0.0.1:19199')throw Error('Owned local v3 validator required');
 const connection=new Connection(m.rpcUrl,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:boundedRpcFetch({timeoutMs:8000})});assert.equal(await connection.getGenesisHash(),m.genesisHash);
 campaign=new PublicKey(campaign).toBase58();const info=await connection.getAccountInfo(new PublicKey(campaign),'finalized');assert.equal(String(info.owner),m.programId);const {terms,state}=client.decodeCampaign(info.data);assert.equal(terms.mode,0);
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1});let pool,worker,http;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:postgresUrl,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();const id={genesisHash:m.genesisHash,programId:m.programId,campaign};
  await registry.campaigns.upsert({...id,mode:'standard',campaignVersion:3,registryStatus:'planned',termsHash:state.termsHash});
  const config={mode:'localnet-rehearsal',programVersion:3,lane:'indexing',...id,rpcUrl:m.rpcUrl,concurrency:1,rpcAdmission:{resource:'campaign-qualification',policy:{ratePerSecond:50,burst:50,lanes:{indexing:{ratePerSecond:50,burst:50}}}}};
  worker=await createPublicMarketWorker({registry,config});await registry.jobs.enqueue({...id,jobClass:'campaign-index',operationKey:'campaign:0'});
  const store=createPublicCampaignStore(registry);let result;const deadline=Date.now()+30000;
  while(Date.now()<deadline){await worker.tick();result=await store.snapshot(id);if(result.body)break;await new Promise(r=>setTimeout(r,250));}
  assert.ok(result.body,JSON.stringify((await registry.jobs.listForCampaign(id)).map(j=>({state:j.state,result:j.result}))));
  const view=await store.read(id);assert.equal(view.available,true);assert.equal(view.source.commitment,'finalized');assert.equal(view.totals.totalLamports,String(state.total));assert.equal(view.pool,String(state.pool));assert.ok(view.terms.tradeFeeBps>0);
  await worker.stop();worker=null;assert.deepEqual(await createPublicCampaignStore(registry).read(id),view);assert.equal((await registry.campaigns.list({status:view.phase})).campaigns.length,1);
  http=createApiServer({plugins:[campaignsPlugin({registry,readView:row=>store.read(row),authorize:()=>true})],probe:async()=>true,probeInterval:60000});await new Promise(resolve=>http.server.listen(0,'127.0.0.1',resolve));
  const response=await fetch('http://127.0.0.1:'+http.server.address().port+'/api/campaigns?status='+view.phase),page=await response.json();assert.equal(response.status,200);assert.equal(page.campaigns.length,1);assert.equal(page.campaigns[0].view.totals.committedLamports,String(state.total));assert.equal(page.campaigns[0].view.source.commitment,'finalized');
  return {network:'localnet',...id,slot:view.source.slot,phase:view.phase,committedLamports:view.totals.totalLamports,actualTradeFeeBps:view.terms.tradeFeeBps,serviceRestart:true,sharedRead:true,httpDirectory:true,signing:false,hostedActivation:false};
 }finally{await http?.shutdown();await worker?.stop();if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyCampaign({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,campaign:process.argv[2]}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(String(e.message));process.exitCode=1;});
