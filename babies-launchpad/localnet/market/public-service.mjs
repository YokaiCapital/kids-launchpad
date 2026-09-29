import {waitForRpcAdmission} from '../rpc-transport.mjs';
import {createHealthListener,healthPort} from '../hosted/health-listener.mjs';
import {ensureSchema} from '../hosted/schema-boot.mjs';
import {createWorkerPresence} from '../jobs/presence.mjs';
import {laneClasses} from '../jobs/lanes.mjs';
import {createPublicCampaignStore} from './public-campaign-store.mjs';
import {createCampaignIndexHandler} from './public-campaign-ingest.mjs';
import {createPublicPositionStore} from './public-position-store.mjs';
import {createPositionIndexHandler} from './public-position-ingest.mjs';
import {createPublicActivityStore} from './public-activity-store.mjs';
import {createPublicActivityHandlers} from './public-activity-ingest.mjs';
import {publicIssuerVersion} from '../registry/issuer-version.mjs';
import {endpointUrl} from '../jobs/service.mjs';
import {parseReleaseManifest,verifyReleaseManifest,loadReleaseManifest} from '../hosted/release-manifest.mjs';
// Standalone new-version market workers; no API/plugin, wallet signer or legacy timers.
import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry,REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
import {createJobRunner} from '../jobs/runner.mjs';import {createAdmissionGuard} from '../jobs/admission.mjs';
import {createRpcClient} from './rpc.mjs';import {createPublicMarketStore} from './public-store.mjs';
import {createPublicMarketHandlers} from './public-ingest.mjs';import * as client from '../protocol-v2/client.mjs';
import {createFeeIndexHandler} from './public-fee-ingest.mjs';
import {projectStandardFees} from './public-fees.mjs';
import {priceScaled} from './decode.mjs';
export function validateMarketConfig(c){
 if(!['localnet-rehearsal','hosted'].includes(c?.mode)||!['indexing','backfill'].includes(c.lane))throw Error('Market workers limited to localnet rehearsal lanes or a verified hosted release');
 if(c.mode==='localnet-rehearsal'){const u=new URL(c.rpcUrl);if(!['http:','https:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password)throw Error('Rehearsal RPC must be loopback');}
 else endpointUrl(c.rpcUrl,{mode:'hosted',role:'RPC'});
 if(!Number.isInteger(c.concurrency)||c.concurrency<1||c.concurrency>8)throw Error('Invalid market concurrency');
 const scope={genesisHash:new PublicKey(c.genesisHash).toBase58(),programId:new PublicKey(c.programId).toBase58(),campaignVersion:publicIssuerVersion(c.programVersion)};
 let release=null;
 if(c.mode==='hosted'){
  // A hosted indexer serves exactly one verified release, the same rule as the hosted keeper workers.
  release=parseReleaseManifest(c.release);
  if(scope.campaignVersion!==3||release.genesisHash!==scope.genesisHash||release.programId!==scope.programId)throw Error('Hosted market worker scope must match its release manifest');
 }
 return {...c,scope,release};
}
export async function createPublicMarketWorker({registry,config,fetchImpl=globalThis.fetch,log=()=>{}}){
 const c=validateMarketConfig(config);
 if(registry?.driver!=='postgres'||await registry.schemaVersion()!==REGISTRY_SCHEMA_VERSION)throw Error('Market worker requires current shared schema');
 const admit=createAdmissionGuard({...c.rpcAdmission,registry,lane:c.lane});
 const upstream=createRpcClient({url:c.rpcUrl,fetchImpl,maxAttempts:1,timeoutMs:8000,deadlineMs:8000});
 const rpc={async call(method,params){await waitForRpcAdmission(admit,{waitMs:c.scope.campaignVersion===3?1000:0});try{return await upstream.call(method,params);}catch(e){if(e.category==='exhausted')throw Object.assign(Error('Market upstream unavailable'),{code:'RPC_UNAVAILABLE'});throw e;}}};
 if(await rpc.call('getGenesisHash',[])!==c.scope.genesisHash)throw Error('Market RPC genesis mismatch');
 const program=new PublicKey(c.scope.programId);
 const deployed=await rpc.call('getAccountInfo',[c.scope.programId,{encoding:'base64',commitment:'finalized'}]);
 if(!deployed?.value?.executable)throw Error('Market program unavailable');
 // A hosted indexer proves the whole release before leasing any job, through the same bounded RPC channel.
 if(c.release){
  const connection={getGenesisHash:()=>rpc.call('getGenesisHash',[]),getAccountInfo:async(key,commitment)=>{const r=await rpc.call('getAccountInfo',[String(key),{encoding:'base64',commitment:commitment||'finalized'}]);return r?.value?{executable:!!r.value.executable,data:Buffer.from(r.value.data?.[0]||'','base64')}:null;}};
  await verifyReleaseManifest(c.release,{connection,presetsBytes:readFileSync(new URL('../../'+c.release.presets.file,import.meta.url)),registrySchemaVersion:await registry.schemaVersion()});
 }
 async function resolveIdentity(id){
  if(id.genesisHash!==c.scope.genesisHash||id.programId!==c.scope.programId)throw Error('Market campaign scope mismatch');
  const withFees=c.scope.campaignVersion===3;
  const batch=withFees?await rpc.call('getMultipleAccounts',[[id.campaign,client.feeStateAddress(program,id.campaign).toBase58()],{encoding:'base64',commitment:'finalized'}]):null;
  if(withFees&&(!Array.isArray(batch?.value)||batch.value.length!==2||!Number.isSafeInteger(batch.context?.slot)||batch.context.slot<1))throw Error('Consistent campaign and fee observation unavailable');
  const result=withFees?{context:batch.context,value:batch.value[0]}:await rpc.call('getAccountInfo',[id.campaign,{encoding:'base64',commitment:'finalized'}]);
  if(result?.value?.owner!==c.scope.programId||result.value.data?.[1]!=='base64')throw Error('Market campaign unavailable');
  const {terms,state,split}=client.decodeCampaign(Buffer.from(result.value.data[0],'base64'));
  if(state.phase!==3)throw Error('Market campaign is not live');
  if(terms.genesis!==client.keyHex(c.scope.genesisHash)||client.campaignAddress(program,terms.creator,terms.nonce).toBase58()!==id.campaign||!terms.ammProgram.equals(client.RAYDIUM_CPMM))throw Error('Market campaign identity mismatch');
  const a=client.cpmmAddresses(terms.ammProgram,terms.ammConfig,terms.childMint);
  if(!state.pool.equals(a.pool))throw Error('Market pool mismatch');
  if(split.liquidity<=0n||state.settledAccepted<=0n)throw Error('Market opening reserves unavailable');
  const market={genesis:c.scope.genesisHash,programId:c.scope.programId,campaign:id.campaign,pool:a.pool.toBase58(),mint:terms.childMint.toBase58(),coinDecimals:terms.decimals,launchTime:Number(state.launchTime),openingPriceScaled:priceScaled(state.settledAccepted,split.liquidity,terms.decimals),verifiedSlot:result.context.slot};
  let fees=null;
  if(withFees){
   if(terms.mode!==0)throw Error('Public v3 market requires Standard terms');
   try{fees=projectStandardFees({account:batch.value[1],programId:program,campaign:id.campaign,terms,slot:result.context.slot});}
   catch{fees={status:'unavailable',slot:result.context.slot};}
  }
  return {fees,pool:a.pool.toBase58(),authority:a.authority.toBase58(),vault0:a.vault0.toBase58(),vault1:a.vault1.toBase58(),mint0:a.mint0.toBase58(),mint1:a.mint1.toBase58(),decimals0:a.mint0.equals(client.WSOL)?9:terms.decimals,decimals1:a.mint1.equals(client.WSOL)?9:terms.decimals,market};
 }
 async function resolveActivity(id){
  if(c.scope.campaignVersion!==3||id.genesisHash!==c.scope.genesisHash||id.programId!==c.scope.programId)throw Error('Activity scope mismatch');
  const result=await rpc.call('getAccountInfo',[id.campaign,{encoding:'base64',commitment:'finalized'}]);
  if(result?.value?.owner!==c.scope.programId||result.value.executable||result.value.data?.[1]!=='base64')throw Error('Activity campaign unavailable');
  const {terms}=client.decodeCampaign(Buffer.from(result.value.data[0],'base64'));
  if(terms.mode!==0||terms.genesis!==client.keyHex(c.scope.genesisHash)||String(client.campaignAddress(program,terms.creator,terms.nonce))!==id.campaign)throw Error('Activity campaign identity mismatch');
  return {genesisHash:c.scope.genesisHash,launchProgram:c.scope.programId,campaign:id.campaign,mint:String(terms.childMint),coinDecimals:terms.decimals,programVersion:3,mode:'standard'};
 }
 const store=createPublicMarketStore(registry),handlers={...createPublicMarketHandlers({store,rpc,resolveIdentity}),...(c.scope.campaignVersion===3?{'campaign-index':createCampaignIndexHandler({store:createPublicCampaignStore(registry),rpc,genesisHash:c.scope.genesisHash,programId:c.scope.programId,programVersion:3}),'position-index':createPositionIndexHandler({store:createPublicPositionStore(registry),rpc,genesisHash:c.scope.genesisHash,programId:c.scope.programId,programVersion:3}),'fee-index':createFeeIndexHandler({store,rpc,resolveIdentity}),...createPublicActivityHandlers({store:createPublicActivityStore(registry),rpc,resolveIdentity:resolveActivity})}:{})};
 const servedClasses=laneClasses(c.lane).filter(name=>Object.hasOwn(handlers,name));
 const runner=createJobRunner({registry,handlers,owner:c.owner||'market-'+randomUUID(),lane:c.lane,servedClasses,scope:c.scope,concurrency:c.concurrency,log});
 let running=null,stopped=false,presence=null;
 return {store,status:()=>({lane:c.lane,active:runner.active(),scope:c.scope,commitment:'finalized'}),tick:()=>runner.tick(),start(){if(running||stopped)throw Error('Market worker already started or stopped');return running=(async()=>{presence=createWorkerPresence({registry,scope:c.scope,lane:c.lane,classes:servedClasses,capacity:c.concurrency,health:runner.health,log});try{await presence.start();await runner.serve();}finally{runner.stop();await runner.drain();await presence.stop();}})();},async stop(){stopped=true;runner.stop();if(running)await running;await runner.drain();}};
}
export async function main(env=process.env){
 if(!env.KIDS_MARKET_WORKER_CONFIG)throw Error('Market worker config required');
 const raw=JSON.parse(readFileSync(env.KIDS_MARKET_WORKER_CONFIG,'utf8'));
 if(raw.mode==='hosted'){
  // Provider endpoints and the release manifest come from the environment: a config file never carries a provider key.
  if(raw.rpcUrl!==undefined||raw.release!==undefined)throw Error('Hosted RPC endpoint and release manifest come from the environment, not the config file');
  if(!env.KIDS_RPC_URL||!env.KIDS_RELEASE_MANIFEST)throw Error('KIDS_RPC_URL and KIDS_RELEASE_MANIFEST are required for a hosted market worker');
  raw.rpcUrl=env.KIDS_RPC_URL;raw.release=loadReleaseManifest(env.KIDS_RELEASE_MANIFEST);
 }
 const config=validateMarketConfig(raw);
 const registry=new PostgresRegistry({connectionString:env.KIDS_REGISTRY_URL,max:4});let worker,health=null,started=false,stopping=false;
 try{
  const log=event=>console.log(JSON.stringify(event));
  // The platform healthcheck and the private network reach /healthz and /readyz on PORT (hosted services set it); the
  // listener is up before the schema wait, so the platform sees a live process that is not ready yet.
  const port=healthPort(env);
  if(port!==null){health=createHealthListener({role:'indexer',ready:()=>started&&!stopping});await health.listen(port);log({event:'health-listening',port});}
  if(raw.mode==='hosted')await ensureSchema({registry,env,log});
  worker=await createPublicMarketWorker({registry,config,log});
  const stop=()=>{stopping=true;return worker.stop().catch(()=>{process.exitCode=1;});};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{const running=worker.start();started=true;await running;}finally{stopping=true;process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await worker.stop();}
 }finally{await health?.close();await registry.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error(JSON.stringify({event:'market-worker-start-failed'}));process.exitCode=1;});
