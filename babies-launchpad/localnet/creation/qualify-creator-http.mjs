import {createVideoSanitizer} from './video-sanitizer.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createCreatorProfileReader} from './creator-profile.mjs';
// Full creator HTTP/controller rehearsal on the owned validator. Real signed
// PostgreSQL sessions, image processing, chain quotes, inventory and transactions.
// Private object storage and publication receipts are fixtures; wallet signing
// uses the owned local test key, NOT an external extension or hosted provider.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import {Connection,Keypair,PublicKey,VersionedTransaction} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {readPresets,presetsHash} from '../registry/presets.mjs';
import {mintIntentHash} from './mint-packet.mjs';
import {AMM_CONFIG_TIERS,decodeCampaign} from '../protocol-v2/client.mjs';
import {PINATA_GATEWAY} from '../token-metadata.mjs';
import {signWithSeed} from '../../shared/solana.mjs';
import {SqliteVanityMintInventory} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/mint-inventory.js';
import {SqliteLaunchExecutionStore} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/sqlite-execution-store.js';
import {runParallelMintRefill} from '../../kids-mint-worker/vendor/mint-refill-parallel.js';
import {createImageSanitizer} from './image-sanitizer.mjs';
import {composeLocalCreatorHttp} from '../../interaction-review/server/local-creator-services.mjs';
import {accountPlugin} from '../../interaction-review/server/account-plugin.mjs';
import {createApiServer} from '../../interaction-review/server/runtime.mjs';
import {initialDraft} from '../../interaction-review/src/public/launch-draft.mjs';
import {createCreatorController} from '../../interaction-review/src/public/creator-controller.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// The vanity search for one `kids` address takes about eight minutes on average with two processes; the bound is
// thirty minutes so an unlucky run does not fail the rehearsal (one did on 28 September 2026 at ten minutes).
export async function qualifyCreatorHttp({postgresUrl,log=()=>{},timeoutMs=1800000,drive=null,videoBinaries=null,oneTransaction=true,coordinated=true}){
 if(!postgresUrl)throw Error('Explicit test PostgreSQL required');
 const m=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v3-program.json',import.meta.url),'utf8'));
 if(m.network!=='localnet'||m.programVersion!==3||m.rpcUrl!=='http://127.0.0.1:19199')throw Error('Owned isolated v3 validator required');
 const connection=new Connection(m.rpcUrl,'confirmed');assert.equal(await connection.getGenesisHash(),m.genesisHash);
 const program=await connection.getAccountInfo(new PublicKey(m.programId),'finalized');assert.equal(program.executable,true);assert.equal(program.data.readUInt32LE(0),2);
 const binary=await connection.getAccountInfo(new PublicKey(program.data.subarray(4,36)),'finalized');assert.equal(createHash('sha256').update(binary.data.subarray(45,45+m.binarySize)).digest('hex'),m.sha256);
 const directory=mkdtempSync(join(tmpdir(),'kids-creator-http-')),encryptionKey=randomBytes(32),records=new SqliteLaunchExecutionStore(join(directory,'executions.sqlite'));
 writeFileSync(join(directory,'encryption.json'),JSON.stringify({key:encryptionKey.toString('hex')}),{mode:0o600,flag:'wx'});
 const inventory=new SqliteVanityMintInventory({databasePath:join(directory,'inventory.sqlite'),executionStore:records,keyId:'local-http-qualification',encryptionKey,fallbackToOrdinaryMint:false});
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1});let pool,runtime,creator,controller,timer,poll,services;
 const abort=new AbortController();
 try{
  async function ensureStock(){
  timer=setTimeout(()=>abort.abort(),timeoutMs);poll=setInterval(()=>{if(inventory.counts().available>0)abort.abort();},100);
  await runParallelMintRefill({inventory,signal:abort.signal,processes:2,webParent:false,report:r=>log({event:'http-mint-grinding',...r})});clearTimeout(timer);clearInterval(poll);
  if(inventory.counts().available<1)throw Error('No kids mint found within qualification bound');
  }
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:postgresUrl,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  creator=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(m.adminKeyFile,'utf8'))));assert.equal(String(creator.publicKey),m.pilotCreator);
  const manifest=readPresets();manifest.agreed.feePolicy={...manifest.agreed.feePolicy,ammConfig:AMM_CONFIG_TIERS[0].address.toBase58(),ammConfigIndex:2,tradeFeeBps:200};
  // One creation transaction (the hosted product path) unless the older four-approval path is requested explicitly.
  const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:m.rpcUrl,genesisHash:m.genesisHash,programId:m.programId,pilotCreator:m.pilotCreator,treasury:m.treasury,...(oneTransaction?{oneTransaction:true,priorityFeeLamports:'10000'}:{})};
  const objects=new Map(),storage={storageId:createHash('sha256').update(directory).digest('hex'),verifyPrivacy:async()=>true,put:async(k,image)=>{objects.set(k,image);return {sha256:image.sha256,byteCount:image.bytes.length};},read:async k=>objects.get(k)};
  const receipt=input=>{const cid='Qm'+(input.stage==='image'?'a':'b').repeat(44);return {cid,uri:PINATA_GATEWAY+cid,inputHash:input.inputHash};};
  const args={registry,connection,config,coordinated:coordinated&&oneTransaction,manifest,setupPlan:{version:'local-http-v3',counts:{transactions:8,signatures:11,ataCreates:9,lockedPositions:1,feeStates:1},priorityFeeLamports:'10000',marginBps:1500},inventory,storage,sanitize:createImageSanitizer(),...(videoBinaries?{sanitizeVideo:createVideoSanitizer(videoBinaries),videoLimits:{ownerAttempts:3,globalAttempts:6,ownerBytes:500000000,globalBytes:1000000000,ownerActive:1,globalActive:2}}:{}),provider:{publish:async i=>receipt(i),recover:async i=>receipt(i)},artworkLimits:{ownerAttempts:10,globalAttempts:20,ownerBytes:30000000,globalBytes:60000000,ownerActive:1,globalActive:2},publicationLimits:{ownerPins:videoBinaries?6:4,globalPins:12,ownerBytes:40000000,globalBytes:80000000}};
  services=composeLocalCreatorHttp(args);await services.start();const forwarding={canAccess:owner=>services.account.canAccess(owner),canUploadVideo:owner=>services.account.canUploadVideo(owner),handle:input=>services.account.handle(input)};
  runtime=createApiServer({probe:async()=>await connection.getGenesisHash()===m.genesisHash,probeInterval:10000,writesGate:{open:true,reconciled:true},plugins:[accountPlugin({publicLaunchService:forwarding,accountRegistry:registry,sharedAccounts:true,csrfSecret:randomBytes(32).toString('hex'),backgroundServices:false}),services.directory]});
  await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+runtime.server.address().port;
  async function httpControllerDriver(){let cookie='';
  const api=async(path,body,csrf)=>{const r=await fetch(origin+'/api/account/'+path,{method:body===undefined?'GET':'POST',headers:{origin,cookie,...(body===undefined?{}:{'content-type':'application/json','x-kids-csrf':csrf})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const result=await r.json();if(!r.ok)throw Error('HTTP '+r.status+' '+path+': '+result.error);const next=r.headers.get('set-cookie');if(next)cookie=next.split(';')[0];return result;};
  const {csrf}=await api('state'),challenge=await api('challenge',{owner:m.pilotCreator},csrf);assert.ok(challenge.message.includes('URI: '+origin));
  await api('verify',{id:challenge.id,signature:signWithSeed(Buffer.from(creator.secretKey.subarray(0,32)),Buffer.from(challenge.message)).toString('base64')},csrf);
  const png=await sharp({create:{width:64,height:64,channels:4,background:'#ff77cf'}}).png().toBuffer(),upload=await fetch(origin+'/api/account/launches/artwork/upload',{method:'POST',headers:{origin,cookie,'x-kids-csrf':csrf,'content-type':'image/png','x-kids-upload-id':'local-http-pfp','x-kids-artwork-kind':'pfp'},body:png});assert.equal(upload.status,200);const asset=(await upload.json()).artwork;
  const bannerPng=await sharp({create:{width:192,height:64,channels:4,background:'#ad82ff'}}).png().toBuffer(),bannerResponse=await fetch(origin+'/api/account/launches/artwork/upload',{method:'POST',headers:{origin,cookie,'x-kids-csrf':csrf,'content-type':'image/png','x-kids-upload-id':'local-http-banner','x-kids-artwork-kind':'banner'},body:bannerPng});assert.equal(bannerResponse.status,200);const banner=(await bannerResponse.json()).artwork;
  let video=null;if(videoBinaries){
   const file=join(directory,'qualification-video.mp4');await promisify(execFile)(videoBinaries.ffmpeg,['-v','error','-f','lavfi','-i','color=c=pink:s=320x180:r=12','-t','0.5','-c:v','libx264','-pix_fmt','yuv420p',file]);
   const response=await fetch(origin+'/api/account/launches/video/upload',{method:'POST',headers:{origin,cookie,'x-kids-csrf':csrf,'content-type':'video/mp4','x-kids-upload-id':'local-http-video'},body:readFileSync(file)});assert.equal(response.status,200);video=(await response.json()).video;assert.equal(video.status,'ready');
   const preview=await fetch(origin+'/api/account/launches/video/'+video.assetId,{headers:{origin,cookie,range:'bytes=0-31'}});assert.equal(preview.status,206);assert.equal((await preview.arrayBuffer()).byteLength,32);assert.equal(preview.headers.get('cache-control'),'private, no-store');
   const denied=await fetch(origin+'/api/account/launches/video/'+video.assetId,{headers:{origin}});assert.equal(denied.status,401);
  }
  const draft={...initialDraft(services.manifest(),{creator:m.pilotCreator}),name:'HTTP local rehearsal',symbol:'HttpTest',description:'Isolated creator qualification',pfp:asset,banner,video,videoCaption:video?'Creator video introduction':'',xUrl:'https://x.com/localcoin',websiteUrl:'https://example.com/',publicationConsent:true};
  const saved=(await api('launches/drafts/save',{id:randomUUID(),revision:0,draft},csrf)).draft;
  await ensureStock();
  await api('launches/creation/artwork',{draftId:saved.id,revision:saved.revision},csrf);await services.publisher.tickPrepublication();
  const clickedAt=Date.now();
  const quote=await api('launches/creation/quote',{draftId:saved.id,revision:saved.revision,requestId:randomUUID()},csrf),accepted=await api('launches/creation/accept',{quoteId:quote.id},csrf);assert.equal(accepted.body.quote.treasury,m.treasury);
  let approvals=0,restarted=false,approvedAt=null,confirmedAt=null,completedAt=null;const signedStages=[];
  const open=request=>createCreatorController({owner:m.pilotCreator,request,api,currentOwner:()=>m.pilotCreator,wallet:async()=>({publicKey:creator.publicKey,signTransaction:async tx=>{approvedAt??=Date.now();tx.sign([creator]);approvals++;return tx;}})});
  controller=open(accepted);await controller.refresh();const until=Date.now()+900000;let previous='';
  while(Date.now()<until){
   const state=controller.getState(),s=state.snapshot;if(s.stage==='launch'&&(s.result?.reason==='awaiting-finality'||s.confirmation?.commitment==='confirmed'))confirmedAt=confirmedAt??Date.now();if(s.stage!==previous){log({event:'creator-http-stage',stage:s.stage});previous=s.stage;}
   if(s.stage==='complete'){completedAt??=Date.now();if(!s.serverManaged||s.serverWork==='done')break;}
   if(state.offer){signedStages.push(state.offer.stage);await controller.approve();approvedAt=approvedAt??Date.now();
    if(!restarted){controller.dispose();await services.close();services=composeLocalCreatorHttp(args);await services.start();const resumed=await api('launches/creation/status',{draftId:saved.id},csrf);assert.equal(resumed.id,accepted.id);controller=open(resumed);await controller.refresh();restarted=true;log({event:'creator-http-service-restarted'});}
   }else if(s.serverManaged&&s.serverWork!=='wallet'){if(s.serverWork==='paused')throw Error('Server creation paused: '+s.serverError);await controller.refresh();}
   else if(s.action==='recover'||s.result?.action==='review-schedule')await controller.recover();
   else if(['prepare','resume'].includes(s.action))await controller.advance();
   else throw Error('Unexpected creator state '+s.stage+'/'+s.action);
   await pause(500);
  }
  const final=controller.getState().snapshot;return {final,accepted,approvals,signedStages,restarted,secondsFromFirstApprovalToConfirmed:approvedAt&&confirmedAt?(confirmedAt-approvedAt)/1000:null,secondsFromClickToConfirmed:confirmedAt?(confirmedAt-clickedAt)/1000:null,secondsFromFirstApprovalToComplete:approvedAt&&completedAt?(completedAt-approvedAt)/1000:null};
  }
  const {final,accepted,approvals,signedStages,restarted,secondsFromFirstApprovalToComplete=null,secondsFromFirstApprovalToConfirmed=null,secondsFromClickToConfirmed=null}=await (drive?drive({origin,ensureStock,manifest:services.manifest(),creator:m.pilotCreator,publicKeyBytes:Array.from(creator.publicKey.toBytes()),restart:()=>{services=composeLocalCreatorHttp(args);},signMessage:bytes=>Array.from(signWithSeed(Buffer.from(creator.secretKey.subarray(0,32)),Buffer.from(bytes))),signTransaction:bytes=>{const tx=VersionedTransaction.deserialize(Uint8Array.from(bytes));tx.sign([creator]);return Array.from(tx.serialize());}}):httpControllerDriver());
  assert.equal(final.stage,'complete');assert.equal(final.state,'funded');assert.equal(final.fundingEnabled,false);assert.equal(final.workerActivation,coordinated&&oneTransaction);assert.deepEqual(signedStages,oneTransaction?['launch']:['mint','native-custody','create-campaign','operating-reserve']);assert.equal(approvals,oneTransaction?1:4);assert.equal(restarted,true);
  // The operating reserve (option 1): the fourth approval moved exactly the sealed reserve from the creator to the payer,
  // and the campaign's operating budget shows it as funded only after that finalized transfer reconciled.
  const reserve=final.operatingReserve;assert.equal(reserve.payer,m.treasury);assert.equal(reserve.lamports,manifest.agreed.operating.reserveLamports);assert.equal(final.signatures['operating-reserve'],reserve.signature);
  if(oneTransaction)assert.equal(final.signatures.launch,reserve.signature,'the reserve is credited from the one creation transaction');
  const funding=await connection.getTransaction(reserve.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});assert.equal(funding.meta.err,null);
  const fundingKeys=funding.transaction.message.staticAccountKeys.map(String),payerIndex=fundingKeys.indexOf(m.treasury);assert.equal(fundingKeys[0],m.pilotCreator);assert.ok(payerIndex>0);
  assert.equal(BigInt(funding.meta.postBalances[payerIndex])-BigInt(funding.meta.preBalances[payerIndex]),BigInt(reserve.lamports));
  const budget=await registry.budgets.get({genesisHash:m.genesisHash,programId:m.programId,campaign:final.campaign,payer:m.treasury});assert.equal(budget.reservedLamports,reserve.lamports);assert.equal(budget.spentLamports,'0');assert.equal(budget.policy,'creator-funded-v1');
  const row=await registry.campaigns.get(final.campaign),chain=await connection.getAccountInfo(new PublicKey(final.campaign),'finalized'),decoded=decodeCampaign(chain.data);assert.equal(String(chain.owner),m.programId);assert.equal(String(decoded.terms.childMint),final.mint);assert.equal(String(decoded.terms.treasury),m.treasury);assert.equal(row.campaignVersion,3);
  if(oneTransaction){
   // The creation transaction carried everything: two signers (creator, reserved mint), eleven instructions, and the
   // program fixed the opening time from its clock when it ran.
   assert.equal(funding.transaction.signatures.length,2);assert.equal(funding.transaction.message.compiledInstructions.length,11);
   assert.ok(Math.abs(Number(decoded.terms.opensAt)-funding.blockTime)<=5,'opening time '+decoded.terms.opensAt+' vs block time '+funding.blockTime);
   assert.equal(String(decoded.terms.opensAt),final.opensAt??String(decoded.terms.opensAt));
  }
  if(!coordinated&&oneTransaction)await services.services.registrar.completeProfile(m.pilotCreator,accepted.id);
  assert.deepEqual((await registry.jobs.listForCampaign(row)).map(j=>j.jobClass).sort(),['activity-index','campaign-index',...(coordinated&&oneTransaction?['lifecycle-control']:[]),'position-index']);
  const profile=await createCreatorProfileReader(registry).read(row);assert.ok(profile.media.pfp.startsWith(PINATA_GATEWAY));assert.equal(profile.description,accepted.body.draft.description);if(!drive){assert.ok(profile.media.banner.startsWith(PINATA_GATEWAY));assert.equal(profile.links.x,'https://x.com/localcoin');}if(videoBinaries&&!drive){assert.ok(profile.media.video.startsWith(PINATA_GATEWAY));assert.ok(profile.media.poster.startsWith(PINATA_GATEWAY));assert.equal(profile.media.videoCaption,'Creator video introduction');}assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM signer_capabilities')).rows[0].n),coordinated&&oneTransaction?1:0);
  // Restart the real composed services under changed active settings (schedule 600/1200 and a doubled reserve change the policy
  // hash; a different priority fee in the setup plan changes the plan hash): the persisted funded request is served under its
  // accepted terms; status and resume change nothing; no new offer, journal row, credit or approval; the sealed intent hash and the
  // chain deadlines are untouched. The running composition is closed first so no timer of it outlives the replacement.
  const counts=async()=>({offers:Number((await registry.query('SELECT COUNT(*) n FROM creation_mint_offers WHERE request_id=?',[accepted.id])).rows[0].n),packets:Number((await registry.query('SELECT COUNT(*) n FROM operator_packets')).rows[0].n),budget:(await registry.budgets.get({genesisHash:m.genesisHash,programId:m.programId,campaign:final.campaign,payer:m.treasury})).reservedLamports});
  const beforeRestart=await counts(),intentHashBefore=mintIntentHash(await services.services.mintPlans.load(accepted.id));
  const changedManifest={...manifest,schedule:{...manifest.schedule,fundingDurationSeconds:600,launchWindowSeconds:1200},agreed:{...manifest.agreed,operating:{...manifest.agreed.operating,reserveLamports:String(BigInt(manifest.agreed.operating.reserveLamports)*2n)}}};
  assert.notEqual(presetsHash(changedManifest),presetsHash(manifest));
  const changedPlan={...args.setupPlan,priorityFeeLamports:'12000'};
  await services.close?.().catch(()=>{});services=composeLocalCreatorHttp({...args,manifest:changedManifest,setupPlan:changedPlan});
  const kept=await services.services.flow.status(m.pilotCreator,{requestId:accepted.id});
  assert.equal(kept.requestId,accepted.id);assert.equal(kept.stage,'complete');assert.equal(kept.state,'funded');assert.deepEqual(kept.signatures,final.signatures,'same signatures after the restart');
  assert.equal(kept.operatingReserve.lamports,reserve.lamports,'the accepted reserve, not the doubled one');assert.equal(kept.review.operatingReserveLamports,reserve.lamports);assert.equal(kept.review.policyHash,accepted.body.quote.policyHash,'served under the quoted policy');
  const resumed=await services.services.flow.resume(m.pilotCreator,{requestId:accepted.id});assert.equal(resumed.stage,'complete');assert.equal(resumed.action,'none');
  assert.equal(mintIntentHash(await services.services.mintPlans.load(accepted.id)),intentHashBefore,'the sealed intent is unchanged');
  assert.deepEqual(await counts(),beforeRestart,'no new offer, journal row or credit after the restart');
  const afterRestart=decodeCampaign((await connection.getAccountInfo(new PublicKey(final.campaign),'finalized')).data);assert.equal(String(afterRestart.terms.deadline),String(decoded.terms.deadline));assert.equal(String(afterRestart.terms.launchDeadline),String(decoded.terms.launchDeadline));
  assert.ok(await services.creation.status(m.pilotCreator,{draftId:accepted.draftId}),'the creation status of the accepted request is still readable');
  log({event:'creator-http-restart-under-changed-settings',requestId:accepted.id,reserveLamports:kept.operatingReserve.lamports,policyHash:kept.review.policyHash});
  const report={network:'localnet',restartUnderChangedSettings:true,requestId:accepted.id,campaign:final.campaign,mint:final.mint,signatures:final.signatures,independentApprovals:oneTransaction?1:4,oneTransaction,secondsFromClickToConfirmed,secondsFromFirstApprovalToConfirmed,secondsFromFirstApprovalToComplete,operatingReserve:{...reserve,payerBalanceDeltaLamports:String(BigInt(funding.meta.postBalances[payerIndex])-BigInt(funding.meta.preBalances[payerIndex])),budgetReservedLamports:budget.reservedLamports,fundingSlot:funding.slot},restartResume:true,finalizedRegistration:true,publishedProfile:true,publishedVideo:!!videoBinaries&&!drive,readOnlyDiscoveryJobs:3,workerActivation:coordinated&&oneTransaction,metadataProvider:'synthetic-receipts-not-hosted-publication',wallet:'owned-local-test-key-not-extension',directory};
  writeFileSync(join(directory,'report.json'),JSON.stringify(report),{mode:0o600,flag:'wx'});return report;
 }catch(e){log({event:'creator-http-failed',reason:String(e.message).slice(0,1500),recoveryDirectory:directory});throw e;}
 finally{abort.abort();clearTimeout(timer);clearInterval(poll);controller?.dispose();if(runtime)await runtime.shutdown();await services?.close();if(pool){await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}await control.end();inventory.close();records.close();creator?.secretKey.fill(0);encryptionKey.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyCreatorHttp({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,videoBinaries:process.env.KIDS_TEST_FFMPEG&&process.env.KIDS_TEST_FFPROBE?{ffmpeg:process.env.KIDS_TEST_FFMPEG,ffprobe:process.env.KIDS_TEST_FFPROBE}:null,log:r=>console.log(JSON.stringify(r))}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
