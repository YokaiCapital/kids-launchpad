import {createWorkerPresence} from './presence.mjs';
import {createHealthListener,healthPort} from '../hosted/health-listener.mjs';
import {ensureSchema} from '../hosted/schema-boot.mjs';
import {publicIssuerVersion} from '../registry/issuer-version.mjs';
// Independent LOCAL rehearsal process for qualified v2/v3 lifecycle, refunds, fees,
// and explicitly scoped v3 fee-setup/accounting handlers.
// It never imports the API plugin or starts legacy keepers/indexers. Production
// activation needs separate release evidence; this entry point rejects other modes.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Connection,PublicKey} from '@solana/web3.js';
import {PostgresRegistry,REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
import {createRemoteSigner} from '../operator-signer.mjs';
import {boundedRpcFetch} from '../rpc-transport.mjs';
import {createChainAdapter} from '../protocol-v2/chain-adapter.mjs';
import {createFeeAdapter} from '../protocol-v2/fee-adapter.mjs';
import {withReceiptBatches} from '../protocol-v3/receipt-batch.mjs';
import {withLiveVerification} from '../protocol-v3/live-verification.mjs';
import {createLifecycleController} from './lifecycle.mjs';
import {createFundingFirstLifecycle} from './lifecycle-funding-first.mjs';
import {launchTable,launchFundingFirst,closeFundingFirst,refundsFundingFirst,accountFundingFirst,collateralReturnFundingFirst,versioned} from './handlers-funding-first.mjs';
import {createPublicationReadiness} from '../creation/publication-readiness.mjs';
import {readLookupTablePlan,allocateLookupTablePlan,markLookupTablePlan} from './lookup-table-plan.mjs';
import {createCustodyClient} from '../mints/custody-client.mjs';
import {fundingFirstBuild} from '../hosted/funding-first-builds.mjs';
import {feeHandler} from './fee-handlers.mjs';
import {createFeeActivation,feeActivationPolicy} from './fee-activation.mjs';
import {createAdmissionGuard} from './admission.mjs';
import {createJobRunner} from './runner.mjs';
import {settleReceipts,refundReceipts,launch,launchAssertReady} from './handlers.mjs';
import {createOperatingReconciler,operatingReconcileHandler} from './operating-reconcile.mjs';
import {operatingReturnHandler} from './operating-return.mjs';
import {operatingRefillHandler} from './operating-refill.mjs';
import {readPresets} from '../registry/presets.mjs';
import {createFeeSetupAdapter,feeSetupHandler} from '../protocol-v3/fee-setup.mjs';
import {parseReleaseManifest,verifyReleaseManifest,loadReleaseManifest} from '../hosted/release-manifest.mjs';
const classes=Object.freeze({provisioning:['fee-setup'],lifecycle:['launch','settlement'],recovery:['refunds','operating-return'],accounting:['operating-reconcile','operating-refill'],harvest:['fee-harvest'],economics:['distribution','token-burn']});
export const WORKER_MODES=Object.freeze(['localnet-rehearsal','hosted']);
const LOOPBACK=Object.freeze(['localhost','127.0.0.1','[::1]']);
// Rehearsal endpoints are loopback only. Hosted endpoints are never loopback, never carry credentials in the URL, and
// use https unless they sit on the private service network (Railway internal hostnames).
export function endpointUrl(value,{mode='localnet-rehearsal',role='endpoint'}={}){
 let u;try{u=new URL(value);}catch{throw Error(role+' endpoint is not a URL');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error(mode==='hosted'?'Hosted '+role+' endpoint must be http(s) without embedded credentials':'Rehearsal endpoint must be loopback');
 const loopback=LOOPBACK.includes(u.hostname);
 if(mode!=='hosted'){if(!loopback)throw Error('Rehearsal endpoint must be loopback');return value;}
 if(loopback)throw Error('Hosted '+role+' endpoint must not be loopback');
 if(u.protocol==='http:'&&!/\.(railway\.internal|internal)$/i.test(u.hostname))throw Error('Hosted '+role+' endpoint must use https or a private-network hostname');
 return value;
}
const localUrl=value=>endpointUrl(value);
export function validateWorkerConfig(c){
 if(!WORKER_MODES.includes(c?.mode))throw Error('Worker activation limited to localnet rehearsal or a verified hosted release');
 if(!Object.hasOwn(classes,c.lane))throw Error('No qualified handler set for this lane');
 const scope={genesisHash:new PublicKey(c.genesisHash).toBase58(),programId:new PublicKey(c.programId).toBase58(),campaignVersion:publicIssuerVersion(c.programVersion)};
 let release=null;
 if(c.mode==='hosted'){
  // A hosted worker serves exactly one verified release: version 3, the manifest's genesis and program, nothing else.
  release=parseReleaseManifest(c.release);
  if(scope.campaignVersion!==3||release.genesisHash!==scope.genesisHash||release.programId!==scope.programId)throw Error('Hosted worker scope must match its release manifest');
 }
 if(c.lane==='provisioning'){if(scope.campaignVersion!==3||!c.feeOperator)throw Error('Fee setup requires explicit v3 operator');new PublicKey(c.feeOperator);}
 if(c.feeActivation!==undefined){
  if(c.lane!=='provisioning'||scope.campaignVersion!==3)throw Error('Fee activation requires v3 provisioning');
  feeActivationPolicy({...c.feeActivation,mode:c.mode,genesisHash:scope.genesisHash,programId:scope.programId,payer:c.signer?.publicKey,treasury:c.release?.treasury??c.feeActivation.treasury??null});
 }
 if(c.lifecycle!==undefined){
  if(c.lane!=='lifecycle'||scope.campaignVersion!==3||c.lifecycle.setupHandoff!==true)throw Error('Lifecycle orchestration requires explicit v3 lifecycle handoff');
  if(c.lifecycle.fundingFirst!==undefined&&typeof c.lifecycle.fundingFirst!=='boolean')throw Error('lifecycle.fundingFirst must be a boolean');
  // A hosted funding-first lifecycle worker reaches the custody endpoint over the private network, never loopback.
  if(c.lifecycle.fundingFirst===true&&c.custody?.url!==undefined)endpointUrl(c.custody.url,{mode:c.mode,role:'custody'});
  if(c.lifecycle.fundingFirst===true&&c.mode==='hosted'&&!fundingFirstBuild(release))throw Error('A funding-first lifecycle worker needs a release whose program build carries the funding-first accounting');
  feeActivationPolicy({...c.lifecycle,mode:c.mode,genesisHash:scope.genesisHash,programId:scope.programId,payer:c.signer?.publicKey,treasury:c.release?.treasury??c.lifecycle.treasury??null});
 }
 const receiptBatchSize=c.receiptBatchSize??1;
 if(!Number.isInteger(receiptBatchSize)||receiptBatchSize<1||receiptBatchSize>8||receiptBatchSize>1&&(scope.campaignVersion!==3||!['lifecycle','recovery'].includes(c.lane)))throw Error('Receipt batching requires v3 lifecycle/recovery and size 1..8');
 if(!Number.isInteger(c.concurrency)||c.concurrency<1||c.concurrency>8)throw Error('Rehearsal concurrency must be 1..8');
 endpointUrl(c.rpcUrl,{mode:c.mode,role:'RPC'});
 if(c.lane==='accounting'){
  if(scope.campaignVersion!==3||!c.operating?.payer||!/^[A-Za-z0-9_.:-]{1,128}$/.test(c.operating.policy??''))throw Error('Accounting requires an explicit v3 payer and policy');
  scope.operatingPayer=new PublicKey(c.operating.payer).toBase58();scope.operatingPolicy=c.operating.policy;
 }else endpointUrl(c.signer?.url,{mode:c.mode,role:'signer'});
 if(!c.rpcAdmission?.resource||c.lane!=='accounting'&&!c.signerAdmission?.resource)throw Error('Explicit shared RPC and signer partitions required');
 return {...c,scope:Object.freeze(scope),receiptBatchSize,release};
}
export async function createPublicWorker({registry,config,fetchImpl=globalThis.fetch,log=()=>{},adapterFactory=createChainAdapter,reconciliationFactory=createOperatingReconciler,custody=null}){
 const c=validateWorkerConfig(config);
 // Funding-first launches need the custody co-signer (the mint inventory's launch signer, in process for a rehearsal or a
 // client of the private custody endpoint): it co-signs the journaled launch packet with the reserved mint and fee NFT.
 if(c.lifecycle?.fundingFirst===true&&typeof custody?.coSign!=='function')throw Error('Funding-first lifecycle needs the custody co-signer');
 if(registry?.driver!=='postgres'||!registry?.operatorPackets)throw Error('Worker requires shared PostgreSQL and operator packet journal');
 // Migrations belong to the release step, not every new autoscaled worker.
 if(await registry.schemaVersion()!==REGISTRY_SCHEMA_VERSION)throw Error('Worker registry schema differs from this release');
 const rpcAdmit=createAdmissionGuard({...c.rpcAdmission,registry,lane:c.lane});
 const connection=new Connection(c.rpcUrl,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:boundedRpcFetch({fetchImpl,admit:rpcAdmit,admissionWaitMs:c.scope.campaignVersion===3?1000:0})});
 // Refuse a mislabeled RPC before leasing even one job.
 if(await connection.getGenesisHash()!==c.scope.genesisHash)throw Error('Worker RPC genesis mismatch');
 const program=await connection.getAccountInfo(new PublicKey(c.scope.programId),'confirmed');
 if(!program?.executable)throw Error('Worker program is not executable on this ledger');
 // A hosted worker proves the whole release before leasing any job: exact program bytes, sealed AMM tier, presets and schema.
 if(c.release)await verifyReleaseManifest(c.release,{connection,presetsBytes:readFileSync(new URL('../../'+c.release.presets.file,import.meta.url)),registrySchemaVersion:await registry.schemaVersion()});
 let handlers,lifecycle=null;
 if(c.lane==='accounting'){
  // The accounting worker reconciles fee-setup rent against the sealed platform treasury (the release's; a rehearsal names it in
  // its operating block), never against its payer.
  const args={registry,connection,genesisHash:c.scope.genesisHash,programId:c.scope.programId,payer:c.scope.operatingPayer,policy:c.scope.operatingPolicy,treasury:c.release?.treasury??c.operating?.treasury??null};
  // Option 1 refill accounting reads the sealed numbers of the presets manifest the release verified (or the lane's
  // explicit override) and only records entitlements; the treasury-signed funding is an operator step.
  const sealed=readPresets().agreed?.operating??{},refill={refillBps:c.operating.refillBps??sealed.refillBps,floorLamports:c.operating.floorLamports??sealed.floorLamports};
  handlers={'operating-reconcile':operatingReconcileHandler({...args,reconciler:reconciliationFactory(args)}),...(Number.isInteger(refill.refillBps)&&refill.floorLamports!=null?{'operating-refill':operatingRefillHandler({...args,...refill})}:{})};
 }else{
 const signerAdmit=createAdmissionGuard({...c.signerAdmission,registry,lane:c.lane});
 const signer=createRemoteSigner({...c.signer,fetchImpl,admit:signerAdmit});
 const baseChain=adapterFactory({connection,signer,registry,confirmationWaitMs:c.scope.campaignVersion===3?0:null,genesisHash:c.scope.genesisHash,programId:c.scope.programId,commitment:c.lane==='provisioning'||c.scope.campaignVersion===3&&['lifecycle','recovery'].includes(c.lane)?'finalized':'confirmed',log});
 const liveChain=c.scope.campaignVersion===3&&c.lane==='lifecycle'?withLiveVerification(baseChain,{connection,programVersion:3}):baseChain;
 const chain=c.receiptBatchSize>1?withReceiptBatches(liveChain,{programVersion:c.scope.campaignVersion}):liveChain;
 if(c.lane==='provisioning'){
  const adapter=createFeeSetupAdapter({connection,chain,feeOperator:c.feeOperator});
  const activation=c.feeActivation?createFeeActivation({registry,adapter,config:{...c.feeActivation,mode:c.mode,network:c.release?.network??'localnet',genesisHash:c.scope.genesisHash,programId:c.scope.programId,payer:String(chain.keeper),treasury:c.release?.treasury??c.feeActivation?.treasury??null}}):null;
  handlers={'fee-setup':feeSetupHandler({adapter,onReady:activation?.schedule}),...(activation?{'fee-activate':activation.handler}:{})};
 }
 else if(c.lane==='lifecycle'){
  const lifecycleConfig={...c.lifecycle,mode:c.mode,network:c.release?.network??'localnet',genesisHash:c.scope.genesisHash,programId:c.scope.programId,payer:String(chain.keeper),treasury:c.release?.treasury??c.lifecycle?.treasury??null};
  const perReceipt=c.lifecycle?createLifecycleController({registry,chain,config:lifecycleConfig}):null;
  handlers={settlement:settleReceipts({chain,batchSize:c.receiptBatchSize,authoritativeClock:c.scope.campaignVersion===3}),launch:launch({chain}),'launch-assert-ready':launchAssertReady({chain}),...(perReceipt?{'lifecycle-control':perReceipt.handler}:{})};
  lifecycle=perReceipt;
  if(c.lifecycle?.fundingFirst===true){
   // Funding-first campaigns (accounting version 2) on the same lane: the table during funding, the launch through it with the
   // custody co-signing, close, accounting and the collateral return; shared job classes dispatch by the record's version.
   const fundingFirst=createFundingFirstLifecycle({registry,chain,config:lifecycleConfig});
   const plans={read:id=>readLookupTablePlan({registry,identity:id}),allocate:id=>allocateLookupTablePlan({registry,connection,identity:id,payer:chain.keeper}),markComplete:(id,plan)=>markLookupTablePlan({registry,identity:id,plan,status:'complete'})};
   const displayFor=async(id,campaign)=>{const row=await registry.campaigns.get(id);return row?{name:row.name,symbol:row.symbol,uri:String(campaign.terms?.metadataUri??'')}:null;};
   handlers={...handlers,launch:versioned({chain,v0:handlers.launch,v2:launchFundingFirst({chain,plans,coSign:(tx,ref)=>custody.coSign(tx,ref),displayFor,publication:createPublicationReadiness(registry).read})}),'launch-table':launchTable({chain,plans}),close:closeFundingFirst({chain}),account:accountFundingFirst({chain}),'collateral-return':collateralReturnFundingFirst({chain}),'lifecycle-control':versioned({chain,v0:perReceipt.handler,v2:fundingFirst.handler})};
   lifecycle={descriptorHash:fundingFirst.descriptorHash,handler:handlers['lifecycle-control'],schedule:async(id,capabilityId)=>(Number((await chain.readCampaign(id)).accountingVersion)===2?fundingFirst:perReceipt).schedule(id,capabilityId)};
  }
 }
 else if(c.lane==='recovery'){
  const perReceipt=refundReceipts({chain,batchSize:c.receiptBatchSize,authoritativeClock:c.scope.campaignVersion===3});
  // Version 3 refunds dispatch by the record: per-receipt refunds (tag 3) or funding-first refunds (tag 44).
  handlers={refunds:c.scope.campaignVersion===3?versioned({chain,v0:perReceipt,v2:refundsFundingFirst({chain})}):perReceipt,...(c.scope.campaignVersion===3?{'operating-return':operatingReturnHandler({chain,registry,policy:c.operating?.policy??'creator-funded-v1'})}:{})};
 }
 else{
  const fees=createFeeAdapter({connection,registry,chain});
  handlers=Object.fromEntries(classes[c.lane].map(kind=>[kind,feeHandler({chain:fees,registry,kind})]));
 }
 }
 const servedClasses=lifecycle?['launch','settlement','lifecycle-control']:c.lane==='provisioning'&&c.feeActivation?['fee-setup','fee-activate']:c.lane==='recovery'?Object.keys(handlers):classes[c.lane];
 const runner=createJobRunner({registry,handlers,owner:c.owner||'worker:'+randomUUID(),concurrency:c.concurrency,lane:c.lane,scope:c.scope,servedClasses,log});
 let running=null,closing=null,stopped=false,presence=null;
 return {
  ...(lifecycle?{scheduleCampaign:lifecycle.schedule}:{}),
  status:()=>({mode:c.mode,lane:c.lane,scope:c.scope,receiptBatchSize:c.receiptBatchSize,classes:[...servedClasses],active:runner.active(),running:!!running&&!stopped}),
  start(){if(stopped)throw Error('Stopped worker cannot restart');if(running)throw Error('Worker already started');running=(async()=>{presence=createWorkerPresence({registry,scope:c.scope,lane:c.lane,classes:servedClasses,capacity:c.concurrency,health:runner.health,log});try{await presence.start();await runner.serve();}finally{runner.stop();await runner.drain();await presence.stop();}})();return running;},
  stop(){if(closing)return closing;stopped=true;runner.stop();closing=(async()=>{if(running)await running;await runner.drain();})();return closing;},
  // One bounded pass is useful for rehearsals and operator-controlled drains.
  tick:()=>runner.tick()
 };
}
export async function main(env=process.env){
 if(!env.KIDS_WORKER_CONFIG)throw Error('KIDS_WORKER_CONFIG file required');
 const config=JSON.parse(readFileSync(env.KIDS_WORKER_CONFIG,'utf8'));
 if(config.lane!=='accounting')config.signer={...config.signer,token:env.KIDS_SIGNER_TOKEN};
 // The custody endpoint (funding-first launches) comes from the environment like the signer: URL and token, never in the file.
 let custody=null;
 if(config.lifecycle?.fundingFirst===true){if(!env.KIDS_CUSTODY_URL||!env.KIDS_CUSTODY_TOKEN)throw Error('KIDS_CUSTODY_URL and KIDS_CUSTODY_TOKEN are required for a funding-first lifecycle worker');config.custody={url:env.KIDS_CUSTODY_URL};custody=createCustodyClient({url:env.KIDS_CUSTODY_URL,token:env.KIDS_CUSTODY_TOKEN});}
 if(config.mode==='hosted'){
  // Provider endpoints and the release manifest come from the environment: a config file never carries a provider key.
  if(config.rpcUrl!==undefined||config.release!==undefined)throw Error('Hosted RPC endpoint and release manifest come from the environment, not the config file');
  if(!env.KIDS_RPC_URL||!env.KIDS_RELEASE_MANIFEST)throw Error('KIDS_RPC_URL and KIDS_RELEASE_MANIFEST are required for a hosted worker');
  config.rpcUrl=env.KIDS_RPC_URL;config.release=loadReleaseManifest(env.KIDS_RELEASE_MANIFEST);
 }
 validateWorkerConfig(config);
 if(!env.KIDS_REGISTRY_URL?.startsWith('postgres'))throw Error('Shared registry URL required');
 const registry=new PostgresRegistry({connectionString:env.KIDS_REGISTRY_URL,max:4});
 const log=event=>console.log(JSON.stringify(event));let worker;
 // The platform healthcheck and the private network reach /healthz and /readyz on PORT (hosted services set it). The
 // listener is up before the schema wait, so the platform sees a live process that is not ready yet.
 let stopping=false,started=false,health=null;
 const port=healthPort(env);
 if(port!==null){health=createHealthListener({role:'worker-'+config.lane,ready:()=>started&&!stopping});try{await health.listen(port);}catch(error){await registry.close();throw error;}log({event:'health-listening',port});}
 try{if(config.mode==='hosted')await ensureSchema({registry,env,log});worker=await createPublicWorker({registry,config,log,custody});}catch(error){await health?.close();await registry.close();throw error;}
 const done=worker.start();started=true;log({event:'public-worker-started',...worker.status()});
 const stop=()=>{if(stopping)return;stopping=true;worker.stop().catch(()=>{process.exitCode=1;});};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{await done;}finally{stopping=true;try{await worker.stop();}finally{await health?.close();await registry.close();process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{
 // Startup errors can include credential-bearing driver/endpoint strings. Full
 // diagnostics stay in an operator-controlled local investigation, not stdout.
 console.error(JSON.stringify({event:'public-worker-start-failed'}));process.exitCode=1;
});
