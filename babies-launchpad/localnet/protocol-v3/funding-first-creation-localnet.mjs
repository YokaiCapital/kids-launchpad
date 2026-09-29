// Funding-first round on the isolated ledger (RPC 19199) through the REAL creator services and the hosted signer composition:
// the pilot creator's one wallet approval opens the round (tag 41; the encrypted inventory reserves the fee NFT beside the
// reserved mint and co-signs the exact offer), the executor broadcasts the exact bytes and proves the finalized opening from
// the immutable commitments, registration and the operating reserve credit follow from the same packet; a participant
// commits; during funding the keeper (through the signer service: capability path, real budget credited by the creator's
// reserve, real cost reader, pinned lookup resolution) creates and extends the campaign's table; after the deadline the
// keeper launches with tag 42 through the table, the custody co-signing the journaled packet; the accounting lane settles
// every hold from finalized evidence. Evidence: .runtime/funding-first-creation-rehearsal.json. Loopback only; PostgreSQL in
// a fresh schema (KIDS_TEST_POSTGRES_URL); test-only vanity mint keys ('…kids') from KIDS_REHEARSAL_MINT_KEYS (JSON files).
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';import {randomBytes,randomUUID} from 'node:crypto';import {tmpdir} from 'node:os';import {join} from 'node:path';
import pg from 'pg';
import {Connection,Keypair,PublicKey,Transaction,VersionedTransaction,sendAndConfirmTransaction,AddressLookupTableAccount} from '@solana/web3.js';
import {key,directory} from '../setup.mjs';
import {chainTime} from '../dev-vesting.mjs';
import {decodeExt,extAddress,OFF_ACCOUNTING_VERSION,SOFT_FLOOR_LAMPORTS_V2,launchTableAddresses} from './client.mjs';
import {commitInstruction,decodeCampaign,AMM_CONFIG_TIERS} from '../protocol-v2/client.mjs';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {readPresets,presetTerms,presetsHash} from '../registry/presets.mjs';
import {createOperatingSignerBudget} from '../signer/operating-budget.mjs';
import {createRegistrySignerService} from '../signer/registry-service.mjs';
import {createStandardOperatingCostReader} from '../signer/standard-cost-reader.mjs';
import {createRemoteSigner} from '../operator-signer.mjs';
import {createChainAdapter} from '../protocol-v2/chain-adapter.mjs';
import {withLiveVerification} from './live-verification.mjs';
import {allocateLookupTablePlan,markLookupTablePlan} from '../jobs/lookup-table-plan.mjs';
import {createCreationStore} from '../creation/store.mjs';
import {createMetadataPublisher} from '../creation/publication.mjs';
import {createLocalCreatorServices} from '../creation/services.mjs';
import {loadOperatingFundingPacket} from '../creation/operating-reserve.mjs';
import {contentHash} from '../creation/pinata.mjs';
import {PINATA_GATEWAY} from '../token-metadata.mjs';
import {createFundingFirstCustody} from '../mints/funding-first-custody.mjs';
import {SqliteVanityMintInventory} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/mint-inventory.js';
import {SqliteLaunchExecutionStore} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/sqlite-execution-store.js';
import {verifySignature} from '../../shared/solana.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;if(!url)throw Error('KIDS_TEST_POSTGRES_URL is required (a local PostgreSQL for the registry)');
const keyFiles=(process.env.KIDS_REHEARSAL_MINT_KEYS??'').split(',').map(s=>s.trim()).filter(Boolean);if(!keyFiles.length)throw Error('KIDS_REHEARSAL_MINT_KEYS is required (test-only vanity mint keypair files)');
const record=JSON.parse(readFileSync(directory+'/kids-launch-v3-program.json','utf8'));
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(record.rpcUrl))throw Error('loopback only');
const connection=new Connection(record.rpcUrl,'confirmed'),programId=new PublicKey(record.programId);
const admin=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(key('v2-admin').path,'utf8'))));
if(admin.publicKey.toBase58()!==record.pilotCreator)throw Error('local pilot key differs from the program record');
const treasury=new PublicKey(record.treasury),owner=admin.publicKey.toBase58();
const genesisHash=await connection.getGenesisHash();if(genesisHash!==record.genesisHash)throw Error('ledger changed');
const J=v=>JSON.stringify(v,(k,x)=>typeof x==='bigint'?x.toString():x instanceof PublicKey?x.toBase58():x instanceof Uint8Array?Buffer.from(x).toString('base64'):x);
const results=[];const ok=(name,cond,detail='')=>{results.push({name,ok:!!cond,detail:String(detail).slice(0,300)});console.log((cond?'ok  ':'FAIL')+' '+name+(cond?'':' '+String(detail).slice(0,300)));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),stamp=()=>new Date().toISOString();
async function fund(pub,lamports){const sig=await connection.requestAirdrop(pub,lamports);await connection.confirmTransaction(sig,'confirmed');}
const keeper=Keypair.generate(),alice=Keypair.generate();
if(await connection.getBalance(admin.publicKey)<5e9)await fund(admin.publicKey,20e9);
await fund(keeper.publicKey,2e9);await fund(alice.publicKey,2e9);
ok('distinct creator, keeper and treasury',new Set([owner,keeper.publicKey.toBase58(),treasury.toBase58()]).size===3);
const fundingSeconds=Number(process.env.KIDS_REHEARSAL_FUNDING_SECONDS??300);
// The registry, the inventory and the creator services exactly as composed for a rehearsal, scoped to this ledger.
const schema='kids_rehearsal_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});await control.query(`CREATE SCHEMA ${schema}`);
const pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`}),registry=new PostgresRegistry({pool});await registry.migrate();
const dir=mkdtempSync(join(tmpdir(),'kids-ff-creation-live-'));let service=null,inventory=null;const diagnostics=[];const evidence={programId:record.programId,sha256:record.sha256,genesisHash,at:stamp(),creator:owner,keeper:keeper.publicKey.toBase58(),treasury:treasury.toBase58(),fundingSeconds};
const stamps={};
try{
 inventory=new SqliteVanityMintInventory({databasePath:join(dir,'inventory.sqlite'),executionStore:new SqliteLaunchExecutionStore(join(dir,'executions.sqlite')),keyId:'rehearsal',encryptionKey:randomBytes(32),fallbackToOrdinaryMint:false});
 for(const file of keyFiles){const kp=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file,'utf8')))),mint=kp.publicKey.toBase58();if(!mint.endsWith('kids'))throw Error('vanity key does not end in kids: '+mint);const sealed=inventory.encrypt(Buffer.from(kp.secretKey),mint);inventory.db.prepare("INSERT INTO kids_mints VALUES(?,?,?,?,'available',?,NULL)").run(mint,sealed.nonce,sealed.ciphertext,sealed.tag,stamp());}
 const manifest=readPresets(),tier=AMM_CONFIG_TIERS.find(t=>t.index===2);manifest.agreed.feePolicy={...manifest.agreed.feePolicy,ammConfig:tier.address.toBase58(),ammConfigIndex:2,tradeFeeBps:Number(tier.tradeFeeRate)/100};
 const terms={...presetTerms(manifest,{mode:'standard',capPresetId:'default'}).terms,softCapLamports:SOFT_FLOOR_LAMPORTS_V2,hardCapLamports:String(10n*1_000_000_000n),fundingDurationSeconds:fundingSeconds,launchWindowSeconds:600};
 const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:record.rpcUrl,genesisHash,programId:record.programId,pilotCreator:owner,treasury:treasury.toBase58(),policyHash:presetsHash(manifest),planHash:'b'.repeat(64),oneTransaction:true,operatingPayer:keeper.publicKey.toBase58(),operatingReserveLamports:'60000000',priorityFeeLamports:'10000',fundingFirst:true};
 const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]),sha=contentHash(bytes),receipt=input=>{const cid=input.cid??'Qm'+(input.stage==='image'?'a':'b').repeat(44);return {cid,uri:PINATA_GATEWAY+cid,inputHash:input.inputHash};};
 const publisher=createMetadataPublisher({registry,config,limits:{ownerPins:40,globalPins:40,ownerBytes:100000,globalBytes:100000},loadOwnedImage:async()=>({owner,assetId:'owned-pfp',sanitized:true,sha256:sha,bytes,contentType:'image/png'}),provider:{publish:async input=>receipt(input),recover:async input=>receipt(input)}});
 const store=createCreationStore(registry),draft={name:'Funding First Live',symbol:'FFLIVE',description:'Creator-approved text.',pfp:{assetId:'owned-pfp',sha256:sha},start:'after-creation'};
 await registry.drafts.save({creator:owner,id:'live',revision:0,body:draft});
 const q=await store.issue({owner,draftId:'live',revision:1,draftHash:canonicalHash(draft),descriptorHash:canonicalHash({draftId:'live'}),requestKey:'live',body:{genesisHash,programId:record.programId,policyHash:config.policyHash,planHash:config.planHash,terms,costs:{lines:[{item:'mint account rent',lamports:'1461600'}]},authorityFunding:{amountLamports:'500000000'},operatingReserveLamports:'60000000',fundingEnabled:false,publicationConsent:true}});
 const requestId=(await store.accept({owner,quoteId:q.id})).id,input={requestId};
 const services=createLocalCreatorServices({registry,connection,config,inventory,publisher}),flow=services.flow;
 // --- The creator's journey: reservation, publication + sealed plan (custody reserved), one wallet approval.
 stamps.started=stamp();
 ok('status: reservation first',(await flow.status(owner,input)).stage==='reservation');await flow.prepare(owner,input);
 for(let i=0;i<60&&(await flow.status(owner,input)).stage==='publication';i++)await flow.prepare(owner,input);
 let s=await flow.status(owner,input);ok('status: launch stage, funding-first, one approval pending',s.stage==='launch'&&s.fundingFirst===true&&s.action==='prepare',J({stage:s.stage,fundingFirst:s.fundingFirst,action:s.action}));
 const intent=await services.mintPlans.load(requestId);ok('sealed plan is version 3 naming the custody fee NFT',intent.version===3&&intent.fundingFirst?.feeNft===inventory.fundingFirstCustody(intent.mint)?.feeNft,J({version:intent.version,mint:intent.mint,feeNft:intent.fundingFirst?.feeNft}));
 evidence.requestId=requestId;evidence.mint=intent.mint;evidence.feeNft=intent.fundingFirst.feeNft;evidence.campaign=intent.campaign;
 const offer=await flow.prepare(owner,input);const otx=VersionedTransaction.deserialize(Buffer.from(offer.result.transactionBase64,'base64'));
 ok('offer: sign-launch with three signature slots and the fee NFT in the review',offer.result.action==='sign-launch'&&otx.signatures.length===3&&offer.result.review.feeNft===intent.fundingFirst.feeNft,J({action:offer.result.action,slots:otx.signatures.length}));
 evidence.offer={offerId:offer.result.offerId,bytes:otx.serialize().length,review:offer.result.review};
 otx.sign([admin]);stamps.approved=stamp();
 await flow.submit(owner,{requestId,stage:'launch',offerId:offer.result.offerId,transactionBase64:Buffer.from(otx.serialize()).toString('base64')});
 s=await flow.status(owner,input);ok('approval journaled (prepared)',s.state==='prepared'&&s.action==='resume',J({state:s.state,action:s.action}));
 // --- Custody co-signature, broadcast of the exact bytes, finalized opening evidence, registration, reserve credit.
 await flow.resume(owner,input);
 const row=await services.mintApprovals.read(requestId);const signed=VersionedTransaction.deserialize(Buffer.from(row.signedBase64,'base64')),msg=Buffer.from(signed.message.serialize());
 ok('custody co-signed the exact offer (creator, mint, fee NFT)',row.status!=='prepared'&&verifySignature(owner,msg,signed.signatures[0])&&verifySignature(intent.mint,msg,signed.signatures[1])&&verifySignature(intent.fundingFirst.feeNft,msg,signed.signatures[2]),row.status);
 evidence.opening={signature:row.signature,bytes:signed.serialize().length};
 let opened=null;for(let i=0;i<180&&!opened;i++){const r=await flow.resume(owner,input);s=await flow.status(owner,input);if(s.stage!=='launch')opened=s;else if(s.state==='expired'||s.state==='failed'){opened=s;break;}else await sleep(1000);}
 stamps.openingFinalized=stamp();
 const minted=await services.mintApprovals.read(requestId);
 ok('opening finalized: evidence from the immutable commitments (accounting version 2, no token)',minted.status==='finalized'&&minted.result?.mintEvidence?.accountingVersion===2&&minted.result.mintEvidence.tokenCreated===false&&minted.result.mintEvidence.feeNft===intent.fundingFirst.feeNft,J({status:minted.status,evidence:minted.result?.mintEvidence?{slot:minted.result.mintEvidence.slot,opensAt:minted.result.mintEvidence.opensAt,deadline:minted.result.mintEvidence.deadline}:null}));
 evidence.openingEvidence=minted.result?.mintEvidence??null;
 const campaign=new PublicKey(intent.campaign),camp0=await connection.getAccountInfo(campaign,'finalized');ok('record marker byte 992 = 2 on this ledger',camp0&&camp0.data[OFF_ACCOUNTING_VERSION]===2);
 const ext0=await connection.getAccountInfo(extAddress(programId,campaign),'finalized');const ext=ext0?decodeExt(ext0.data):null;ok('extension names the sealed mint and the custody fee NFT',ext&&ext.mint===intent.mint&&ext.feeNft===intent.fundingFirst.feeNft&&ext.version===2,J(ext));
 const terms0=decodeCampaign(camp0.data).terms,deadline=Number(terms0.deadline);stamps.deadline=new Date(deadline*1000).toISOString();
 for(let i=0;i<20&&(await flow.status(owner,input)).stage==='registration';i++)await flow.resume(owner,input);
 while(await publisher.tickSealed());const pins=(await registry.query('SELECT stage,state,cid FROM creation_publications WHERE request_id=? ORDER BY stage',[requestId])).rows;
 ok('metadata sealed with the local content ids at the click and pinned in the background (scripted provider agrees)',pins.length===2&&pins.every(p=>p.state==='published')&&PINATA_GATEWAY+pins[0].cid===intent.metadata.uri,J(pins));
 s=await flow.status(owner,input);ok('registered with accounting version 2 and the fee NFT',s.stage!=='registration'&&(await registry.campaigns.get({genesisHash,programId:record.programId,campaign:intent.campaign}))?.terms?.accountingVersion===2,J({stage:s.stage,state:s.state}));
 for(let i=0;i<20&&(await flow.status(owner,input)).stage==='operating-reserve';i++)await flow.resume(owner,input);
 s=await flow.status(owner,input);ok('creator flow complete and funded: the reserve credited from the opening packet',s.stage==='complete'&&s.state==='funded'&&s.operatingReserve?.lamports==='60000000'&&s.operatingReserve.signature===row.signature,J({stage:s.stage,state:s.state,reserve:s.operatingReserve}));
 stamps.creatorComplete=stamp();evidence.creatorFlow={stage:s.stage,state:s.state,signatures:s.signatures,operatingReserve:s.operatingReserve};
 // --- A participant commits (tag 2 on the version-2 record).
 const commitTx=new Transaction().add(commitInstruction(programId,campaign,alice.publicKey,genesisHash,20_000_000n,0n));commitTx.feePayer=alice.publicKey;
 let committed=null;try{committed=await sendAndConfirmTransaction(connection,commitTx,[alice],{commitment:'confirmed'});}catch(e){ok('participant committed 0.02 SOL',false,e.message);}
 if(committed)ok('participant committed 0.02 SOL',true);evidence.commit=committed;
 // --- The keeper through the signer service: capability, launch jobs, the budget the creator's reserve credited.
 const id={genesisHash,programId:record.programId,campaign:intent.campaign},base={...id,payer:keeper.publicKey.toBase58(),policy:'creator-funded-v1'};
 const grant=await registry.capabilities.grant({...id,programVersion:3,tags:[42],expiresAt:new Date(Date.now()+3600000).toISOString()});
 const jobs={};for(const [jobClass,operationKey] of [['settlement','launch-table'],['launch','launch']]){const job=(await registry.jobs.enqueue({...id,jobClass,operationKey})).job;await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'rehearsal',ttlMs:900000});jobs[operationKey]=job.jobId;}
 const reader=createStandardOperatingCostReader({connection,genesisHash,programId:id.programId,payer:base.payer,feeOperator:keeper.publicKey,treasury:treasury.toBase58()});
 const budget=createOperatingSignerBudget({registry,connection,...base,treasury:treasury.toBase58(),loadFundingPacket:loadOperatingFundingPacket(registry),loadCostIntent:reader});
 const balance0=await budget.balance(base);ok('keeper budget holds the creator\'s reserve (60,000,000 lamports available)',balance0?.availableLamports==='60000000',J(balance0));evidence.budgetAfterCredit=balance0;
 const logs=[],token='rehearsal-'+randomUUID()+'-'+randomUUID();
 service=await createRegistrySignerService({admitRpc:async()=>{},registry,connection,genesisHash,programId:id.programId,programVersion:3,keypair:keeper,token,stateFile:join(dir,'state.json'),operatingBudget:{reserve:async x=>{try{return await budget.reserve(x);}catch(e){const d={stage:'reserve',message:String(e?.message),cause:String(e?.cause?.message??''),code:e?.code??null,dependency:e?.dependency??null};diagnostics.push(d);console.log('RESERVE',JSON.stringify(d));throw e;}},recordSignature:(...a)=>budget.recordSignature(...a)},treasury:treasury.toBase58(),log:e=>logs.push(e)});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const remote=createRemoteSigner({url:'http://127.0.0.1:'+service.server.address().port,token,publicKey:keeper.publicKey});
 const chain=withLiveVerification(createChainAdapter({connection,programId:id.programId,signer:remote,genesisHash,registry,commitment:'finalized',confirmationWaitMs:null}),{connection,programVersion:3});
 const settle=async(binding,waitMs=120000)=>{const until=Date.now()+waitMs;let outcome=null;while(Date.now()<until){try{outcome=await budget.reconcile(binding);}catch(e){return {error:e.message};}if(outcome?.state==='settled'&&outcome?.actualLamports!=null||outcome?.status==='expired')return outcome;await sleep(1000);}return outcome;};
 const settledExactly=o=>o?.state==='settled'&&typeof o.actualLamports==='string'&&/^[1-9][0-9]*$/.test(o.actualLamports);
 const shadowsOf=async()=>(await registry.query("SELECT operation_id,attempt,descriptor,status,signature FROM operator_packets WHERE signed_base64 IS NOT NULL AND descriptor LIKE '%\"binding\"%'")).rows.map(x=>({...x,d:JSON.parse(x.descriptor)}));
 // During funding: the durable table plan, the table through the signer, warm-up, holds settled per packet.
 const plan=await allocateLookupTablePlan({registry,connection,identity:id,payer:keeper.publicKey});ok('lookup table planned',plan?.status==='planned'&&Number.isSafeInteger(plan.recentSlot),J(plan));
 const tableSettled=[];const settleTableShadows=async()=>{for(const x of (await shadowsOf()).filter(x=>x.d.costModel==='v3-lookup-table-rent'&&x.status==='signed'&&!tableSettled.some(t=>t.operation===x.operation_id)))tableSettled.push({operation:x.operation_id,signature:x.signature,costModel:x.d.costModel,maximumLamports:x.d.binding.maximumLamports,outcome:await settle(x.d.binding)});};
 const tableResult=await chain.launchTable(id,{plan,operationKey:'launch-table',fencingToken:1,afterPacket:settleTableShadows});
 ok('lookup table created and extended through the signer',tableResult.status==='confirmed'&&tableResult.table===plan.table,J({status:tableResult.status,error:tableResult.error,step:tableResult.step}));
 if(tableResult.status==='confirmed')await markLookupTablePlan({registry,identity:id,plan,status:'complete'});
 evidence.table={...tableResult,plan};
 let tableState=null;for(let i=0;i<120;i++){const r=await connection.getAccountInfoAndContext(new PublicKey(plan.table),'finalized');if(r.value){const st=AddressLookupTableAccount.deserialize(r.value.data);if(st.addresses.length>=30&&r.context.slot>st.lastExtendedSlot){tableState={slot:r.context.slot,lastExtendedSlot:st.lastExtendedSlot,addresses:st.addresses.length,authority:String(st.authority)};break;}}await sleep(500);}
 ok('table finalized, complete and warm',tableState&&tableState.addresses===30&&tableState.authority===keeper.publicKey.toBase58(),J(tableState));
 ok('table holds the launch template',launchTableAddresses(programId,campaign,terms0,new PublicKey(intent.fundingFirst.feeNft)).length===30);
 await settleTableShadows();ok('table holds settled from finalized evidence',tableSettled.length===2&&tableSettled.every(x=>settledExactly(x.outcome)),J(tableSettled.map(x=>x.outcome)));
 stamps.tableReady=stamp();stamps.tableReadyBeforeDeadline=(await chainTime(connection))<deadline;ok('table ready before the funding deadline',stamps.tableReadyBeforeDeadline,J({now:await chainTime(connection),deadline}));
 // After the deadline on the confirmed clock: the launch, the custody co-signing the journaled packet through the trusted adapter.
 const custody=createFundingFirstCustody({inventory,registry,connection,genesisHash,programId:id.programId});
 const coSignCalls=[];const coSign=async(tx,ref)=>{coSignCalls.push({attempt:ref.attempt,operationId:ref.operationId});const out=await custody.signLaunch({mint:ref.mint,campaign:ref.campaign,keeper:ref.keeper,packet:Buffer.from(tx.serialize()).toString('base64'),lookups:ref.lookups,packetRef:{operationId:ref.operationId,attempt:ref.attempt},operationKey:ref.operationKey,fencingToken:ref.fencingToken});return VersionedTransaction.deserialize(Buffer.from(out.transactionBase64,'base64'));};
 while(await chainTime(connection)<deadline+1)await sleep(100);
 stamps.confirmedClockPassed=stamp();
 let phaseWatch=null;const watchPhase=(async()=>{for(let i=0;i<1200;i++){const info=await connection.getAccountInfo(campaign,'confirmed');if(info&&info.data[840]===3){phaseWatch=stamp();return;}await sleep(100);}})();
 const display={name:intent.metadata.name,symbol:intent.metadata.symbol,uri:intent.metadata.uri};
 const launched=await chain.launchFundingFirst(id,{table:plan.table,display,coSign,operationKey:'launch',fencingToken:1});
 await watchPhase;stamps.launchPhaseConfirmed=phaseWatch;stamps.launchConfirmed=stamp();
 ok('funding-first launch (tag 42) landed: keeper via the signer, mint and fee NFT via the custody',launched.status==='confirmed',J({status:launched.status,error:launched.error,signature:launched.signature,coSignCalls}));
 evidence.launch=launched;evidence.coSignCalls=coSignCalls;
 ok('custody journal: one opening and one launch signature',J(inventory.fundingFirstCustody(intent.mint)?.signatures.map(x=>x.step+':'+x.generation))===J(['launch:0','opening:0']),J(inventory.fundingFirstCustody(intent.mint)?.signatures));
 const after=await chain.readCampaign(id);ok('campaign live (phase 3)',Number(after.phase)===3,'phase '+after.phase);
 let verify=null;for(let i=0;i<120&&!verify;i++){try{verify=await chain.verifyLaunch(id);}catch(e){if(e?.code!=='RPC_UNAVAILABLE'&&!/snapshot unavailable/.test(String(e?.message)))throw e;await sleep(500);}}
 ok('live verification (version 2 branch) ok',verify?.ok,J(verify?.failures??'no finalized snapshot within 60 s'));evidence.verification=verify;
 let reply=null;for(let i=0;i<120&&!reply;i++){reply=await connection.getTransaction(launched.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!reply)await sleep(500);}
 stamps.launchFinalized=stamp();ok('launch finalized with loaded addresses',reply&&reply.meta&&!reply.meta.err&&reply.meta.loadedAddresses,J(reply?.meta?.err));
 if(reply?.blockTime)stamps.launchBlockTime=reply.blockTime;
 evidence.launchTransaction=reply?{slot:reply.slot,blockTime:reply.blockTime,fee:reply.meta.fee,err:reply.meta.err,computeUnitsConsumed:reply.meta.computeUnitsConsumed,loadedAddresses:{writable:reply.meta.loadedAddresses.writable.map(String),readonly:reply.meta.loadedAddresses.readonly.map(String)},preBalances:reply.meta.preBalances,postBalances:reply.meta.postBalances,version:reply.version}:null;
 const shadows=await shadowsOf();ok('three signed accounting shadows (table create, table extend, launch)',shadows.length===3,shadows.length);
 const settled=[...tableSettled];for(const x of shadows.filter(x=>x.d.costModel==='v3-funding-first-launch'))settled.push({operation:x.operation_id,signature:x.signature,costModel:x.d.costModel,maximumLamports:x.d.binding.maximumLamports,outcome:await settle(x.d.binding)});
 ok('every hold settled from finalized evidence (exact amounts)',settled.length===3&&settled.every(x=>settledExactly(x.outcome)),J(settled.map(x=>({model:x.costModel,outcome:x.outcome}))));
 const balance=await budget.balance(base);ok('no held lamports remain',balance.heldLamports==='0',J(balance));
 if(settled.length===3&&settled.every(x=>settledExactly(x.outcome))&&balance.heldLamports==='0')stamps.accountingSettled=stamp();
 stamps.elapsedFromSealedDeadline={confirmedClockPassed:(Date.parse(stamps.confirmedClockPassed)-deadline*1000)/1000,launchPhaseConfirmed:stamps.launchPhaseConfirmed?(Date.parse(stamps.launchPhaseConfirmed)-deadline*1000)/1000:null,launchConfirmedFinalized:(Date.parse(stamps.launchConfirmed)-deadline*1000)/1000,accountingSettled:stamps.accountingSettled?(Date.parse(stamps.accountingSettled)-deadline*1000)/1000:null,chainClockInclusion:stamps.launchBlockTime?stamps.launchBlockTime-deadline:null};
 stamps.creatorJourneySeconds={approvalToOpeningFinalized:(Date.parse(stamps.openingFinalized)-Date.parse(stamps.approved))/1000,approvalToComplete:(Date.parse(stamps.creatorComplete)-Date.parse(stamps.approved))/1000};
 evidence.accounting={settled,balance,creditedLamports:'60000000'};
 evidence.packets=(await registry.query('SELECT operation_id,attempt,descriptor,status,signature FROM operator_packets ORDER BY created_at')).rows;
 evidence.diagnostics=diagnostics;evidence.signerLog=logs.map(e=>({event:e.event,reason:e.reason,cause:e.cause,operations:e.operations,spendLamports:e.spendLamports,version:e.version}));
 evidence.grant=grant.capabilityId;evidence.jobs=jobs;evidence.schema=schema;
}catch(error){ok('rehearsal completed without an exception',false,error.stack||error.message);evidence.error=String(error?.stack||error);evidence.diagnostics=diagnostics;console.log('DIAGNOSTICS',JSON.stringify(diagnostics));}
finally{
 if(service?.server?.listening)await service.close().catch(()=>{});
 try{inventory?.close();}catch{}
 await pool.end().catch(()=>{});await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});await control.end().catch(()=>{});rmSync(dir,{recursive:true,force:true});
}
evidence.stamps=stamps;evidence.checks=results;evidence.passed=results.filter(r=>r.ok).length;evidence.failed=results.filter(r=>!r.ok).length;
writeFileSync(directory+'/funding-first-creation-rehearsal.json',J(evidence)+'\n',{mode:0o600});
console.log(J({campaign:evidence.campaign,opening:evidence.opening?.signature,table:evidence.table?.table,launch:evidence.launch?.signature,passed:evidence.passed,failed:evidence.failed,stamps}));
if(evidence.failed)process.exitCode=1;
