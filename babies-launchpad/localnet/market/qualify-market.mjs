// Read-only owned-validator qualification against a launched v3 campaign.
// No wallets, signing keys or funds; all database writes use a disposable schema.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';
import pg from 'pg';import {Connection,PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import * as client from '../protocol-v2/client.mjs';
import {createPublicMarketWorker} from './public-service.mjs';
import {createPublicMarketReader} from './public-reader.mjs';
import {createPublicMarketStore} from './public-store.mjs';
export async function qualifyMarket({postgresUrl,campaign,expectedTrade}){
 if(!postgresUrl||!expectedTrade)throw Error('Explicit local database, campaign and expected trade required');
 campaign=new PublicKey(campaign).toBase58();
 const m=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v3-program.json',import.meta.url),'utf8'));
 if(m.network!=='localnet'||m.programVersion!==3||m.rpcUrl!=='http://127.0.0.1:19199')throw Error('Owned v3 local validator required');
 const connection=new Connection(m.rpcUrl,'finalized');assert.equal(await connection.getGenesisHash(),m.genesisHash);
 const info=await connection.getAccountInfo(new PublicKey(campaign),'finalized');assert.equal(String(info.owner),m.programId);
 const decoded=client.decodeCampaign(info.data);assert.equal(decoded.state.phase,3);
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1});let pool;const workers=[];
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:postgresUrl,max:6,options:`-c search_path=${schema}`});
  const registry=new PostgresRegistry({pool});await registry.migrate();const identity={genesisHash:m.genesisHash,programId:m.programId,campaign};
  await registry.campaigns.upsert({...identity,network:'localnet',mode:'standard',campaignVersion:3,registryStatus:'planned',termsHash:decoded.state.termsHash});
  const policy={ratePerSecond:100,burst:100,lanes:{indexing:{ratePerSecond:50,burst:50},backfill:{ratePerSecond:50,burst:50}}};
  const config=lane=>({mode:'localnet-rehearsal',programVersion:3,lane,genesisHash:m.genesisHash,programId:m.programId,rpcUrl:m.rpcUrl,concurrency:1,rpcAdmission:{resource:'qualified-market-rpc',policy}});
  for(const lane of ['indexing','backfill'])workers.push(await createPublicMarketWorker({registry,config:config(lane)}));
  await registry.jobs.enqueue({...identity,jobClass:'market-index',operationKey:'market-live:0'});
  const store=createPublicMarketStore(registry),reader=createPublicMarketReader({store,...identity,cacheMs:0});let trades,candles;
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){
   await Promise.all(workers.map(w=>w.tick()));trades=await reader.read({campaign,limit:100});
   const failed=(await registry.jobs.listForCampaign(identity)).find(j=>j.state==='failed');if(failed)throw Error('Indexing failed: '+JSON.stringify(failed.result));
   if(trades.available&&trades.coverage.complete&&trades.trades.some(t=>t.signature===expectedTrade))break;
   await new Promise(r=>setTimeout(r,500));
  }
  assert.equal(trades.status,'live');assert.ok(trades.trades.some(t=>t.signature===expectedTrade));assert.equal(trades.coverage.complete,true);
  const to=Math.ceil(Date.now()/60000)*60,from=Math.max(0,Math.floor(Number(decoded.state.launchTime)/60)*60);
  candles=await reader.read({campaign,kind:'candles',interval:'1m',from,to});assert.ok(candles.candles.length>0);
  const before=trades.trades.length;await workers[0].stop();workers[0]=await createPublicMarketWorker({registry,config:config('indexing')});await workers[0].tick();
  assert.equal((await reader.read({campaign,limit:100})).trades.length,before);
  return {network:'localnet',...identity,pool:trades.pool,trades:before,candles:candles.candles.length,expectedTradeIndexed:true,openingReferenceIsTrade:trades.openingReference.isTrade,complete:true,restartDuplicates:0,browserRpc:false,hostedActivation:false};
 }finally{await Promise.all(workers.map(w=>w.stop()));if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyMarket({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,campaign:process.env.KIDS_TEST_MARKET_CAMPAIGN,expectedTrade:process.env.KIDS_TEST_MARKET_TRADE}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});
