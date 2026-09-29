import {fleetClosingMetrics} from './fleet-metrics.mjs';
import {createChainClockMonitor,wallBudgetMs,fleetExpectation,classifyFleetFailure,FLEET_EXPECTATIONS} from './fleet-clock.mjs';
import {createSignerRpcChannel} from '../signer/rpc-admission.mjs';
// Opt-in isolated-chain fleet rehearsal. Uses the real scoped signer, PostgreSQL
// and six separate worker processes; it cannot target a hosted/mainnet endpoint.
import assert from 'node:assert/strict';
import {runRehearsalBatch as bounded} from './rehearsal-work.mjs';
import {tradeFleet} from './fleet-trades.mjs';
import {readFileSync,writeFileSync,existsSync,mkdtempSync,openSync,closeSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,isAbsolute} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,randomBytes,createHash} from 'node:crypto';import {spawn} from 'node:child_process';import pg from 'pg';
import {Connection,PublicKey,Keypair,Transaction,SystemProgram,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,NATIVE_MINT,MINT_SIZE,getAssociatedTokenAddressSync,createAssociatedTokenAccountInstruction,createInitializeMint2Instruction,createMintToInstruction,createSetAuthorityInstruction,AuthorityType} from '@solana/spl-token';
import * as client from '../protocol-v2/client.mjs';import * as policy from '../protocol-v2/policy.mjs';
import {PostgresRegistry} from '../registry/registry.mjs';import {createPublicWorker} from '../jobs/service.mjs';
import {createRegistrySignerService} from '../signer/registry-service.mjs';import {createOperatingSignerBudget} from '../signer/operating-budget.mjs';
import {createStandardOperatingCostReader} from '../signer/standard-cost-reader.mjs';import {buildOperatingFundingPacket} from './operating-proofs.mjs';
import {createFeeAdapter,FEE_OPERATION_MIN_VALUE_LAMPORTS} from '../protocol-v2/fee-adapter.mjs';
import {createChainAdapter} from '../protocol-v2/chain-adapter.mjs';import {withLiveVerification} from '../protocol-v3/live-verification.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
import {recoverFailedJob} from '../jobs/recover-failed.mjs';import {renewFeeGrant} from '../jobs/renew-fee-grant.mjs';import {canonicalHash} from '../registry/canonical.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms)),SOL=1000000000n;
const app=fileURLToPath(new URL('../../',import.meta.url));
export function fleetParameters({campaigns=2,receipts=8}={}){
 if(!Number.isInteger(campaigns)||campaigns<1||campaigns>100||!Number.isInteger(receipts)||receipts<2||receipts>100||2000000000%receipts!==0)throw Error('Fleet requires 1..100 campaigns and 2..100 equal, exact receipts');
 return {campaigns,receipts};
}

export function fleetCapacity(campaigns,profile='baseline'){
 if(!Number.isInteger(campaigns)||campaigns<1||campaigns>100)throw Error('Invalid rehearsal capacity scope');
 if(!['baseline','signer-balanced-360'].includes(profile)||profile!=='baseline'&&campaigns<=10)throw Error('Invalid isolated capacity profile');
 const balanced=profile==='signer-balanced-360';
 const lanes=['lifecycle','recovery','provisioning','accounting','harvest','economics'];
 const replicas=Object.fromEntries(lanes.map(lane=>[lane,campaigns>10&&['lifecycle','recovery'].includes(lane)?balanced?4:2:balanced&&lane==='provisioning'?2:1]));
 const policy={ratePerSecond:240,burst:240,lanes:Object.fromEntries(lanes.map(lane=>[lane,{ratePerSecond:campaigns>10&&['lifecycle','recovery'].includes(lane)?60:30,burst:campaigns>10&&['lifecycle','recovery'].includes(lane)?60:30}]))};
 return {profile,lanes,replicas,policy,rpcResource:campaigns>10?'fleet-rpc-240-v2':'fleet-rpc',signerRpcResource:balanced?'fleet-signer-rpc-120-v2':'fleet-signer-rpc',signerRpcPerSecond:balanced?120:30,signerPolicy:{ratePerSecond:240,burst:240,lanes:Object.fromEntries(lanes.map(lane=>[lane,{ratePerSecond:30,burst:30}]))},concurrency:4};
}

export function retainedFleetSignerDirectory(directory,scope){
 const seen=new Set();
 for(let depth=0;depth<8;depth++){
  if(!isAbsolute(directory??'')||!directory.split('/').at(-1).startsWith('kids-fleet-')||seen.has(directory))throw Error('Invalid retained signer lineage');
  seen.add(directory);const s=JSON.parse(readFileSync(join(directory,'scope.json'),'utf8'));
  for(const key of ['genesisHash','programId','rpcUrl','schema'])if(s[key]!==scope[key])throw Error('Retained signer scope differs');
  if(existsSync(join(directory,'signer-state.json')))return directory;
  if(!s.backgroundDirectory)throw Error('Retained signer journal is missing');
  directory=s.backgroundDirectory;
 }
 throw Error('Retained signer lineage exceeds its bound');
}

export async function qualifyFleet({postgresUrl,campaigns=2,receipts=8,log=()=>{},resumeDirectory=null,backgroundDirectory=null,capacityProfile=null,expect='launch'}){
 ({campaigns,receipts}=fleetParameters({campaigns,receipts}));
 if(!FLEET_EXPECTATIONS.includes(expect))throw Error('Unknown fleet expectation: '+expect);
 if(!postgresUrl?.startsWith('postgresql:///kids_registry_test?'))throw Error('Explicit owned local test database required');
 if(capacityProfile!==null)fleetCapacity(campaigns,capacityProfile);
 // KIDS_FLEET_PROGRAM_MANIFEST names another isolated program record (for example the creator ledger's kids-launch-v3-program.json).
 const m=JSON.parse(readFileSync(process.env.KIDS_FLEET_PROGRAM_MANIFEST?new URL(process.env.KIDS_FLEET_PROGRAM_MANIFEST,'file://'+process.cwd()+'/'):new URL('../.runtime/kids-scale-v3-program.json',import.meta.url),'utf8'));
 if(m.network!=='localnet'||m.programVersion!==3||m.scaleQualification!==true||m.rpcUrl!=='http://127.0.0.1:19499')throw Error('Isolated scale ledger required');
 const c=new Connection(m.rpcUrl,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(10000)})});assert.equal(await c.getGenesisHash(),m.genesisHash);
 const program=await c.getAccountInfo(new PublicKey(m.programId),'finalized');assert.equal(program?.executable,true);assert.equal(program.data.readUInt32LE(0),2);
 const binary=await c.getAccountInfo(new PublicKey(program.data.subarray(4,36)),'finalized');assert.equal(createHash('sha256').update(binary.data.subarray(45,45+m.binarySize)).digest('hex'),m.sha256);
 const tier=client.AMM_CONFIG_TIERS[1],config=await c.getAccountInfo(tier.address,'finalized');assert.equal(createHash('sha256').update(config.data).digest('hex'),m.ammConfigHash);
 if(resumeDirectory!==null&&(!isAbsolute(resumeDirectory)||!resumeDirectory.split('/').at(-1).startsWith('kids-fleet-')))throw Error('Explicit retained fixture directory required');
 const prior=resumeDirectory?JSON.parse(readFileSync(join(resumeDirectory,'scope.json'),'utf8')):null;
 const capacity=fleetCapacity(campaigns,capacityProfile??prior?.capacityProfile??'baseline');
 if(prior&&(prior.capacityProfile??'baseline')!==capacity.profile)throw Error('Retained capacity profile differs');
 if(prior&&(prior.genesisHash!==m.genesisHash||prior.programId!==m.programId||prior.rpcUrl!==m.rpcUrl||prior.campaigns!==campaigns||prior.receipts!==receipts||!/^kids_test_[a-f0-9]{32}$/.test(prior.schema)))throw Error('Retained fleet scope differs');
 backgroundDirectory=prior?.backgroundDirectory??backgroundDirectory;
 if(backgroundDirectory!==null&&(!isAbsolute(backgroundDirectory)||!backgroundDirectory.split('/').at(-1).startsWith('kids-fleet-')))throw Error('Explicit retained background fleet required');
 const background=backgroundDirectory?JSON.parse(readFileSync(join(backgroundDirectory,'scope.json'),'utf8')):null;
 if(background&&(background.genesisHash!==m.genesisHash||background.programId!==m.programId||background.rpcUrl!==m.rpcUrl||background.campaigns!==100||!/^kids_test_[a-f0-9]{32}$/.test(background.schema)))throw Error('Background must be the same owned 100-pool ledger');
  const directory=resumeDirectory||mkdtempSync(join(tmpdir(),'kids-fleet-')),schema=prior?.schema||background?.schema||'kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1}),attemptId=randomUUID();
 const signerDirectory=backgroundDirectory||prior?retainedFleetSignerDirectory(backgroundDirectory||directory,{...m,schema}):directory;
 const tradingStop=new AbortController();
 const children=[],funding=new Map(),events=[],secrets=[];let pool,service,scheduler,success=false,trading=null,tradeResult=null,tradeError=null,backgroundRecords=[],backgroundFeeComplete=false,backgroundBaseline=new Map(),backgroundWallets=[],allJobs=null,failure=null,closeObservedAt=null,expectation={kind:'launch',chainTarget:null,requiresFeeWork:true};
 // Chain time is authoritative for every deadline; the monitor only decides whether the environment can still reach it.
 const chainSeconds=async()=>Number((await c.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'confirmed')).data.readBigInt64LE(32)),clockMonitor=createChainClockMonitor();
 const save=(name,value)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
 const load=path=>{const k=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path,'utf8'))));secrets.push(k);return k;};
 // KIDS_FLEET_SEPARATE_KEEPER=1 runs the keeper (payer, signer) on its own key while the campaigns stay sealed to the platform
 // treasury, the shape of the mainnet pilot; the default keeps the legacy fixture where the treasury key was the keeper.
 const separateKeeper=process.env.KIDS_FLEET_SEPARATE_KEEPER==='1';
 const creator=load(m.adminKeyFile),treasuryKey=load(m.treasuryKeyFile);assert.equal(String(creator.publicKey),m.pilotCreator);assert.equal(String(treasuryKey.publicKey),m.treasury);
 let payer=treasuryKey;
 if(separateKeeper){const keeperPath=join(directory,'keeper.json');if(existsSync(keeperPath))payer=load(keeperPath);else{payer=Keypair.generate();secrets.push(payer);save('keeper.json',Array.from(payer.secretKey));const sig=await c.requestAirdrop(payer.publicKey,20_000_000_000);await c.confirmTransaction(sig,'confirmed');}}
 const keeper=String(payer.publicKey),treasury=m.treasury;log({event:'fleet-identities',keeper,treasury,separateKeeper});
 if(!prior)save('scope.json',{genesisHash:m.genesisHash,programId:m.programId,rpcUrl:m.rpcUrl,schema,campaigns,receipts,backgroundDirectory,capacityProfile:capacity.profile});
 log({event:'fleet-started',campaigns,receipts,network:'isolated-localnet'});
 if(!prior){
  // A fresh run needs a validator whose clock keeps up with wall time; otherwise the chain deadline cannot arrive within any wall budget.
  for(let i=0;i<7;i++){clockMonitor.observe(Date.now(),await chainSeconds());if(i<6)await pause(2000);}
  const preflight=clockMonitor.summary();log({event:'fleet-chain-clock',phase:'preflight',...preflight});
  if(preflight.lastRate===null||preflight.lastRate<clockMonitor.minRate)throw Object.assign(Error('Environment: chain clock advances '+(preflight.lastRate===null?'unobservably':preflight.lastRate.toFixed(2)+' s per wall second')+' (lag '+preflight.lastLagSeconds+' s); a fresh capacity run needs a healthy validator'),{code:'ENVIRONMENT_CHAIN_CLOCK',chainClock:preflight});
 }
 let packetSequence=0;
 async function send(instructions,signers=[creator]){
  const block=await c.getLatestBlockhash('confirmed'),tx=new Transaction({...block,feePayer:signers[0].publicKey}).add(...instructions);tx.sign(...signers);
  const raw=tx.serialize();assert.ok(raw.length<=1232);const signature=encodeBase58(tx.signature);
  // Preserve the exact signed packet before send. Unknown sends stop the fixture
  // and keep this evidence; they are never replaced with another transaction.
  save('fixture-packet-'+(packetSequence++)+'.json',{signature,block,base64:raw.toString('base64')});
  assert.equal(await c.sendRawTransaction(raw,{maxRetries:2,preflightCommitment:'confirmed'}),signature);
  assert.equal((await c.confirmTransaction({...block,signature},'confirmed')).value.err,null);return {signature,block};
 }
 const finalized=async({signature,block})=>assert.equal((await c.confirmTransaction({...block,signature},'finalized')).value.err,null);
 try{
  if(!prior&&!background)await control.query(`CREATE SCHEMA ${schema}`);else assert.equal((await control.query('SELECT nspname FROM pg_namespace WHERE nspname=$1',[schema])).rows.length,1,'Retained database is missing');pool=new pg.Pool({connectionString:postgresUrl,max:12,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  let owners,records,deadline,bindings;const perReceipt=2n*SOL/BigInt(receipts);
  if(!prior){
  const required=Number(BigInt(campaigns)*3n*SOL+10n*SOL);if(await c.getBalance(creator.publicKey)<required){
   assert.equal(await c.getGenesisHash(),m.genesisHash);const signature=await c.requestAirdrop(creator.publicKey,required);save('airdrop.json',{signature,lamports:required});assert.equal((await c.confirmTransaction(signature,'finalized')).value.err,null);
  }
  owners=Array.from({length:receipts},()=>{const k=Keypair.generate();secrets.push(k);return k;});save('fixture-owners.json',owners.map(k=>Array.from(k.secretKey)));
  for(let i=0;i<owners.length;i+=8)await send(owners.slice(i,i+8).map(o=>SystemProgram.transfer({fromPubkey:creator.publicKey,toPubkey:o.publicKey,lamports:BigInt(campaigns)*(perReceipt+5000000n)+100000000n})));
  const rent=await c.getMinimumBalanceForRentExemption(MINT_SIZE),supply=1000000000000000n;
  records=await bounded(Array.from({length:campaigns}),4,async(_,i)=>{
   const mintKey=Keypair.generate();secrets.push(mintKey);save('mint-'+i+'.json',Array.from(mintKey.secretKey));const mint=mintKey.publicKey,nonce=randomBytes(8).readBigUInt64LE(),campaign=client.campaignAddress(m.programId,creator.publicKey,nonce),authority=client.launchAuthority(m.programId,campaign),ata=getAssociatedTokenAddressSync(mint,authority,true),wsol=getAssociatedTokenAddressSync(NATIVE_MINT,authority,true);
   const packet=await send([SystemProgram.createAccount({fromPubkey:creator.publicKey,newAccountPubkey:mint,lamports:rent,space:MINT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeMint2Instruction(mint,6,creator.publicKey,creator.publicKey),createAssociatedTokenAccountInstruction(creator.publicKey,ata,authority,mint),createAssociatedTokenAccountInstruction(creator.publicKey,wsol,authority,NATIVE_MINT),createMintToInstruction(mint,ata,creator.publicKey,supply),createSetAuthorityInstruction(mint,creator.publicKey,AuthorityType.MintTokens,authority),createSetAuthorityInstruction(mint,creator.publicKey,AuthorityType.FreezeAccount,authority)],[creator,mintKey]);
   return {index:i,mint,campaign,authority,nonce,packet};
  });
  await Promise.all(records.slice(-4).map(r=>finalized(r.packet)));
  const chainNow=(await c.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'confirmed')).data.readBigInt64LE(32);deadline=chainNow+BigInt(campaigns>10?600:120);
  bindings=records.map(r=>({genesisHash:m.genesisHash,programId:m.programId,campaign:String(r.campaign),payer:keeper,policy:'local-fleet-qualification'}));
  save('campaigns.json',records.map(r=>({index:r.index,campaign:String(r.campaign),mint:String(r.mint),nonce:String(r.nonce),deadline:String(deadline)})));
  await bounded(records,4,async r=>{
   const terms={layoutVersion:2,mode:0,decimals:6,splitPolicy:policy.SPLIT_POLICY_STANDARD_V3,vestingRule:policy.VESTING_RULE_STANDARD_V3,feeRoutingVersion:1,creatorFeeEnabled:0,genesis:new PublicKey(m.genesisHash),creator:creator.publicKey,nonce:r.nonce,dev:creator.publicKey,treasury:treasuryKey.publicKey,childMint:r.mint,supply,
    opensAt:(await c.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'confirmed')).data.readBigInt64LE(32),deadline,launchDeadline:deadline+3600n,soft:SOL/2n,hard:SOL,ammProgram:client.RAYDIUM_CPMM,ammConfig:tier.address,ammTradeFeeRate:tier.tradeFeeRate,ammConfigIndex:tier.index,feeWeights:policy.FEE_WEIGHTS_STANDARD,splitBps:policy.SPLIT_STANDARD_V3,vesting:policy.VESTING_STANDARD_V3,buybackMaxSlippageBps:0,lockProgram:client.RAYDIUM_LOCK,distributionProgram:PublicKey.default,
    parentMint:[PublicKey.default,PublicKey.default],parentProgram:[PublicKey.default,PublicKey.default],parentSlot:[0,0],parentRoot:['00'.repeat(32),'00'.repeat(32)],parentSupply:[0,0],parentEligible:[0,0],parentExpirySeconds:0,metadataHash:createHash('sha256').update('fleet:'+r.campaign).digest(),metadataUri:'https://kids.fun/rehearsal/'+r.mint+'.json',parentReferenceConfig:[0,0]};
   await send([client.createInstruction(m.programId,terms).instruction,SystemProgram.transfer({fromPubkey:creator.publicKey,toPubkey:r.authority,lamports:300000000n})]);
   // Every campaign gets equal exact commitments. These are generated local test
   // wallets, not a claim about a representative real-world wealth distribution.
   for(let n=0;n<owners.length;n+=3){const group=owners.slice(n,n+3);r.last=await send(group.map(o=>client.commitInstruction(m.programId,r.campaign,o.publicKey,m.genesisHash,perReceipt,0n)),group);}
   const intent={...bindings[r.index],creator:m.pilotCreator,lamports:'80000000'},block=await c.getLatestBlockhash('confirmed'),tx=buildOperatingFundingPacket(intent,block);tx.sign([creator]);
   const row={binding:intent,block,signature:encodeBase58(tx.signatures[0]),transactionBase64:Buffer.from(tx.serialize()).toString('base64')};funding.set(String(r.campaign),row);save('funding-'+r.index+'.json',row);
   await c.sendRawTransaction(tx.serialize(),{maxRetries:2,preflightCommitment:'confirmed'});assert.equal((await c.confirmTransaction({...block,signature:row.signature},'confirmed')).value.err,null);
  });
  await bounded([...funding.values()],4,row=>finalized({signature:row.signature,block:row.block}));
  }else{
   owners=JSON.parse(readFileSync(join(directory,'fixture-owners.json'),'utf8')).map(bytes=>{const k=Keypair.fromSecretKey(Uint8Array.from(bytes));secrets.push(k);return k;});assert.equal(owners.length,receipts);
   const saved=JSON.parse(readFileSync(join(directory,'campaigns.json'),'utf8'));assert.equal(saved.length,campaigns);deadline=BigInt(saved[0].deadline);
   records=saved.map((r,i)=>{assert.equal(r.index,i);assert.equal(BigInt(r.deadline),deadline);const campaign=new PublicKey(r.campaign),nonce=BigInt(r.nonce);assert.ok(client.campaignAddress(m.programId,creator.publicKey,nonce).equals(campaign));return {...r,mint:new PublicKey(r.mint),campaign,nonce,authority:client.launchAuthority(m.programId,campaign)};});
   bindings=records.map(r=>({genesisHash:m.genesisHash,programId:m.programId,campaign:String(r.campaign),payer:keeper,policy:'local-fleet-qualification'}));
   for(const r of records)funding.set(String(r.campaign),JSON.parse(readFileSync(join(directory,'funding-'+r.index+'.json'),'utf8')));
  }
  if(background){
   backgroundWallets=JSON.parse(readFileSync(join(backgroundDirectory,'fixture-owners.json'),'utf8')).map(bytes=>{const k=Keypair.fromSecretKey(Uint8Array.from(bytes));secrets.push(k);return k;});assert.equal(backgroundWallets.length,background.receipts);
   assert.equal(schema,background.schema);backgroundRecords=JSON.parse(readFileSync(join(backgroundDirectory,'campaigns.json'),'utf8'));assert.equal(backgroundRecords.length,100);
   for(const r of backgroundRecords){const info=await c.getAccountInfo(new PublicKey(r.campaign),'finalized');assert.equal(String(info.owner),m.programId);const decoded=client.decodeCampaign(info.data);assert.equal(decoded.state.phase,3);assert.ok(!records.some(x=>String(x.campaign)===r.campaign));funding.set(r.campaign,JSON.parse(readFileSync(join(backgroundDirectory,'funding-'+r.index+'.json'),'utf8')));}
  }
  if(background){
   const file=join(directory,'background-fee-baseline.json');let baseline;
   if(existsSync(file))baseline=JSON.parse(readFileSync(file));else{baseline=[];for(const r of backgroundRecords){const info=await c.getAccountInfo(client.feeStateAddress(m.programId,r.campaign),'finalized'),f=client.decodeFeeState(info.data,new PublicKey(r.campaign));baseline.push({campaign:r.campaign,solCollected:String(f.solCollected),coinBurned:String(f.coinBurned)});}save('background-fee-baseline.json',baseline);}
   assert.equal(baseline.length,backgroundRecords.length);backgroundBaseline=new Map(baseline.map(x=>[x.campaign,x]));
  }
  log({event:'fleet-funded',campaigns,receiptsPerCampaign:receipts,commonDeadline:String(deadline)});
  {const phases=prior?await bounded(records,8,async r=>client.decodeCampaign((await c.getAccountInfo(r.campaign,'confirmed')).data).state.phase):[];
   expectation=fleetExpectation({expect,chainNow:await chainSeconds(),deadline,launchDeadline:deadline+3600n,phases});log({event:'fleet-expectation',kind:expectation.kind,chainTarget:String(expectation.chainTarget),phases:phases.length?Object.fromEntries(phases.map(p=>[p,phases.filter(x=>x===p).length])):null});}
  const base={genesisHash:m.genesisHash,programId:m.programId,payer:keeper,policy:'local-fleet-qualification'};
  if(background&&expectation.requiresFeeWork){
   // Operator actions for the retained pools before fee lanes start: renew an expired fee-keeper grant with exactly the
   // scope its activation recorded, then recover fee jobs that failed only because no grant was served. Both are audited
   // registry rows; neither widens authority or touches money.
   let renewed=0,recovered=0;
   for(const r of backgroundRecords){
    const scope={genesisHash:m.genesisHash,programId:m.programId,campaign:r.campaign};
    const activation=(await registry.query('SELECT active_capability_id FROM standard_fee_activations WHERE genesis_hash=? AND program_id=? AND campaign=?',[scope.genesisHash,scope.programId,scope.campaign])).rows[0];if(!activation)continue;
    const latest=await registry.capabilities.latest(scope);
    if(!(latest&&latest.kind==='keeper'&&!latest.revokedAt&&Date.parse(latest.expiresAt)>Date.now()+3600000)){
     await renewFeeGrant({registry,identity:scope,expectedCapabilityId:latest.capabilityId,expiresAt:new Date(Date.now()+86400000).toISOString(),actor:'fleet-rehearsal'});renewed++;
    }
    for(const job of (await registry.query("SELECT job_id,fencing_token,result_json FROM jobs WHERE state='failed' AND genesis_hash=? AND program_id=? AND campaign=?",[scope.genesisHash,scope.programId,scope.campaign])).rows){
     const result=JSON.parse(job.result_json||'null');if(result?.category!=='auth')continue;
     const out=await recoverFailedJob({registry,identity:scope,jobId:job.job_id,expectedToken:Number(job.fencing_token),expectedResultHash:canonicalHash(result),recoveryId:'fleet-regrant:'+job.job_id,actor:'fleet-rehearsal',reason:'expired-grant-regranted'});if(out.requeued)recovered++;
    }
   }
   log({event:'fleet-fee-grant-renewal',renewed,recovered,pools:backgroundRecords.length});
  }
  const signerRpc=createSignerRpcChannel({registry,connection:c,resource:capacity.signerRpcResource,ratePerSecond:capacity.signerRpcPerSecond,burst:capacity.signerRpcPerSecond});
  const budget=createOperatingSignerBudget({registry,connection:signerRpc.connection,...base,loadFundingPacket:async x=>funding.get(x.campaign),loadCostIntent:createStandardOperatingCostReader({connection:signerRpc.connection,...base,feeOperator:m.pilotCreator,treasury}),treasury});
  await bounded(records,4,async r=>{const decoded=client.decodeCampaign((await c.getAccountInfo(r.campaign,'finalized')).data);assert.equal(decoded.state.total,2n*SOL);assert.equal(decoded.state.receiptCount,BigInt(receipts));await registry.campaigns.upsert({...bindings[r.index],network:'localnet',mode:'standard',campaignVersion:3,registryStatus:'planned',termsHash:decoded.state.termsHash});const fundingRow=funding.get(String(r.campaign)),credit={...bindings[r.index],signature:fundingRow.signature};if(!prior||!await budget.credited({...credit,source:fundingRow.binding.creator,lamports:fundingRow.binding.lamports}))await budget.credit(credit);});
  const token=randomBytes(32).toString('hex');service=await createRegistrySignerService({registry,connection:c,admitRpc:signerRpc.admit,...base,treasury,programVersion:3,rehearsalCapacity:campaigns>10||background?{profile:'isolated-fleet-100',...(process.env.KIDS_FLEET_SIGNER_HOURLY_LAMPORTS?{hourlyLamports:Number(process.env.KIDS_FLEET_SIGNER_HOURLY_LAMPORTS)}:{})}:undefined,keypair:payer,token,stateFile:join(signerDirectory,'signer-state.json'),operatingBudget:{reserve:x=>budget.reserve(x),recordSignature:(...x)=>budget.recordSignature(...x)}});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const {lanes,replicas}=capacity,admission=capacity.policy;
  const configuration=lane=>({mode:'localnet-rehearsal',lane,programVersion:3,genesisHash:m.genesisHash,programId:m.programId,rpcUrl:m.rpcUrl,concurrency:4,
   signer:lane==='accounting'?undefined:{url:'http://127.0.0.1:'+service.server.address().port,publicKey:keeper},rpcAdmission:{resource:capacity.rpcResource,policy:admission},signerAdmission:lane==='accounting'?undefined:{resource:'fleet-signer',policy:capacity.signerPolicy},
   ...(lane==='accounting'?{operating:{payer:keeper,policy:base.policy,treasury}}:{}),...(lane==='lifecycle'?{receiptBatchSize:8,lifecycle:{setupHandoff:true,policy:base.policy,minimumReserveLamports:'1000000',treasury}}:{}),...(lane==='recovery'?{receiptBatchSize:8,operating:{payer:keeper,policy:base.policy}}:{}),...(lane==='provisioning'?{feeOperator:m.pilotCreator,feeActivation:{policy:base.policy,minimumReserveLamports:'1000000',treasury}}:{})});
  scheduler=await createPublicWorker({registry,config:{...configuration('lifecycle'),signer:{...configuration('lifecycle').signer,token}}});
  // A lifecycle grant must outlive the sealed launch window plus the controller refund allowance, measured from chain time, with an hour of operator margin.
  const grantChainNow=await chainSeconds(),grantUntil=()=>new Date(Date.now()+Math.max(0,Number(deadline)+3600-grantChainNow)*1000+86400000+3600000).toISOString();
  const scheduledCapability=new Map();
  for(const binding of bindings){const existing=(await registry.query('SELECT initial_capability_id FROM standard_lifecycles WHERE genesis_hash=? AND program_id=? AND campaign=?',[binding.genesisHash,binding.programId,binding.campaign])).rows[0];if(existing)scheduledCapability.set(binding.campaign,existing.initial_capability_id);}
  const liveGrant=cap=>!!cap&&!cap.revokedAt&&Date.parse(cap.expiresAt)>Date.now();
  if(!expectation.requiresFeeWork){
   // Operator action for the expired cohort. A campaign already under lifecycle control whose grant has died gets a refund-only
   // continuation (tag 3, no recipients) so refunds can be paid; nothing wider is issued. A campaign that was never scheduled
   // (its grant was refused before scheduling, as cohort 5DbANT) cannot use a continuation: scheduling needs the explicit
   // initial grant, issued below, and the lifecycle handler then pays the refunds from the expired window.
   let issued=0,unscheduled=0;
   for(const binding of bindings){
    if(!scheduledCapability.has(binding.campaign)){unscheduled++;continue;}
    const latest=await registry.capabilities.latest(binding);if(liveGrant(latest))continue;
    await registry.capabilities.grant({...binding,programVersion:3,kind:'keeper',tags:[3],recipients:[],limits:latest?.limits??{},expiresAt:new Date(Date.now()+7200000).toISOString()});issued++;
   }
   log({event:'fleet-refund-continuation',issued,unscheduled,campaigns});
  }
  for(const binding of bindings){
   let capabilityId=scheduledCapability.get(binding.campaign);
   if(!capabilityId){const latest=await registry.capabilities.latest(binding);capabilityId=liveGrant(latest)&&JSON.stringify(latest.tags)==='[3,4,6]'?latest.capabilityId:(await registry.capabilities.grant({...binding,programVersion:3,kind:'keeper',tags:[3,4,6],expiresAt:grantUntil()})).capabilityId;}
   const until=Date.now()+60000;for(;;){try{await scheduler.scheduleCampaign(binding,capabilityId);break;}catch(e){if(e?.code!=='CAPACITY_WAIT'||Date.now()>=until)throw e;await pause(Math.max(20,Math.min(2000,Number(e.retryAfterMs)||1000)));}}
  }
  const workerStartChainTime=(await c.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'confirmed')).data.readBigInt64LE(32);
  const dbUrl=new URL(postgresUrl);dbUrl.searchParams.set('options','-c search_path='+schema);
  // The refund path only needs lifecycle control, refunds and signer-free accounting; fee lanes stay down so background pools are not touched.
  const activeLanes=expectation.requiresFeeWork?lanes:lanes.filter(lane=>['lifecycle','recovery','accounting'].includes(lane));
  for(const lane of activeLanes)for(let replica=0;replica<replicas[lane];replica++){const name='worker-'+lane+'-'+replica+'-'+attemptId,configFile=join(directory,name+'.json');save(name+'.json',configuration(lane));const logFile=join(directory,name+'.log');writeFileSync(logFile,'',{flag:'wx',mode:0o600});const fd=openSync(logFile,'a',0o600);
   const child=spawn(process.execPath,['localnet/jobs/service.mjs'],{cwd:app,env:{PATH:process.env.PATH,KIDS_REGISTRY_URL:dbUrl.href,KIDS_WORKER_CONFIG:configFile,KIDS_SIGNER_TOKEN:token},stdio:['ignore','pipe',fd]});closeSync(fd);let remainder='';const item={child,lane,ended:false,ready:false};children.push(item);child.on('error',()=>{item.ended=true;});child.on('exit',code=>{item.ended=true;item.code=code;});
   child.stdout.on('data',chunk=>{remainder+=chunk.toString();let n;while((n=remainder.indexOf('\n'))>=0){const line=remainder.slice(0,n);remainder=remainder.slice(n+1);appendFileSync(logFile,line+'\n');try{const event=JSON.parse(line);if(event.event==='public-worker-started')item.ready=true;if(['job-started','job-finished'].includes(event.event)&&events.length<200000)events.push(event);}catch{}}if(remainder.length>65536)remainder='';});
  }
  if(background&&expectation.requiresFeeWork){
   trading=(async()=>{while((await c.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'confirmed')).data.readBigInt64LE(32)<deadline){tradingStop.signal.throwIfAborted();await pause(1000);}tradingStop.signal.throwIfAborted();tradeResult=await tradeFleet({registry,connection:c,genesisHash:m.genesisHash,programId:m.programId,records:backgroundRecords,wallet:creator,wallets:backgroundWallets,directory,log,signal:tradingStop.signal});})();trading.catch(e=>{tradeError=e;});
  }
  const scopeSql=' WHERE campaign IN ('+bindings.map(()=>'?').join(',')+')',scopeValues=bindings.map(x=>x.campaign);
  const started=performance.now(),wallStarted=Date.now(),baseLimitMs=Math.max(background?1800000:600000,campaigns*15000),ceilingMs=3*3600000;let limit=wallStarted+baseLimitMs,lastProgress=0,lastClockRead=0,latestChain=Number(workerStartChainTime),complete=false;closeObservedAt=workerStartChainTime>=deadline?new Date().toISOString():null;
  let returnGrantsIssued=false,returnCreatorBefore=0n;
  clockMonitor.observe(Date.now(),latestChain);
  while(Date.now()<limit){
   if(Date.now()-lastClockRead>=2000){lastClockRead=Date.now();latestChain=await chainSeconds();const clock=clockMonitor.observe(lastClockRead,latestChain);if(!closeObservedAt&&BigInt(latestChain)>=deadline)closeObservedAt=new Date().toISOString();
    // While the chain target is ahead, the wall budget follows the observed chain rate instead of expiring on laptop time; a stalled clock is an environment failure, not a throughput result.
    const remaining=Number(expectation.chainTarget)-latestChain;
    if(remaining>0){limit=Math.max(limit,Math.min(wallStarted+ceilingMs,Date.now()+wallBudgetMs({remainingChainSeconds:remaining,rate:clock.rate,allowanceMs:baseLimitMs,ceilingMs})));
     if(clockMonitor.stalled())throw Object.assign(Error('Environment: chain clock stalled at '+clock.rate.toFixed(2)+' s per wall second (lag '+clock.lagSeconds+' s) with '+remaining+' chain seconds still to go; not a throughput result'),{code:'ENVIRONMENT_CHAIN_CLOCK',chainClock:clockMonitor.summary()});}}
   const dead=children.find(x=>x.ended);if(dead)throw Error('Fleet worker stopped: '+dead.lane);
   if(tradeError)throw tradeError;
   allJobs=(await registry.query("SELECT job_class,state,count(*) n FROM jobs"+scopeSql+" GROUP BY job_class,state",scopeValues)).rows;
   if(allJobs.some(j=>j.state==='failed'))throw Error('Fleet contains failed jobs');
   if(background&&expectation.requiresFeeWork&&Number((await registry.query("SELECT count(*) n FROM jobs WHERE state='failed' AND campaign IN ("+backgroundRecords.map(()=>'?').join(',')+")",backgroundRecords.map(r=>r.campaign))).rows[0].n)>0)throw Error('Background fleet contains failed jobs');
   const done=kind=>Number(allJobs.find(j=>j.job_class===kind&&j.state==='done')?.n??0);
   const held=Number((await registry.query("SELECT COUNT(*) n FROM operating_spend_holds"+scopeSql+" AND state='held'",scopeValues)).rows[0].n);
   if(!expectation.requiresFeeWork){
    // Expired launch window: every campaign refunds in full and its lifecycle control finishes as refunded; no fee work exists
    // to wait for. Then the operator action of option 1: an operating-return capability per campaign naming the sealed
    // creator, so the recovery lane returns each campaign's unused reserve; the run completes when every return is done.
    const lifecycleDone=Number(allJobs.find(j=>j.job_class==='lifecycle-control'&&j.state==='done')?.n??0);
    if(done('refunds')===campaigns&&lifecycleDone===campaigns&&!returnGrantsIssued){
     returnCreatorBefore=BigInt(await c.getBalance(creator.publicKey,'finalized'));
     for(const binding of bindings){
      const latest=await registry.capabilities.latest(binding);
      if(latest&&latest.kind==='operating-return'&&!latest.revokedAt&&Date.parse(latest.expiresAt)>Date.now())continue;
      await registry.capabilities.grant({...binding,programVersion:3,kind:'operating-return',tags:[],recipients:[creator.publicKey.toBase58()],limits:latest?.limits??{},expiresAt:new Date(Date.now()+7200000).toISOString()});
      const identity={genesisHash:binding.genesisHash,programId:binding.programId,campaign:binding.campaign};
      if(!(await registry.jobs.listForCampaign(identity)).some(j=>j.jobClass==='operating-return'))await registry.jobs.enqueue({...identity,jobClass:'operating-return',operationKey:'operating-return',payload:{}});
     }
     returnGrantsIssued=true;log({event:'fleet-return-capabilities',issued:campaigns});
    }
    if(done('refunds')===campaigns&&lifecycleDone===campaigns&&done('operating-return')===campaigns&&held===0){complete=true;break;}
   }else if(done('fee-activate')===campaigns&&done('refunds')===campaigns&&['fee-harvest','distribution','token-burn'].every(k=>done(k)>=campaigns)&&held===0&&(!background||tradeResult)){
    if(!background){complete=true;break;}
    let finishedFees=0;for(let i=0;i<backgroundRecords.length;i+=50){const group=backgroundRecords.slice(i,i+50),infos=await c.getMultipleAccountsInfo(group.map(r=>client.feeStateAddress(m.programId,r.campaign)),'finalized');for(let n=0;n<infos.length;n++){const f=client.decodeFeeState(infos[n].data,new PublicKey(group[n].campaign));const initial=backgroundBaseline.get(group[n].campaign);if(f.solCollected>BigInt(initial.solCollected)&&f.coinBurned>BigInt(initial.coinBurned)&&f.solCollected-f.treasuryPaid-f.devPaid<FEE_OPERATION_MIN_VALUE_LAMPORTS)finishedFees++;}}
    if(finishedFees===backgroundRecords.length&&Number((await registry.query("SELECT COUNT(*) n FROM operating_spend_holds WHERE state='held'")).rows[0].n)===0){backgroundFeeComplete=true;complete=true;break;}
   }
   if(Date.now()-lastProgress>15000){const clock=clockMonitor.summary();log({event:'fleet-progress',launched:done('launch'),refunded:done('refunds'),feeActivated:done('fee-activate'),returned:done('operating-return'),held,chainLagSeconds:clock.lastLagSeconds,chainRate:clock.lastRate,wallBudgetLeftMs:limit-Date.now()});lastProgress=Date.now();}
   await pause(500);
  }
  const done=kind=>Number(allJobs?.find(j=>j.job_class===kind&&j.state==='done')?.n??0);
  if(!complete)throw Object.assign(Error('Fleet did not complete within its wall budget ('+expectation.kind+'): launched '+done('launch')+', refunded '+done('refunds')+', activated '+done('fee-activate')),{code:'SLO_TIMEOUT',chainClock:clockMonitor.summary()});
  assert.equal(done('refunds'),campaigns);
  if(expectation.requiresFeeWork){assert.equal(done('fee-activate'),campaigns,'Fleet activation incomplete');for(const kind of ['fee-harvest','distribution','token-burn'])assert.ok(done(kind)>=campaigns,'Initial fee jobs incomplete: '+kind);}
  assert.ok(!background||!expectation.requiresFeeWork||backgroundFeeComplete&&tradeResult?.allFinalized,'Background trades, fees and operating holds must fully reconcile');
  const readonly=createChainAdapter({connection:c,programId:m.programId,genesisHash:m.genesisHash,commitment:'finalized',signer:{publicKey:payer.publicKey,sign(){throw Error('Read-only');}}}),verify=withLiveVerification(readonly,{connection:c,programVersion:3});
  await bounded(records,4,async r=>{const state=client.decodeCampaign((await c.getAccountInfo(r.campaign,'finalized')).data).state;
   const accounts=await c.getMultipleAccountsInfo(owners.map(o=>client.receiptAddress(m.programId,r.campaign,o.publicKey)),'finalized');
   if(!expectation.requiresFeeWork){
    // Expired window: nothing launched, every lamport committed is refunded, no receipt was settled.
    assert.notEqual(state.phase,3);assert.equal(state.total,2n*SOL);assert.equal(state.refunded,state.total);
    for(const a of accounts){const receipt=client.decodeReceipt(a.data);assert.equal(receipt.refunded,perReceipt);assert.equal(receipt.settled,false);}
   }else{
    assert.equal(state.phase,3);assert.equal(state.settledCount,BigInt(receipts));assert.equal(state.settledAccepted,SOL);assert.equal(state.refunded,SOL);const v=await verify.verifyLaunch(bindings[r.index]);assert.equal(v.ok,true,v.failures.join('; '));
    for(const a of accounts){const receipt=client.decodeReceipt(a.data);assert.equal(receipt.accepted,perReceipt/2n);assert.equal(receipt.refunded,perReceipt/2n);assert.equal(receipt.settled,true);}
   }
   assert.equal((await budget.balance(bindings[r.index])).heldLamports,'0');
  });
  let operatingReturns=null;
  if(!expectation.requiresFeeWork){
   const stages=(await registry.query("SELECT stage,count(*) n FROM standard_lifecycles"+scopeSql+" GROUP BY stage",scopeValues)).rows;assert.deepEqual(stages.map(x=>[x.stage,Number(x.n)]),[['refunded',campaigns]],'Every expired campaign must reach the refunded stage');
   // Option 1: every campaign's unused reserve went back to the creator; the budget shows the return and the fee, nothing left.
   let returnedTotal=0n,spentTotal=0n;
   await bounded(records,4,async r=>{const b=await budget.balance(bindings[r.index]);assert.equal(b.heldLamports,'0');assert.equal(b.availableLamports,'0','Unused reserve must be fully returned');assert.ok(BigInt(b.returnedLamports)>0n,'A return must be recorded');returnedTotal+=BigInt(b.returnedLamports);spentTotal+=BigInt(b.spentLamports);});
   const creatorAfter=BigInt(await c.getBalance(creator.publicKey,'finalized'));
   assert.equal(creatorAfter-returnCreatorBefore,returnedTotal,'Creator balance must rise by exactly the recorded returns');
   operatingReturns={campaigns,returnedLamports:String(returnedTotal),spentLamports:String(spentTotal),creatorDeltaLamports:String(creatorAfter-returnCreatorBefore)};
  }
  let backgroundAccounting=null;
  if(background&&expectation.requiresFeeWork){
   const feeRead=createFeeAdapter({registry,chain:readonly,connection:{getMultipleAccountsInfoAndContext:(keys,options)=>c.getMultipleAccountsInfoAndContext(keys,{...options,commitment:'finalized'})}});
   let solDust=0n,dustPools=0,tokenDustPools=0,maxTokenDustValue=0n;const residues=[];
   await bounded(backgroundRecords,4,async r=>{const snapshot=await feeRead.snapshot({genesisHash:m.genesisHash,programId:m.programId,campaign:r.campaign}),f=snapshot.fees,baseline=backgroundBaseline.get(r.campaign),pending=f.solCollected-f.treasuryPaid-f.devPaid;
    assert.ok(f.solCollected>BigInt(baseline.solCollected)&&f.coinBurned>BigInt(baseline.coinBurned));
    assert.ok(pending>=0n&&pending<FEE_OPERATION_MIN_VALUE_LAMPORTS,'Economic SOL payout still outstanding');
    assert.ok(snapshot.coinValue(f.coinPending)<FEE_OPERATION_MIN_VALUE_LAMPORTS,'Economic token burn still outstanding');
    solDust+=pending;if(pending>1n)dustPools++;if(f.coinPending>0n)tokenDustPools++;const tokenValue=snapshot.coinValue(f.coinPending);if(tokenValue>maxTokenDustValue)maxTokenDustValue=tokenValue;residues.push({campaign:r.campaign,solLamports:String(pending),coinBaseUnits:String(f.coinPending),coinValueLamports:String(tokenValue)});
   });
   save('fee-residues-'+attemptId+'.json',residues);
   backgroundAccounting={retainedSolDustLamports:String(solDust),retainedTokenDustPools:tokenDustPools,maxTokenDustValueLamports:String(maxTokenDustValue),solDustPools:dustPools,minimumOperationValueLamports:String(FEE_OPERATION_MIN_VALUE_LAMPORTS),economicWorkDrained:true};
  }
  const outstandingSignedPackets=Number((await registry.query("SELECT COUNT(*) n FROM operator_packets WHERE status='signed' AND COALESCE(descriptor::jsonb->>'campaign',descriptor::jsonb->'binding'->>'campaign') IN ("+bindings.map(()=>'?').join(',')+")",scopeValues)).rows[0].n);assert.equal(outstandingSignedPackets,0,'Chain outcomes must close their operator and budget journals');
  const latency={};for(const lane of lanes){const values=events.filter(e=>e.lane===lane&&e.event==='job-started').map(e=>Math.max(0,Date.parse(e.leasedAt)-Date.parse(e.dueAt))).filter(Number.isFinite).sort((a,b)=>a-b);const execution=events.filter(e=>e.lane===lane&&e.event==='job-finished').map(e=>e.durationMs).filter(Number.isFinite).sort((a,b)=>a-b);latency[lane]={starts:values.length,p95QueueMs:values.length?values[Math.ceil(values.length*.95)-1]:null,executionSamples:execution.length,p95ExecutionMs:execution.length?execution[Math.ceil(execution.length*.95)-1]:null};}
  const closingWindow=fleetClosingMetrics(events,{closeObservedAt,freshClose:workerStartChainTime<deadline});
  const backgroundFailedJobs=background?(await registry.query("SELECT job_class,COALESCE(result_json::jsonb->>'category','') category,count(*) n FROM jobs WHERE state='failed' AND campaign IN ("+backgroundRecords.map(()=>'?').join(',')+") GROUP BY job_class,category",backgroundRecords.map(r=>r.campaign))).rows.map(x=>({jobClass:x.job_class,category:x.category,count:Number(x.n)})):[];
  const report={expectation:expectation.kind,chainClock:clockMonitor.summary(),activeLanes,backgroundFailedJobs,closingWindow,operatingReturns,network:'isolated-localnet',tradeFeeBps:250,campaigns,receiptsPerCampaign:receipts,workerProcesses:children.length,workersScheduledBeforeClose:workerStartChainTime<deadline,commonDeadline:String(deadline),workerStartChainTime:String(workerStartChainTime),sharedSigner:true,sharedDatabase:true,workerCapacity:capacity,signerRpcPerSecond:capacity.signerRpcPerSecond,signerProfile:campaigns>10||background?'isolated-fleet-100':'legacy-default',elapsedMs:Math.round(performance.now()-started),acceptedLamports:expectation.requiresFeeWork?String(BigInt(campaigns)*SOL):'0',refundedLamports:String(BigInt(campaigns)*(expectation.requiresFeeWork?SOL:2n*SOL)),allLocksVerified:expectation.requiresFeeWork?true:null,allReceiptsVerified:true,heldLamports:'0',outstandingSignedPackets,latency,feeWork:!expectation.requiresFeeWork?'none: the launch window expired on chain, full refunds only':background?'100 existing pools with finalized buys/sells and fee collection, distributions and token burns':'initial qualified fee jobs; no swap-load claim',backgroundPools:backgroundRecords.length,backgroundAccounting,backgroundTrades:tradeResult?{buys:tradeResult.buys,sells:tradeResult.sells,allFinalized:tradeResult.allFinalized}:null,hostedActivation:false,directory};save('report-'+attemptId+'.json',report);success=true;return report;
 }catch(error){failure=error;throw error;}finally{
  // Drain synthetic wallet actions before closing the shared registry or keys.
  tradingStop.abort();if(trading)await trading.catch(()=>{});
  for(const x of children)if(!x.ended)x.child.kill('SIGTERM');
  await Promise.all(children.map(x=>x.ended?null:new Promise(resolve=>{const timer=setTimeout(()=>{x.child.kill('SIGKILL');resolve();},35000);x.child.once('exit',()=>{clearTimeout(timer);resolve();});})));
  await scheduler?.stop();if(service)await service.close();if(pool)await pool.end();
  // Preserve a failed fixture's DB and private packet journal for diagnosis.
  if(!success&&failure){
   // Retain the failure with its classification so an environment fault is never read as a throughput result.
   const classification=classifyFleetFailure(failure,{closeObservedAt});
   try{save('failure-'+attemptId+'.json',{classification,expectation:expectation.kind,chainClock:clockMonitor.summary(),closeObservedAt,jobs:allJobs,error:String(failure.message)});}catch{}
   log({event:'fleet-failure-retained',...classification,chainClock:clockMonitor.summary()});
  }
  log({event:'fleet-fixture-retained',directory,completed:success});await control.end();for(const k of secrets)k.secretKey.fill(0);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyFleet({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,campaigns:Number(process.env.KIDS_FLEET_CAMPAIGNS||2),receipts:Number(process.env.KIDS_FLEET_RECEIPTS||8),resumeDirectory:process.env.KIDS_FLEET_RESUME||null,backgroundDirectory:process.env.KIDS_FLEET_BACKGROUND||null,capacityProfile:process.env.KIDS_FLEET_CAPACITY_PROFILE||null,expect:process.env.KIDS_FLEET_EXPECT||'launch',log:e=>console.log(JSON.stringify(e))}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});
