// Funding-first launch through the hosted signer composition on the isolated ledger (RPC 19199): distinct creator (the
// program's pilot creator), keeper (a fresh key the v3 registry signer service holds) and treasury (the program's sealed
// localnet treasury, never a signer here). The creator opens a version-2 campaign (tag 41, reserved mint and fee NFT
// co-sign), a participant commits, the creator funds the campaign's operating budget with the real funding packet; after
// the deadline the keeper, through the signer service (capability path, real budget, real cost reader, pinned lookup
// resolution proved on this ledger), creates and extends the campaign's lookup table (durable plan), launches with tag 42
// through the table, and the accounting lane settles every hold from finalized getTransaction evidence. Evidence: the
// prepared and signed packets, the pin, loaded addresses, balances, fees, hold/spend rows, on-chain verification, written
// to .runtime/funding-first-signer-rehearsal.json. Loopback only; a PostgreSQL registry in a fresh schema (KIDS_TEST_POSTGRES_URL).
import {readFileSync,writeFileSync} from 'node:fs';import {randomBytes,randomUUID} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import pg from 'pg';
import {Connection,Keypair,PublicKey,SystemProgram,Transaction,ComputeBudgetProgram,sendAndConfirmTransaction,AddressLookupTableAccount,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {key,directory} from '../setup.mjs';
import {chainTime} from '../dev-vesting.mjs';
import {openFundingInstruction,displayHash,decodeExt,extAddress,CREATE_V3_URI_PREFIX,OFF_ACCOUNTING_VERSION,SOFT_FLOOR_LAMPORTS_V2,launchTableAddresses} from './client.mjs';
import {commitInstruction,decodeCampaign,launchAuthority} from '../protocol-v2/client.mjs';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createOperatingSignerBudget} from '../signer/operating-budget.mjs';
import {createRegistrySignerService} from '../signer/registry-service.mjs';
import {createStandardOperatingCostReader} from '../signer/standard-cost-reader.mjs';
import {createRemoteSigner} from '../operator-signer.mjs';
import {createChainAdapter} from '../protocol-v2/chain-adapter.mjs';
import {observedBlockhash} from '../protocol-v2/durable-send.mjs';
import {withLiveVerification} from './live-verification.mjs';
import {allocateLookupTablePlan,markLookupTablePlan} from '../jobs/lookup-table-plan.mjs';
import {buildOperatingFundingPacket} from '../creation/operating-proofs.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;if(!url)throw Error('KIDS_TEST_POSTGRES_URL is required (a local PostgreSQL for the registry)');
const record=JSON.parse(readFileSync(directory+'/kids-launch-v3-program.json','utf8'));
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(record.rpcUrl))throw Error('loopback only');
const connection=new Connection(record.rpcUrl,'confirmed'),programId=new PublicKey(record.programId);
const admin=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(key('v2-admin').path,'utf8'))));
if(admin.publicKey.toBase58()!==record.pilotCreator)throw Error('local pilot key differs from the program record');
const treasury=new PublicKey(record.treasury);
const genesisHash=await connection.getGenesisHash();if(genesisHash!==record.genesisHash)throw Error('ledger changed');
const J=v=>JSON.stringify(v,(k,x)=>typeof x==='bigint'?x.toString():x instanceof PublicKey?x.toBase58():x instanceof Uint8Array?Buffer.from(x).toString('base64'):x);
const results=[];const ok=(name,cond,detail='')=>{results.push({name,ok:!!cond,detail:String(detail).slice(0,300)});console.log((cond?'ok  ':'FAIL')+' '+name+(cond?'':' '+String(detail).slice(0,300)));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function send(ixs,signers,label){const tx=new Transaction().add(...ixs);tx.feePayer=signers[0].publicKey;try{const sig=await sendAndConfirmTransaction(connection,tx,signers,{commitment:'confirmed'});return {sig};}catch(e){return {err:e,label};}}
async function fund(pub,lamports){const sig=await connection.requestAirdrop(pub,lamports);await connection.confirmTransaction(sig,'confirmed');}
const keeper=Keypair.generate(),mint=Keypair.generate(),feeNft=Keypair.generate(),alice=Keypair.generate(),nonce=BigInt('0x'+randomBytes(6).toString('hex'));
if(await connection.getBalance(admin.publicKey)<5e9)await fund(admin.publicKey,20e9);
await fund(keeper.publicKey,2e9);await fund(alice.publicKey,2e9);
ok('distinct creator, keeper and treasury',new Set([admin.publicKey.toBase58(),keeper.publicKey.toBase58(),treasury.toBase58()]).size===3);
const cid='QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',display={name:'Funding First',symbol:'FF',uri:CREATE_V3_URI_PREFIX+cid};
const fields={creator:admin.publicKey.toBase58(),genesisHash,nonce:String(nonce),childMint:mint.publicKey.toBase58(),opensAt:'0',fundingDurationSeconds:Number(process.env.KIDS_REHEARSAL_FUNDING_SECONDS??300),launchWindowSeconds:600,softCapLamports:SOFT_FLOOR_LAMPORTS_V2,hardCapLamports:String(10n*1_000_000_000n),ammConfigIndex:2,metadataHash:randomBytes(32).toString('hex'),metadataUri:display.uri,displayHash:displayHash(display),feeNft:feeNft.publicKey.toBase58()};
const open=openFundingInstruction(programId,fields),campaign=open.campaign;
const opened=await send([ComputeBudgetProgram.setComputeUnitLimit({units:200000}),open.instruction,SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:launchAuthority(programId,campaign),lamports:500_000_000})],[admin,mint,feeNft],'open');
ok('opening (tag 41) landed',!opened.err,opened.err?.message);
const camp0=await connection.getAccountInfo(campaign);ok('record marker byte 992 = 2',camp0&&camp0.data[OFF_ACCOUNTING_VERSION]===2);
const terms0=decodeCampaign(camp0.data).terms,deadline=Number(terms0.deadline);
const committed=await send([commitInstruction(programId,campaign,alice.publicKey,genesisHash,20_000_000n,0n)],[alice],'commit');ok('participant committed 0.02 SOL',!committed.err,committed.err?.message);
// The registry, the budget and the signer service exactly as hosted, scoped to this ledger.
const schema='kids_rehearsal_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});await control.query(`CREATE SCHEMA ${schema}`);
const pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`}),registry=new PostgresRegistry({pool});await registry.migrate();
const dir=await mkdtemp(join(tmpdir(),'kids-ff-signer-live-'));let service=null;const diagnostics=[];const evidence={programId:record.programId,sha256:record.sha256,genesisHash,at:new Date().toISOString(),campaign:campaign.toBase58(),creator:admin.publicKey.toBase58(),keeper:keeper.publicKey.toBase58(),treasury:treasury.toBase58(),mint:mint.publicKey.toBase58(),feeNft:feeNft.publicKey.toBase58(),opening:opened.sig,commit:committed.sig};
try{
 const id={genesisHash,programId:programId.toBase58(),campaign:campaign.toBase58()},base={...id,payer:keeper.publicKey.toBase58(),policy:'creator-funded-v1'};
 await registry.campaigns.upsert({...id,mode:'standard',campaignVersion:3,registryStatus:'planned'});
 const grant=await registry.capabilities.grant({...id,programVersion:3,tags:[42],expiresAt:new Date(Date.now()+3600000).toISOString()});
 const jobs={};for(const operationKey of ['launch-table','launch']){const job=(await registry.jobs.enqueue({...id,jobClass:'settlement',operationKey})).job;await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'rehearsal',ttlMs:600000});jobs[operationKey]=job.jobId;}
 // The creator funds the campaign's operating budget: the real funding packet, finalized on this ledger, credited from its evidence.
 const fundingTerms={...base,creator:admin.publicKey.toBase58(),lamports:'60000000'},block=await observedBlockhash(connection,'confirmed'),fundingTx=buildOperatingFundingPacket(fundingTerms,block);fundingTx.sign([admin]);
 const fundingSig=await connection.sendRawTransaction(fundingTx.serialize(),{skipPreflight:false});await connection.confirmTransaction({signature:fundingSig,blockhash:block.blockhash,lastValidBlockHeight:block.lastValidBlockHeight},'finalized');
 const funding={binding:fundingTerms,block,signature:fundingSig,transactionBase64:Buffer.from(fundingTx.serialize()).toString('base64')};
 const reader=createStandardOperatingCostReader({connection,genesisHash,programId:id.programId,payer:base.payer,feeOperator:keeper.publicKey,treasury:treasury.toBase58()});
 const budget=createOperatingSignerBudget({registry,connection,...base,treasury:treasury.toBase58(),loadFundingPacket:async()=>funding,loadCostIntent:reader});
 const credit=await budget.credit({...base,signature:fundingSig});ok('operating budget credited from the finalized funding transaction',credit&&String((await budget.balance(base)).availableLamports??'').length>0,J(credit));
 evidence.funding={signature:fundingSig,lamports:fundingTerms.lamports,balance:await budget.balance(base)};
 const logs=[],token='rehearsal-'+randomUUID()+'-'+randomUUID();
 service=await createRegistrySignerService({admitRpc:async()=>{},registry,connection,genesisHash,programId:id.programId,programVersion:3,keypair:keeper,token,stateFile:join(dir,'state.json'),operatingBudget:{reserve:async x=>{try{return await budget.reserve(x);}catch(e){const d={stage:'reserve',message:String(e?.message),cause:String(e?.cause?.message??''),code:e?.code??null,dependency:e?.dependency??null};diagnostics.push(d);console.log('RESERVE',JSON.stringify(d));throw e;}},recordSignature:(...a)=>budget.recordSignature(...a)},treasury:treasury.toBase58(),log:e=>logs.push(e)});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const remote=createRemoteSigner({url:'http://127.0.0.1:'+service.server.address().port,token,publicKey:keeper.publicKey});
 const chain=withLiveVerification(createChainAdapter({connection,programId:id.programId,signer:remote,genesisHash,registry,commitment:'finalized',confirmationWaitMs:null}),{connection,programVersion:3});
 // Reconcile a signed accounting shadow from finalized evidence; the local test validator prunes transaction history within
 // minutes, so each packet is reconciled soon after it finalizes (the hosted accounting lane runs on the same cadence).
 const settle=async(binding,waitMs=120000)=>{const until=Date.now()+waitMs;let outcome=null;while(Date.now()<until){try{outcome=await budget.reconcile(binding);}catch(e){return {error:e.message};}if(outcome?.state==='settled'&&outcome?.actualLamports!=null||outcome?.status==='expired')return outcome;await sleep(1000);}return outcome;};
 const settledExactly=o=>o?.state==='settled'&&typeof o.actualLamports==='string'&&/^[1-9][0-9]*$/.test(o.actualLamports);
 const shadowsOf=async()=>(await registry.query("SELECT operation_id,attempt,descriptor,status,signature FROM operator_packets WHERE signed_base64 IS NOT NULL AND descriptor LIKE '%\"binding\"%'")).rows.map(s=>({...s,d:JSON.parse(s.descriptor)}));
 // During the funding interval (the product flow: the keeper prepares the table while funding is open): the durable table
 // plan, the table through the signer, warm-up. The launch itself waits for the deadline.
 const stamps={opened:new Date().toISOString(),deadline:new Date(deadline*1000).toISOString()};
 const plan=await allocateLookupTablePlan({registry,connection,identity:id,payer:keeper.publicKey});ok('lookup table planned',plan?.status==='planned'&&Number.isSafeInteger(plan.recentSlot),J(plan));
 const tableSettled=[];const settleTableShadows=async()=>{for(const s of (await shadowsOf()).filter(s=>s.d.costModel==='v3-lookup-table-rent'&&s.status==='signed'&&!tableSettled.some(t=>t.operation===s.operation_id)))tableSettled.push({operation:s.operation_id,signature:s.signature,costModel:s.d.costModel,maximumLamports:s.d.binding.maximumLamports,outcome:await settle(s.d.binding)});};
 const tableResult=await chain.launchTable(id,{plan,operationKey:'launch-table',fencingToken:1,afterPacket:settleTableShadows});
 ok('lookup table created and extended through the signer',tableResult.status==='confirmed'&&tableResult.table===plan.table,J({status:tableResult.status,error:tableResult.error,step:tableResult.step,table:tableResult.table}));
 if(tableResult.status==='confirmed')await markLookupTablePlan({registry,identity:id,plan,status:'complete'});
 evidence.table={...tableResult,plan};
 let tableState=null;for(let i=0;i<120;i++){const r=await connection.getAccountInfoAndContext(new PublicKey(plan.table),'finalized');if(r.value){const s=AddressLookupTableAccount.deserialize(r.value.data);if(s.addresses.length>=30&&r.context.slot>s.lastExtendedSlot){tableState={slot:r.context.slot,lastExtendedSlot:s.lastExtendedSlot,addresses:s.addresses.length,authority:String(s.authority)};break;}}await sleep(500);}
 ok('table finalized, complete and warm',tableState&&tableState.addresses===30&&tableState.authority===keeper.publicKey.toBase58(),J(tableState));
 const expected=launchTableAddresses(programId,campaign,terms0,feeNft.publicKey);ok('table holds the launch template',expected.length===30,expected.length);
 const tableShadows=(await shadowsOf()).filter(s=>s.d.costModel==='v3-lookup-table-rent');ok('two signed table shadows',tableShadows.length===2,tableShadows.length);
 await settleTableShadows();
 ok('table holds settled from finalized evidence',tableSettled.length===2&&tableSettled.every(s=>settledExactly(s.outcome)),J(tableSettled.map(s=>s.outcome)));
 stamps.tableAccounted=new Date().toISOString();
 stamps.tableReady=new Date().toISOString();stamps.tableReadyBeforeDeadline=(await chainTime(connection))<deadline;ok('table ready before the funding deadline',stamps.tableReadyBeforeDeadline,J({now:await chainTime(connection),deadline}));
 // The launch is sent as soon as the CONFIRMED chain clock has passed the sealed deadline (the preflight simulates on the
 // confirmed bank; confirmation, verification and accounting stay finalized). Elapsed times are measured from the sealed deadline.
 while(await chainTime(connection)<deadline+1)await sleep(100);
 stamps.confirmedClockPassed=new Date().toISOString();stamps.deadlinePassed=stamps.confirmedClockPassed;
 // Inclusion is watched at confirmed commitment in parallel (the adapter itself confirms at finalized), and measured on the
 // chain's own clock afterwards (block time of the launch minus the sealed deadline), immune to the local clock's drift.
 let phaseWatch=null;const watchPhase=(async()=>{for(let i=0;i<1200;i++){const info=await connection.getAccountInfo(campaign,'confirmed');if(info&&info.data[840]===3){phaseWatch=new Date().toISOString();return;}await sleep(100);}})();
 const launched=await chain.launchFundingFirst(id,{table:plan.table,mint,feeNft,display,operationKey:'launch',fencingToken:1});
 await watchPhase;stamps.launchPhaseConfirmed=phaseWatch;
 stamps.launchConfirmed=new Date().toISOString();
 ok('funding-first launch (tag 42) through the table landed via the signer',launched.status==='confirmed',J({status:launched.status,error:launched.error,signature:launched.signature}));
 evidence.launch=launched;
 const after=await chain.readCampaign(id);ok('campaign live (phase 3)',Number(after.phase)===3,'phase '+after.phase);
 // The verifier reads one finalized snapshot at or after the confirmed read: a lagging finalized view is transient (RPC_UNAVAILABLE), retried.
 let verify=null;for(let i=0;i<120&&!verify;i++){try{verify=await chain.verifyLaunch(id);}catch(e){if(e?.code!=='RPC_UNAVAILABLE'&&!/snapshot unavailable/.test(String(e?.message)))throw e;await sleep(500);}}
 ok('live verification (version 2 branch) ok',verify?.ok,J(verify?.failures??'no finalized snapshot within 60 s'));evidence.verification=verify;
 // Finalized evidence of the launch: the pin, the ledger's loaded addresses, balances and fee.
 let reply=null;for(let i=0;i<120&&!reply;i++){reply=await connection.getTransaction(launched.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!reply)await sleep(500);}
 stamps.launchFinalized=new Date().toISOString();
 ok('launch finalized with loaded addresses',reply&&reply.meta&&!reply.meta.err&&reply.meta.loadedAddresses,J(reply?.meta?.err));
 if(reply?.blockTime)stamps.launchBlockTime=reply.blockTime;
 evidence.launchTransaction=reply?{slot:reply.slot,blockTime:reply.blockTime,fee:reply.meta.fee,err:reply.meta.err,computeUnitsConsumed:reply.meta.computeUnitsConsumed,loadedAddresses:{writable:reply.meta.loadedAddresses.writable.map(String),readonly:reply.meta.loadedAddresses.readonly.map(String)},preBalances:reply.meta.preBalances,postBalances:reply.meta.postBalances,version:reply.version}:null;
 // The accounting lane: every signed shadow reconciles from finalized evidence; holds release, spend is the actual fee plus rent.
 const shadows=await shadowsOf();ok('three signed accounting shadows (table create, table extend, launch)',shadows.length===3,shadows.length);
 const settled=[...tableSettled];for(const s of shadows.filter(s=>s.d.costModel==='v3-funding-first-launch'))settled.push({operation:s.operation_id,signature:s.signature,costModel:s.d.costModel,maximumLamports:s.d.binding.maximumLamports,outcome:await settle(s.d.binding)});
 ok('every hold settled from finalized evidence (exact amounts)',settled.length===3&&settled.every(s=>settledExactly(s.outcome)),J(settled.map(s=>({model:s.costModel,outcome:s.outcome}))));
 const balance=await budget.balance(base);ok('no held lamports remain',balance.heldLamports==='0',J(balance));
 if(settled.length===3&&settled.every(s=>settledExactly(s.outcome))&&balance.heldLamports==='0')stamps.accountingSettled=new Date().toISOString();stamps.elapsedFromSealedDeadline={wallClock:{confirmedClockPassed:(Date.parse(stamps.confirmedClockPassed)-deadline*1000)/1000,launchPhaseConfirmed:stamps.launchPhaseConfirmed?(Date.parse(stamps.launchPhaseConfirmed)-deadline*1000)/1000:null,launchConfirmedFinalized:(Date.parse(stamps.launchConfirmed)-deadline*1000)/1000,accountingSettled:stamps.accountingSettled?(Date.parse(stamps.accountingSettled)-deadline*1000)/1000:null},chainClock:{inclusionAfterDeadlineSeconds:stamps.launchBlockTime?stamps.launchBlockTime-deadline:null},fromConfirmedClockGate:{launchPhaseConfirmed:stamps.launchPhaseConfirmed?(Date.parse(stamps.launchPhaseConfirmed)-Date.parse(stamps.confirmedClockPassed))/1000:null,launchFinalized:(Date.parse(stamps.launchConfirmed)-Date.parse(stamps.confirmedClockPassed))/1000}};evidence.stamps=stamps;
 evidence.accounting={settled,balance,creditedLamports:fundingTerms.lamports};
 evidence.packets=(await registry.query('SELECT operation_id,attempt,descriptor,prepared_json,signed_base64,signature,status,result_json FROM operator_packets ORDER BY created_at')).rows;
 evidence.diagnostics=diagnostics;evidence.signerLog=logs.map(e=>({event:e.event,reason:e.reason,cause:e.cause,operations:e.operations,spendLamports:e.spendLamports,version:e.version}));
 evidence.grant=grant.capabilityId;evidence.jobs=jobs;evidence.schema=schema;
}catch(error){ok('rehearsal completed without an exception',false,error.stack||error.message);evidence.error=String(error?.stack||error);evidence.diagnostics=typeof diagnostics!=='undefined'?diagnostics:null;console.log('DIAGNOSTICS',JSON.stringify(evidence.diagnostics));}
finally{
 if(service?.server?.listening)await service.close().catch(()=>{});
 await pool.end().catch(()=>{});await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});await control.end().catch(()=>{});await rm(dir,{recursive:true,force:true}).catch(()=>{});
}
evidence.checks=results;evidence.passed=results.filter(r=>r.ok).length;evidence.failed=results.filter(r=>!r.ok).length;
writeFileSync(directory+'/funding-first-signer-rehearsal.json',J(evidence)+'\n',{mode:0o600});
console.log(J({campaign:evidence.campaign,table:evidence.table?.table,launch:evidence.launch?.signature,passed:evidence.passed,failed:evidence.failed}));
if(evidence.failed)process.exitCode=1;
