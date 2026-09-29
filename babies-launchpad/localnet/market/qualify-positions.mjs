// Read-only finalized receipt discovery, independent of website request history.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';import pg from 'pg';
import {Connection,PublicKey} from '@solana/web3.js';import {boundedRpcFetch} from '../rpc-transport.mjs';import {PostgresRegistry} from '../registry/registry.mjs';import * as client from '../protocol-v2/client.mjs';
import {createPublicMarketWorker} from './public-service.mjs';import {createPublicPositionStore} from './public-position-store.mjs';
export async function qualifyPositions({postgresUrl,campaign}){
 if(!postgresUrl||!campaign)throw Error('Explicit local test database and campaign required');const m=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v3-program.json',import.meta.url),'utf8'));
 if(m.network!=='localnet'||m.programVersion!==3||m.rpcUrl!=='http://127.0.0.1:19199')throw Error('Owned local v3 validator required');
 const connection=new Connection(m.rpcUrl,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:boundedRpcFetch({timeoutMs:8000})});assert.equal(await connection.getGenesisHash(),m.genesisHash);
 campaign=new PublicKey(campaign).toBase58();const info=await connection.getAccountInfo(new PublicKey(campaign),'finalized');assert.equal(String(info.owner),m.programId);const {terms,state}=client.decodeCampaign(info.data);assert.equal(terms.mode,0);
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1});let pool,worker;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:postgresUrl,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();const id={genesisHash:m.genesisHash,programId:m.programId,campaign};
  await registry.campaigns.upsert({...id,mode:'standard',campaignVersion:3,registryStatus:'planned',termsHash:state.termsHash});
  const config={mode:'localnet-rehearsal',programVersion:3,lane:'indexing',...id,rpcUrl:m.rpcUrl,concurrency:1,rpcAdmission:{resource:'position-qualification',policy:{ratePerSecond:50,burst:50,lanes:{indexing:{ratePerSecond:50,burst:50}}}}};
  worker=await createPublicMarketWorker({registry,config});await registry.jobs.enqueue({...id,jobClass:'position-index',operationKey:'positions:0'});
  const store=createPublicPositionStore(registry);let result;const deadline=Date.now()+30000;
  while(Date.now()<deadline){await worker.tick();result=await store.snapshot(id);if(result.body)break;await new Promise(r=>setTimeout(r,250));}
  assert.ok(result.body,JSON.stringify((await registry.jobs.listForCampaign(id)).map(j=>({state:j.state,result:j.result}))));assert.equal(result.body.count,Number(state.receiptCount));
  const discovered=await store.discover({...id,owner:m.pilotCreator});assert.equal(discovered.coverage.complete,true);assert.ok(discovered.campaignIds.includes([id.genesisHash,id.programId,id.campaign].join(':')));
  await worker.stop();worker=null;const fresh=createPublicPositionStore(registry);assert.deepEqual((await fresh.discover({...id,owner:m.pilotCreator})).campaignIds,discovered.campaignIds);
  return {network:'localnet',...id,receipts:result.body.count,slot:result.body.slot,coverage:discovered.coverage,serviceRestart:true,websiteHistoryRequired:false,signing:false,hostedActivation:false};
 }finally{await worker?.stop();if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyPositions({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,campaign:process.argv[2]}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(String(e.message));process.exitCode=1;});
