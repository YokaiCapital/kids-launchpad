// Explicit fresh-mint LOCALNET test. Uses the existing encrypted inventory;
// no deployment, live wallet, hosted provider, public creation or worker activation.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {Connection,Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY,VersionedTransaction} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {readPresets,presetTerms,presetsHash} from '../registry/presets.mjs';
import {AMM_CONFIG_TIERS} from '../protocol-v2/client.mjs';
import {quoteCampaignCosts} from '../budgets.mjs';
import {qualifyInventory} from '../mints/qualify-inventory.mjs';
import {createMintLeases} from '../mints/leases.mjs';
import {createCreationStore} from './store.mjs';
import {createPreparationService} from './preparation.mjs';
import {createMintApprovalJournal} from './mint-approval.mjs';
import {createMintPlanService} from './mint-plan.mjs';
import {createMintWalletService} from './mint-wallet.mjs';
import {createMetadataPublisher} from './publication.mjs';
import {contentHash} from './pinata.mjs';
import {PINATA_GATEWAY} from '../token-metadata.mjs';
import {createCreatorFlow} from './creator-flow.mjs';
import {quoteAuthorityFunding} from './setup-funding.mjs';
import {createProvisionPlanService} from './provision-plan.mjs';
import {createProvisionExecutor} from './provision-execution.mjs';
import {createProvisionRecovery} from './provision-recovery.mjs';
import {createProvisionWalletService} from './provision-wallet.mjs';
import {createProvisionRegistrar} from './provision-registration.mjs';
import {provisionIntentHash,buildProvisionPacket} from './provision-packet.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function qualifyCreatorSetup({postgresUrl,log=()=>{},approveOffer=null}){
 if(!postgresUrl)throw Error('Explicit test PostgreSQL required');
 const manifest=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v3-program.json',import.meta.url),'utf8'));
 if(manifest.network!=='localnet'||manifest.programVersion!==3||manifest.rpcUrl!=='http://127.0.0.1:19199')throw Error('Isolated local v3 ledger required');
 const connection=new Connection(manifest.rpcUrl,'confirmed');if(await connection.getGenesisHash()!==manifest.genesisHash)throw Error('Ledger identity mismatch');
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1});let pool,creator;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:postgresUrl,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const policy=readPresets(),tier=AMM_CONFIG_TIERS[0];policy.agreed.feePolicy={...policy.agreed.feePolicy,ammConfig:tier.address.toBase58(),ammConfigIndex:2,tradeFeeBps:200};
  const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:manifest.rpcUrl,genesisHash:manifest.genesisHash,programId:manifest.programId,pilotCreator:manifest.pilotCreator,treasury:manifest.treasury,policyHash:presetsHash(policy),planHash:canonicalHash({scope:'local-creator-recovery-qualification'})};
  let mintPlans,preparation;
  const imageBytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]),imageHash=contentHash(imageBytes);
  const mintReport=await qualifyInventory({programVersion:3,registry,log,mintPlan:{seal:id=>mintPlans.seal(config.pilotCreator,id),load:id=>mintPlans.load(id)},prepare:async({inventory})=>{
   const owner=config.pilotCreator,draftId=randomUUID(),draft={name:'KIDS local rehearsal',symbol:'LocalTest',description:'Local qualification only.',pfp:{assetId:'qualification-pfp',sha256:imageHash},start:'after-creation',publicationConsent:true};
   await registry.drafts.save({creator:owner,id:draftId,revision:0,body:draft});
   // Synthetic reserve review only; not a production fee or provider quote.
   const costs=JSON.parse(JSON.stringify(quoteCampaignCosts({live:{ammCreationFeeLamports:150000000n},counts:{transactions:8,signatures:11,ataCreates:9,lockedPositions:1,feeStates:1}}),(_,v)=>typeof v==='bigint'?String(v):v));
   const body={terms:presetTerms(policy,{mode:'standard',capPresetId:'default'}).terms,costs,authorityFunding:quoteAuthorityFunding(costs),genesisHash:config.genesisHash,programId:config.programId,policyHash:config.policyHash,planHash:config.planHash,fundingEnabled:false,publicationConsent:true};
   const store=createCreationStore(registry),quote=await store.issue({owner,draftId,revision:1,draftHash:canonicalHash(draft),requestKey:draftId,descriptorHash:canonicalHash(body),body});await store.accept({owner,quoteId:quote.id});
   preparation=createPreparationService({registry,connection,config,mintLeases:createMintLeases({registry,inventory})});
   // Synthetic publication receipts: no credentials, uploads or hosted Pinata claim.
   const receipt=input=>{const cid='Qm'+(input.stage==='image'?'a':'b').repeat(44);return {cid,uri:PINATA_GATEWAY+cid,inputHash:input.inputHash};};
   const publisher=createMetadataPublisher({registry,config,limits:{ownerPins:4,globalPins:4,ownerBytes:10000,globalBytes:10000},loadOwnedImage:async()=>({owner,assetId:'qualification-pfp',sanitized:true,sha256:imageHash,bytes:imageBytes,contentType:'image/png'}),provider:{publish:async input=>receipt(input),recover:async input=>receipt(input)}});
   mintPlans=createMintPlanService({registry,connection,config,publisher});
   return preparation.prepare(owner,{draftId});
  }});
  const mint=JSON.parse(readFileSync(join(mintReport.directory,'intent.json'),'utf8'));
  const mintApprovals=createMintApprovalJournal({registry,connection,config,loadIntent:async()=>mint,mintLeases:registry.mintLeases});
  const plans=createProvisionPlanService({registry,connection,config,mintPlans,mintApprovals});
  const executor=()=>createProvisionExecutor({registry,connection,config,loadIntent:plans.load});
  const recovery=createProvisionRecovery({registry,connection,config,plans,executor:executor()});
  const wallet=()=>createProvisionWalletService({registry,connection,config,plans,executor:executor(),recovery});
  const registrar=createProvisionRegistrar({registry,config,loadIntent:plans.load,executor:executor()});
  const unused=async()=>{throw Error('Minting must not be repeated by setup orchestration');};
  const flow=()=>createCreatorFlow({registry,config,preparation,mintPlans,mintApprovals,mintWallet:createMintWalletService({registry,connection,config,plans:mintPlans,approvals:mintApprovals}),mintExecutor:{resume:unused},signReservedMint:unused,provisionPlans:plans,provisionWallet:wallet(),registrar});
  const flowInput={requestId:mint.requestId};
  assert.equal((await flow().status(mint.creator,flowInput)).stage,'setup-plan');
  assert.equal((await flow().prepare(mint.creator,flowInput)).stage,'native-custody');
  const original=await plans.load(mint.requestId);
  creator=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(manifest.adminKeyFile,'utf8'))));assert.equal(creator.publicKey.toBase58(),mint.creator);
  const signatures=[];
  async function finish(stage){
   const input={requestId:mint.requestId,stage},view=await flow().prepare(mint.creator,input),offer=view.result;assert.equal(offer.action,'sign-setup');
   let approval;
   if(approveOffer){
    const request=await createCreationStore(registry).status(mint.creator,(await flow().status(mint.creator,flowInput)).draftId);
    approval=await approveOffer({owner:mint.creator,request,stage,flow:flow(),sign:encoded=>{
     const tx=VersionedTransaction.deserialize(Buffer.from(encoded,'base64'));
     // The harness wallet may only approve this exact server offer. The key
     // remains in the Node process; no key or signer capability reaches Chrome.
     assert.deepEqual(tx.message.serialize(),VersionedTransaction.deserialize(Buffer.from(offer.transactionBase64,'base64')).message.serialize());
     tx.sign([creator]);return Buffer.from(tx.serialize()).toString('base64');
    }});
   }else{
    const tx=VersionedTransaction.deserialize(Buffer.from(offer.transactionBase64,'base64'));tx.sign([creator]);
    approval=(await flow().submit(mint.creator,{...input,offerId:offer.offerId,transactionBase64:Buffer.from(tx.serialize()).toString('base64')})).result;
   }
   let crashed=false;await createProvisionExecutor({registry,connection,config,loadIntent:plans.load,checkpoint:async phase=>{if(phase==='broadcast'){crashed=true;throw Error('synthetic process loss');}}}).resume(mint.requestId,stage).catch(e=>{if(e.message!=='synthetic process loss')throw e;});assert.ok(crashed);
   let result;const until=Date.now()+90000;while(Date.now()<until){result=(await flow().resume(mint.creator,input)).result;if(result.status==='complete')break;if(result.status==='attention')throw Error('Setup attention: '+result.reason);await sleep(500);}assert.equal(result.status,'complete');assert.equal(result.signature,approval.signature);signatures.push({stage,signature:result.signature});log({event:'setup-finalized',stage,signature:result.signature});
  }
  await finish('native-custody');
  // Deliberately let the original immediate opening age out without ever
  // broadcasting a campaign. Recovery must retain the original native receipt.
  let now;const until=Date.now()+90000;
  do{now=(await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'finalized')).data.readBigInt64LE(32);if(now>BigInt(original.opensAt)+31n)break;await sleep(500);}while(Date.now()<until);
  assert.ok(now>BigInt(original.opensAt)+30n);
  assert.equal((await flow().prepare(mint.creator,{requestId:mint.requestId,stage:'create-campaign'})).result.action,'review-schedule');
  const recovered=(await flow().recover(mint.creator,{requestId:mint.requestId,stage:'create-campaign',expectedIntentHash:provisionIntentHash(original)})).result;assert.equal(recovered.generation,2);
  assert.equal((await executor().resume(mint.requestId,'native-custody')).signature,signatures[0].signature);
  await finish('create-campaign');
  const current=await plans.load(mint.requestId);
  assert.equal((await flow().status(mint.creator,flowInput)).stage,'registration');
  assert.equal((await flow().resume(mint.creator,flowInput)).stage,'complete');
  assert.equal((await flow().resume(mint.creator,flowInput)).action,'none');
  assert.equal((await registrar.register(mint.creator,mint.requestId)).status,'registered');assert.equal((await registrar.register(mint.creator,mint.requestId)).workerActivation,false);assert.equal(await registry.campaigns.count(),1);
  const balance=await connection.getBalance(new PublicKey(mint.authority),'finalized');assert.equal(String(balance),current.authorityBudgetLamports);
  const duplicate=buildProvisionPacket(current,'create-campaign',await connection.getLatestBlockhash('confirmed'));duplicate.sign([creator]);assert.ok((await connection.simulateTransaction(duplicate,{sigVerify:true,commitment:'confirmed'})).value.err);assert.equal(await connection.getBalance(new PublicKey(mint.authority),'finalized'),balance);
  const report={network:'localnet',genesisHash:config.genesisHash,programId:config.programId,mint:mint.mint,campaign:mint.campaign,mintSignature:mintReport.signature,signatures,generation:current.generation,originalOpensAt:original.opensAt,recoveredOpensAt:current.opensAt,setupReserveLamports:String(balance),privateRegistration:true,joinedSetupFlowVerified:true,browserApprovalDriver:!!approveOffer,duplicateFundingPrevented:true,workerActivation:false,metadataPublished:false,directory:mintReport.directory,scope:'local-creator-setup-recovery-not-wallet-extension-or-production-qualification'};
  writeFileSync(join(mintReport.directory,'creator-setup-report.json'),JSON.stringify(report,null,2),{mode:0o600});return report;
 }finally{creator?.secretKey.fill(0);if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyCreatorSetup({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,log:x=>console.log(JSON.stringify(x))}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
