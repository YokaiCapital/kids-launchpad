// Orchestration contract tests. Signing, PostgreSQL races and chain evidence have
// separate integration suites; these injected services deliberately move no money.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCreatorFlow} from './creator-flow.mjs';
import {provisionFixture} from '../test/helpers/provision-fixture.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {mintIntentHash,createMintIntent,provisionIntentFromMint} from './mint-packet.mjs';
import {provisionIntentHash,reviewedProvisionPolicy} from './provision-packet.mjs';
import {CREATE_V3_URI_PREFIX} from '../protocol-v3/client.mjs';
import {Keypair} from '@solana/web3.js';
function fixture({one=false}={}){
 const {intent,quote}=provisionFixture(),m=intent.mint,owner=m.creator,id=m.requestId,payer=Keypair.generate().publicKey.toBase58();
 // One creation transaction: a version-2 mint intent carries the launch; the chain fixes the opening time when it runs.
 const mint=one?createMintIntent({preparation:{programVersion:3,state:'reserved',fundingEnabled:false,requestId:id,leaseId:m.leaseId,genesisHash:m.genesisHash,programId:m.programId,campaign:m.campaign,authority:m.authority,nonce:m.nonce,mint:m.mint},creator:owner,rentLamports:m.rentLamports,metadata:{...m.metadata,uri:CREATE_V3_URI_PREFIX+'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'},
  launch:{policy:reviewedProvisionPolicy(quote),treasury:intent.treasury,opensAt:'0',authorityBudgetLamports:intent.authorityBudgetLamports,reserve:{payer,lamports:'100000000'},priorityFeeLamports:'10000'}}):m,opensAt='1800000000';
 const config={mode:'localnet-rehearsal',oneTransaction:one,programVersion:3,rpcUrl:'http://127.0.0.1:19199',pilotCreator:owner,genesisHash:mint.genesisHash,programId:mint.programId,treasury:intent.treasury,policyHash:quote.policyHash,planHash:quote.planHash};
 const draft={name:mint.metadata.name,symbol:mint.metadata.symbol,start:'after-creation'},body={draft,draftHash:canonicalHash(draft),quote:{...quote,costs:{lines:[{item:'mint account rent',lamports:mint.rentLamports}]},authorityFunding:{amountLamports:intent.authorityBudgetLamports},genesisHash:config.genesisHash,programId:config.programId,fundingEnabled:false,publicationConsent:true}};
 const saved={request_id:id,owner,draft_id:'draft',state:'accepted',body:JSON.stringify(body)};
 const state={prepared:false,published:false,mint:null,setup:false,stages:{'native-custody':'awaiting-approval','create-campaign':'awaiting-approval'},registered:null,lease:{creator:owner,mint:mint.mint,signerRef:'reserved-key',state:'reserved'},retry:null};
 const calls=[];const effect=name=>calls.push(name);
 const registry={driver:'postgres',query:async(sql,args)=>{
  if(sql.includes('FROM creation_requests'))return {rows:args[0]===id&&args[1]===owner?[saved]:[]};
  if(sql.includes('FROM creation_mint_plans'))return {rows:state.published?[{request_id:id}]:[]};
  if(sql.includes('FROM creation_provision_plans'))return {rows:state.setup?[{request_id:id}]:[]};
  if(sql.includes('FROM creation_publications'))return {rows:state.published?[{stage:'image',state:'published'},{stage:'document',state:'published'}]:[]};
  throw Error('Unexpected flow query');
 },mintLeases:{get:async()=>state.lease},campaigns:{get:async()=>state.registered}};
 const services={registry,config,
  preparation:{status:async()=>state.prepared?{state:'reserved',mint:mint.mint,campaign:mint.campaign}:null,prepare:async()=>{effect('reserve');state.prepared=true;return {state:'reserved'};}},
  mintPlans:{load:async()=>mint,seal:async()=>{effect('publish');state.published=true;return {status:'sealed'};}},
  mintApprovals:{find:async()=>state.mint,pendingRetry:async()=>state.retry,captureSigned:async(_id,packet)=>{assert.equal(packet,'signer-packet');effect('capture');state.mint.status='signed';state.mint.signature='mint-signature';state.lease.signature='mint-signature';}},
  mintWallet:{prepare:async()=>{effect('mint-offer');return {action:'sign-mint',offerId:'mint-offer'};},submit:async()=>{effect('mint-submit');state.mint={status:'prepared',attempt:1};state.lease.state='signed-pending';return {status:'prepared'};},recover:async()=>{effect('mint-recover');state.retry={generation:1,previousSignature:'mint-signature'};return {action:'prepare-mint'};}},
  signReservedMint:async input=>{assert.deepEqual(input,{creator:owner,draftId:'asset:'+id,idempotencyKey:'asset:'+id,reservationId:'reserved-key'});effect('sign-inventory');return {transactionBase64:'signer-packet'};},
  mintExecutor:{resume:async()=>{effect('mint-resume');state.mint.status='finalized';state.mint.result={mintEvidence:{intentHash:mintIntentHash(mint),...(one?{opensAt}:{})}};state.lease.state='consumed';return {status:'minted'};}},
  provisionPlans:{load:async()=>intent,seal:async()=>{effect('seal-setup');state.setup=true;return {status:'sealed'};}},
  provisionWallet:{status:async(_,{stage})=>({status:state.stages[stage],signature:state.stages[stage]==='awaiting-approval'?null:stage+'-signature'}),prepare:async(_,{stage})=>{effect(stage+'-offer');return {action:'sign-setup',stage,offerId:stage};},submit:async(_,{stage})=>{effect(stage+'-submit');state.stages[stage]='signed';return {status:'signed'};},resume:async(_,{stage})=>{effect(stage+'-resume');state.stages[stage]='finalized';return {status:'complete'};},recover:async(_,{stage})=>{effect(stage+'-recover');state.stages[stage]='awaiting-approval';return {action:'prepare-setup'};}},
  registrar:{register:async()=>{effect('register');state.registered={creator:owner,mint:mint.mint,campaignVersion:3,terms:{provisionIntentHash:provisionIntentHash(intent)}};return {status:'registered',workerActivation:false};},
   registerFromCreation:async(o,requestId)=>{assert.equal(o,owner);assert.equal(requestId,id);effect('register-from-creation');state.registered={creator:owner,mint:mint.mint,campaignVersion:3,terms:{provisionIntentHash:provisionIntentHash(provisionIntentFromMint(mint,opensAt))}};return {status:'registered',workerActivation:false};}},
 };
 return {services,state,calls,owner,id,saved,payer,opensAt,open:()=>createCreatorFlow(services)};
}
test('creator flow resumes one accepted launch through distinct approvals; reads never sign or send',async()=>{
 const f=fixture(),{owner,id,calls}=f,input={requestId:id};
 const status=()=>f.open().status(owner,input);
 const read=async stage=>{const before=calls.length,s=await status();assert.equal(s.stage,stage);assert.equal(s.fundingEnabled,false);assert.equal(s.workerActivation,false);assert.equal(calls.length,before);return s;};
 await read('reservation');await f.open().prepare(owner,input);await read('publication');await f.open().prepare(owner,input);await read('mint');
 const offer=await f.open().prepare(owner,input);assert.equal(offer.result.action,'sign-mint');assert.equal(calls.includes('sign-inventory'),false);
 await f.open().submit(owner,{...input,stage:'mint',offerId:'mint-offer',transactionBase64:'creator-packet'});assert.equal((await read('mint')).state,'prepared');
 await f.open().resume(owner,input);await read('setup-plan');assert.deepEqual(calls.slice(-3),['sign-inventory','capture','mint-resume']);
 await f.open().prepare(owner,input);
 for(const stage of ['native-custody','create-campaign']){
  assert.equal((await read(stage)).state,'awaiting-approval');const prepared=await f.open().prepare(owner,input);assert.equal(prepared.result.stage,stage);
  await f.open().submit(owner,{...input,stage,offerId:stage,transactionBase64:'creator-packet'});assert.equal((await read(stage)).state,'signed');await f.open().resume(owner,input);
 }
 await read('registration');await f.open().resume(owner,input);const complete=await read('complete');assert.equal(complete.state,'registered');
 const before=calls.length;await f.open().resume(owner,input);await f.open().prepare(owner,input);assert.equal(calls.length,before);
 assert.deepEqual(complete.signatures,{mint:'mint-signature','native-custody':'native-custody-signature','create-campaign':'create-campaign-signature'});
});
test('an accepted request is read and continued after the active presets changed (its quoted policy is pinned)',async()=>{
 const f=fixture();const services={...f.services,config:{...f.services.config,policyHash:'b'.repeat(64),planHash:'c'.repeat(64)}};
 const s=await createCreatorFlow(services).status(f.owner,{requestId:f.id});assert.equal(s.stage,'reservation');assert.equal(s.review.policyHash,JSON.parse(f.saved.body).quote.policyHash,'the review carries the quoted policy');
 await createCreatorFlow(services).prepare(f.owner,{requestId:f.id});assert.deepEqual(f.calls,['reserve']);
});
test('foreign owner, request substitution and changed accepted terms never invoke side effects',async()=>{
 const f=fixture();for(const method of ['status','prepare','submit','resume','recover']){
  await assert.rejects(f.open()[method]('foreign',{requestId:f.id}));await assert.rejects(f.open()[method](f.owner,{requestId:'foreign'}));
 }
 const body=JSON.parse(f.saved.body);body.draft.name='Changed';f.saved.body=JSON.stringify(body);await assert.rejects(f.open().prepare(f.owner,{requestId:f.id}));assert.deepEqual(f.calls,[]);
 assert.throws(()=>createCreatorFlow({...f.services,config:{...f.services.config,mode:'mainnet'}}));
});
test('expiry pauses for explicit recovery and fresh approval instead of automatically re-signing',async()=>{
 const f=fixture();f.state.prepared=true;f.state.published=true;f.state.mint={status:'expired',signature:'mint-signature',attempt:1};f.state.lease.state='signed-pending';
 const s=await f.open().resume(f.owner,{requestId:f.id});assert.equal(s.action,'recover');assert.deepEqual(f.calls,[]);
 await assert.rejects(f.open().recover(f.owner,{requestId:f.id,stage:'create-campaign'}));
 const recovered=await f.open().recover(f.owner,{requestId:f.id,stage:'mint',expectedSignature:'mint-signature'});assert.equal(recovered.state,'review-required');assert.equal(recovered.generation,1);
 await f.open().resume(f.owner,{requestId:f.id});assert.deepEqual(f.calls,['mint-recover']);
});
test('post-finality interruption finishes mint lease before advancing setup; aborted resume has no effect',async()=>{
 const f=fixture();f.state.prepared=true;f.state.published=true;f.state.mint={status:'finalized',signature:'mint-signature',result:{mintEvidence:{intentHash:mintIntentHash(await f.services.mintPlans.load())}}};f.state.lease.state='signed-pending';f.state.lease.signature='mint-signature';
 const s=await f.open().status(f.owner,{requestId:f.id});assert.equal(s.reason,'finalize-mint-reservation');
 await f.open().resume(f.owner,{requestId:f.id},{signal:{aborted:true}});assert.deepEqual(f.calls,[]);
 await f.open().resume(f.owner,{requestId:f.id});assert.deepEqual(f.calls,['mint-resume']);assert.equal((await f.open().status(f.owner,{requestId:f.id})).stage,'setup-plan');
});
test('an offer keeps its stage binding when a concurrent replica advances the snapshot',async()=>{
 const f=fixture();f.state.prepared=true;f.state.published=true;
 f.services.mintWallet.prepare=async()=>{
  f.state.mint={status:'finalized',signature:'mint-signature',result:{mintEvidence:{intentHash:mintIntentHash(await f.services.mintPlans.load())}}};
  f.state.lease.state='consumed';f.state.lease.signature='mint-signature';f.state.setup=true;
  return {action:'sign-mint',offerId:'prior-mint-offer',transactionBase64:'old-offer'};
 };
 const response=await f.open().prepare(f.owner,{requestId:f.id});assert.equal(response.stage,'native-custody');assert.equal(response.result.stage,'mint');assert.equal(response.result.requestId,f.id);
});
test('after registration the operating reserve is one more explicit approval and the flow completes as funded',async()=>{
 const f=fixture(),{owner,id}=f,input={requestId:id},mint=await f.services.mintPlans.load(),intent=await f.services.provisionPlans.load();
 f.state.prepared=true;f.state.published=true;f.state.setup=true;f.state.mint={status:'finalized',signature:'mint-signature',attempt:1,result:{mintEvidence:{intentHash:mintIntentHash(mint)}}};f.state.lease={...f.state.lease,state:'consumed',signature:'mint-signature'};
 f.state.stages={'native-custody':'finalized','create-campaign':'finalized'};f.state.registered={creator:owner,mint:mint.mint,campaignVersion:3,terms:{provisionIntentHash:provisionIntentHash(intent)}};
 assert.equal((await f.open().status(owner,input)).stage,'complete');
 await assert.rejects(f.open().submit(owner,{...input,stage:'operating-reserve',offerId:'x:1',transactionBase64:'signed'}));
 const reserve={status:'awaiting-approval',signature:null},calls=[];
 const operatingReserve={
  status:async(o,{requestId})=>{assert.equal(o,owner);assert.equal(requestId,id);return {stage:'operating-reserve',status:reserve.status,action:reserve.status==='awaiting-approval'?'prepare':reserve.status==='credited'?'none':'resume',signature:reserve.signature,lamports:'100000000',payer:'payer'};},
  prepare:async()=>{calls.push('reserve-offer');return {action:'sign-operating-reserve',offerId:'x:1',transactionBase64:'unsigned'};},
  submit:async(_,i)=>{calls.push('reserve-submit');assert.equal(i.stage,'operating-reserve');assert.equal(i.transactionBase64,'signed');reserve.status='signed';reserve.signature='reserve-signature';return {status:'signed'};},
  resume:async()=>{calls.push('reserve-resume');reserve.status='credited';return {status:'credited'};},
  recover:async()=>{calls.push('reserve-recover');return {status:'awaiting-approval'};},
 };
 const open=()=>createCreatorFlow({...f.services,operatingReserve});
 const s=await open().status(owner,input);assert.equal(s.stage,'operating-reserve');assert.equal(s.action,'prepare');assert.equal(s.signatures['operating-reserve'],null);assert.equal(s.review.operatingReserveLamports,'100000000');
 const offer=await open().prepare(owner,input);assert.equal(offer.result.action,'sign-operating-reserve');assert.equal(offer.result.stage,'operating-reserve');
 await open().submit(owner,{...input,stage:'operating-reserve',offerId:'x:1',transactionBase64:'signed'});assert.equal((await open().status(owner,input)).state,'signed');
 await open().resume(owner,input);const done=await open().status(owner,input);assert.equal(done.stage,'complete');assert.equal(done.state,'funded');assert.equal(done.signatures['operating-reserve'],'reserve-signature');assert.deepEqual(done.operatingReserve,{lamports:'100000000',payer:'payer',signature:'reserve-signature'});
 assert.deepEqual(calls,['reserve-offer','reserve-submit','reserve-resume']);
});

test('one creation transaction: one launch approval, inventory co-signature, registration and the reserve credited from the same signature',async()=>{
 const f=fixture({one:true}),{owner,id,calls,payer}=f,input={requestId:id};
 const read=async stage=>{const before=calls.length,s=await f.open().status(owner,input);assert.equal(s.stage,stage);assert.equal(s.fundingEnabled,false);assert.equal(s.workerActivation,false);assert.equal(calls.length,before);return s;};
 f.services.mintApprovals.read=async requestId=>{assert.equal(requestId,id);return {signature:'mint-signature',signedBase64:'signed-creation',prepared:{block:{blockhash:'block',lastValidBlockHeight:10}}};};
 const reserve={status:'awaiting-approval',signature:null};
 f.services.operatingReserve={
  status:async(o,{requestId})=>{assert.equal(o,owner);assert.equal(requestId,id);return {stage:'operating-reserve',status:reserve.status,signature:reserve.signature,lamports:'100000000',payer};},
  creditFromCreation:async(o,i)=>{assert.equal(o,owner);assert.deepEqual(i,{requestId:id,signature:'mint-signature',transactionBase64:'signed-creation',block:{blockhash:'block',lastValidBlockHeight:10}});calls.push('credit-from-creation');reserve.status='credited';reserve.signature='mint-signature';return {status:'credited'};},
  prepare:async()=>{throw Error('the one-transaction path never prepares a separate reserve transfer');},submit:async()=>{throw Error('never');},resume:async()=>{throw Error('never');},recover:async()=>{throw Error('never');},
 };
 await read('reservation');await f.open().prepare(owner,input);await read('publication');await f.open().prepare(owner,input);
 const s=await read('launch');assert.equal(s.state,'awaiting-approval');assert.equal(s.action,'prepare');assert.deepEqual(s.signatures,{});
 const offer=await f.open().prepare(owner,input);assert.equal(offer.result.stage,'launch');assert.equal(calls.includes('sign-inventory'),false);
 await assert.rejects(f.open().submit(owner,{...input,stage:'native-custody',offerId:'x',transactionBase64:'creator-packet'}),'no provisioning stage exists on this path');
 await f.open().submit(owner,{...input,stage:'launch',offerId:'mint-offer',transactionBase64:'creator-packet'});assert.equal((await read('launch')).state,'prepared');
 await f.open().resume(owner,input);assert.deepEqual(calls.slice(-3),['sign-inventory','capture','mint-resume']);
 const r=await read('registration');assert.equal(r.action,'resume');assert.equal(r.signatures.launch,'mint-signature');
 await f.open().resume(owner,input);assert.equal(calls.at(-1),'register-from-creation');
 const pending=await read('operating-reserve');assert.equal(pending.state,'pending');assert.equal(pending.action,'resume');assert.equal(pending.reason,'credit-from-creation');
 await f.open().resume(owner,input);assert.equal(calls.at(-1),'credit-from-creation');
 const done=await read('complete');assert.equal(done.state,'funded');assert.deepEqual(done.signatures,{launch:'mint-signature','operating-reserve':'mint-signature'});assert.deepEqual(done.operatingReserve,{lamports:'100000000',payer,signature:'mint-signature'});
 const before=calls.length;await f.open().resume(owner,input);await f.open().prepare(owner,input);assert.equal(calls.length,before);
 assert.equal(calls.includes('seal-setup'),false);assert.equal(calls.includes('register'),false);
});
test('one creation transaction: evidence without the chain opening time or a registration for other terms is a conflict, never a silent retry',async()=>{
 const f=fixture({one:true}),{owner,id}=f,mint=await f.services.mintPlans.load();
 f.state.prepared=true;f.state.published=true;f.state.mint={status:'finalized',signature:'mint-signature',attempt:1,result:{mintEvidence:{intentHash:mintIntentHash(mint)}}};f.state.lease={...f.state.lease,state:'consumed',signature:'mint-signature'};
 await assert.rejects(f.open().status(owner,{requestId:id}));
 f.state.mint.result.mintEvidence.opensAt=f.opensAt;assert.equal((await f.open().status(owner,{requestId:id})).stage,'registration');
 f.state.registered={creator:owner,mint:mint.mint,campaignVersion:3,terms:{provisionIntentHash:provisionIntentHash(provisionIntentFromMint(mint,'1800000001'))}};
 await assert.rejects(f.open().status(owner,{requestId:id}));
});

test('single transaction mode is known before reservation and artwork publication',async()=>{
 const f=fixture({one:true}),input={requestId:f.id};
 assert.equal((await f.open().status(f.owner,input)).creationMode,'single');
 await f.open().prepare(f.owner,input);
 const publication=await f.open().status(f.owner,input);
 assert.equal(publication.stage,'publication');assert.equal(publication.creationMode,'single');
});

test('slow publication returns pending promptly and joins existing work without republishing',async()=>{
 const f=fixture({one:true}),input={requestId:f.id};f.state.prepared=true;
 let finish,calls=0;const original=f.services.mintPlans.seal;
 f.services.mintPlans.seal=async(...args)=>{calls++;await new Promise(resolve=>{finish=resolve;});return original(...args);};
 const flow=f.open(),started=Date.now();const pending=await flow.prepare(f.owner,input);
 assert.equal(pending.result.status,'pending');assert.equal(pending.stage,'publication');assert.ok(Date.now()-started<5000);
 const next=flow.prepare(f.owner,input);finish();
 assert.equal((await next).stage,'launch');assert.equal(calls,1);
});
