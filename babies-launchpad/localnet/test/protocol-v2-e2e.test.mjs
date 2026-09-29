// End-to-end rehearsal of programs/kids-launch-v2 on the v2 localnet (start-v2-rehearsal.mjs, deploy-kids-launch-v2.mjs):
// two Standard campaigns driven by the P3 job runner over the registry, the job handlers, the chain adapter and the
// operator signing service's capability path (fencing tokens).
//   A: create, oversubscribed commits, settle-receipts (the first runner dies after K settles, a second runner finishes
//      without settling twice), a stale runner refused by the signer, refund-receipts, launch-assert-ready, launch
//      (Raydium CPMM pool, permanent LP lock, authorities revoked), participant claims, dev claim;
//   B: create, commits below the soft cap, finalize, refund-receipts pays every lamport back.
// Skips with a plain reason when the v2 ledger or the deployed program is not there:
//   node localnet/start-v2-rehearsal.mjs            (RPC 19199; clones the canonical programs and the tier-2 config from the local 19099 ledger)
//   node localnet/deploy-kids-launch-v2.mjs         (builds with --features localnet-treasury, deploys, writes the manifest)
//   node --test localnet/test/protocol-v2-e2e.test.mjs
import test from 'node:test';import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {Connection,Keypair,PublicKey,Transaction,SystemProgram,sendAndConfirmTransaction,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {createMint,mintTo,setAuthority,AuthorityType,getAccount,getMint,getOrCreateAssociatedTokenAccount,NATIVE_MINT,createSyncNativeInstruction} from '@solana/spl-token';
import * as client from '../protocol-v2/client.mjs';
import * as policy from '../protocol-v2/policy.mjs';
import {createChainAdapter} from '../protocol-v2/chain-adapter.mjs';
import {createFeeAdapter} from '../protocol-v2/fee-adapter.mjs';
import {feeHandler,seedFeeJobs} from '../jobs/fee-handlers.mjs';
import {swapInstruction} from '../cpmm.mjs';
import {createPublicMarketWorker} from '../market/public-service.mjs';
import {createPublicMarketReader} from '../market/public-reader.mjs';
import {readCreationCosts} from '../creation/live-costs.mjs';
import {settleReceipts,refundReceipts,launchAssertReady,launch} from '../jobs/handlers.mjs';
import {createJobRunner} from '../jobs/runner.mjs';
import {openRegistry,PostgresRegistry} from '../registry/registry.mjs';
import {createSignerService} from '../signer-service.mjs';
import {loadCapabilities} from '../signer/capabilities.mjs';
import {createRemoteSigner} from '../operator-signer.mjs';
import {withReceiptBatches} from '../protocol-v3/receipt-batch.mjs';
const runtime=fileURLToPath(new URL('../.runtime/',import.meta.url));
const programVersion=Number(process.env.KIDS_ISSUER_TEST_VERSION||2);
if(![2,3].includes(programVersion))throw Error('Unsupported rehearsal issuer version');
const receiptBatchSize=process.env.KIDS_QUALIFY_RECEIPT_BATCHES==='1'?8:1;
if(receiptBatchSize>1&&programVersion!==3)throw Error('Receipt batch qualification requires the new v3 program');
const manifestPath=runtime+'kids-launch-v'+programVersion+'-program.json';
const SOL=1_000_000_000n;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function preflight(){
 if(!existsSync(manifestPath))return {skip:'kids-launch-v2 is not deployed: run node localnet/start-v2-rehearsal.mjs, then node localnet/deploy-kids-launch-v2.mjs'};
 const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
 if(programVersion===3&&manifest.programVersion!==3)throw Error('v3 manifest required');
 const rpc=process.env.KIDS_V2_RPC||manifest.rpcUrl;
 if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc))return {skip:'the v2 rehearsal runs on a loopback RPC only (got '+rpc+')'};
 const connection=new Connection(rpc,{commitment:'confirmed'});
 let genesis;try{genesis=await connection.getGenesisHash();}catch{return {skip:'no validator answers at '+rpc+': run node localnet/start-v2-rehearsal.mjs'};}
 if(genesis!==manifest.genesisHash)return {skip:'the ledger at '+rpc+' is not the one the program was deployed to: run node localnet/deploy-kids-launch-v2.mjs again'};
 const programId=new PublicKey(manifest.programId);const p=await connection.getAccountInfo(programId);
 if(!p?.executable)return {skip:'program '+manifest.programId+' is not executable on '+rpc};
 for(const [name,address] of [['Raydium CPMM',client.RAYDIUM_CPMM],['Raydium lock',client.RAYDIUM_LOCK],['Metadata',client.METADATA_PROGRAM]]){const a=await connection.getAccountInfo(address);if(!a?.executable)return {skip:name+' program is not on this ledger: start it with start-v2-rehearsal.mjs'};}
 const config=await connection.getAccountInfo(client.AMM_CONFIG_TIERS[0].address);if(!config||config.data.length!==236)return {skip:'AMM config tier 2 is not on this ledger'};
 if(!existsSync(manifest.adminKeyFile)||!existsSync(manifest.treasuryKeyFile))return {skip:'the v2 admin or treasury key file is missing'};
 return {connection,manifest,programId,genesis,rpc};
}
const pre=await preflight();
if(pre.skip&&process.env.KIDS_REQUIRE_LOCALNET_TESTS==='1')throw Error(pre.skip);
const chainTime=async connection=>{const c=await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'confirmed');return c.data.readBigInt64LE(32);};
const loadKey=path=>Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path,'utf8'))));
test('kids-launch-v'+programVersion+' end to end: two Standard campaigns through the job runner, the signing service and the real program',{skip:pre.skip,timeout:600_000},async t=>{
 const {connection,manifest,programId,genesis}=pre;
 const admin=loadKey(manifest.adminKeyFile),treasury=loadKey(manifest.treasuryKeyFile),keeper=Keypair.generate(),dev=Keypair.generate();
 const identityOf=campaign=>({genesisHash:genesis,programId:programId.toBase58(),campaign:campaign.toBase58()});
 const sendUser=async(instructions,signers,payer=admin)=>{const tx=new Transaction().add(...instructions);return sendAndConfirmTransaction(connection,tx,[payer,...signers.filter(s=>!s.publicKey.equals(payer.publicKey))],{commitment:'confirmed'});};
 const fund=async(to,lamports)=>sendUser([SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:to,lamports:Number(lamports)})],[]);
 const balance=async k=>BigInt(await connection.getBalance(k,'confirmed'));
 if(await balance(admin.publicKey)<50n*SOL){const s=await connection.requestAirdrop(admin.publicKey,Number(100n*SOL));await connection.confirmTransaction(s,'confirmed');}
 await fund(keeper.publicKey,3n*SOL);await fund(dev.publicKey,1n*SOL);
 // ---- terms of both campaigns (Standard, tier 2 on this ledger, treasury = the sealed localnet treasury) ----
 const tier=client.AMM_CONFIG_TIERS[0];
 const setupQuote=await readCreationCosts({connection,genesisHash:genesis,owner:admin.publicKey.toBase58(),ammConfig:tier.address.toBase58(),counts:{transactions:8,signatures:11,ataCreates:9,lockedPositions:1,feeStates:1},priorityFeeLamports:'10000'});
 assert.equal(setupQuote.coverage,'bounded-setup-only');assert.equal(setupQuote.evidence.tradeFeeRate,String(tier.tradeFeeRate));assert.ok(BigInt(setupQuote.costs.totalLamports)>0n);
 const now=await chainTime(connection);
 const baseTerms=(nonce,childMint,soft,hard)=>({layoutVersion:2,mode:0,decimals:6,splitPolicy:1,vestingRule:1,feeRoutingVersion:1,creatorFeeEnabled:0,genesis:new PublicKey(genesis),creator:admin.publicKey,nonce,dev:dev.publicKey,treasury:treasury.publicKey,childMint,supply:1_000_000_000_000_000n,
  opensAt:now-5n,deadline:now+45n,launchDeadline:now+45n+3600n,soft,hard,ammProgram:client.RAYDIUM_CPMM,ammConfig:tier.address,ammTradeFeeRate:tier.tradeFeeRate,ammConfigIndex:tier.index,
  feeWeights:policy.FEE_WEIGHTS_STANDARD,splitBps:policy.SPLIT_STANDARD,vesting:policy.VESTING_THREE_MONTHS,buybackMaxSlippageBps:0,lockProgram:client.RAYDIUM_LOCK,distributionProgram:PublicKey.default,
  parentMint:[PublicKey.default,PublicKey.default],parentProgram:[PublicKey.default,PublicKey.default],parentSlot:[0,0],parentRoot:['00'.repeat(32),'00'.repeat(32)],parentSupply:[0,0],parentEligible:[0,0],parentExpirySeconds:0,
  metadataHash:createHash('sha256').update('kids-launch-v2 rehearsal '+nonce).digest(),metadataUri:'https://kids.fun/rehearsal/'+childMint.toBase58()+'.json',parentReferenceConfig:[0,0]});
 // ---- campaign A: coin provisioned before creation (mint, custody with the whole supply, WSOL custody, setup budget) ----
 const nonceA=randomBytes(8).readBigUInt64LE(),mintA=await createMint(connection,admin,admin.publicKey,admin.publicKey,6);
 const termsA=baseTerms(nonceA,mintA,1n*SOL,2n*SOL),campaignA=client.campaignAddress(programId,admin.publicKey,nonceA),authorityA=client.launchAuthority(programId,campaignA);
 const custodyA=await getOrCreateAssociatedTokenAccount(connection,admin,mintA,authorityA,true),wsolA=await getOrCreateAssociatedTokenAccount(connection,admin,NATIVE_MINT,authorityA,true);
 await mintTo(connection,admin,mintA,custodyA.address,admin,termsA.supply);
 await setAuthority(connection,admin,mintA,admin,AuthorityType.MintTokens,authorityA);await setAuthority(connection,admin,mintA,admin,AuthorityType.FreezeAccount,authorityA);
 await fund(authorityA,300_000_000n);// pool rent and the 0.15 SOL create-pool fee
 const createdA=client.createInstruction(programId,termsA);assert.ok(createdA.campaign.equals(campaignA));
 await sendUser([createdA.instruction],[admin]);
 const idA=identityOf(campaignA);
 // ---- campaign B: will fail its soft cap; its coin is never provisioned (no launch can happen) ----
 const nonceB=randomBytes(8).readBigUInt64LE(),mintB=Keypair.generate().publicKey;
 const termsB=baseTerms(nonceB,mintB,2n*SOL,3n*SOL),campaignB=client.campaignAddress(programId,admin.publicKey,nonceB);
 await sendUser([client.createInstruction(programId,termsB).instruction],[admin]);
 const idB=identityOf(campaignB);
 // ---- commits ----
 const participants=Array.from({length:5},()=>Keypair.generate());
 for(const p of participants)await fund(p.publicKey,2n*SOL);
 const commitsA=[[0,800_000_000n],[1,400_000_000n],[1,500_000_000n],[2,1_000_000_000n],[3,500_000_000n],[4,123_456_789n]];
 const sequence=new Map();
 for(const [i,amount] of commitsA){const p=participants[i];const seq=sequence.get(i)??0n;await sendUser([client.commitInstruction(programId,campaignA,p.publicKey,genesis,amount,seq)],[p],p);sequence.set(i,seq+1n);}
 await assert.rejects(sendUser([client.commitInstruction(programId,campaignA,participants[0].publicKey,genesis,1n,0n)],[participants[0]],participants[0]),/custom program error: 0x4/,'a stale receipt sequence is refused');
 await assert.rejects(sendUser([client.commitInstruction(programId,campaignA,participants[0].publicKey,Keypair.generate().publicKey,1n,1n)],[participants[0]],participants[0]),/custom program error: 0xd/,'another network genesis is refused');
 const commitsB=[[0,500_000_000n],[1,700_000_000n]];
 for(const [i,amount] of commitsB){const p=participants[i];await sendUser([client.commitInstruction(programId,campaignB,p.publicKey,genesis,amount,0n)],[p],p);}
 const committedA=new Map();for(const [i,a] of commitsA)committedA.set(i,(committedA.get(i)??0n)+a);
 const totalA=[...committedA.values()].reduce((s,v)=>s+v,0n);
 // ---- the keeper signs through the signing service's capability path (one grant per campaign, program version 2) ----
 const token='v2-rehearsal-'.padEnd(40,'x');const signerLog=[];
 let registry;
 if(process.env.KIDS_V2_TEST_POSTGRES_URL){
  const schema='kids_test_'+randomUUID().replaceAll('-','');
  const control=new pg.Pool({connectionString:process.env.KIDS_V2_TEST_POSTGRES_URL,max:1});
  await control.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:process.env.KIDS_V2_TEST_POSTGRES_URL,max:4,options:`-c search_path=${schema}`});
  registry=new PostgresRegistry({pool});
  t.after(async()=>{await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();});
 }else{registry=openRegistry({path:':memory:'});t.after(()=>registry.close());}
 await registry.migrate();
 for(const [id,terms] of [[idA,termsA],[idB,termsB]]){
  await registry.campaigns.upsert({...id,mode:'standard',campaignVersion:programVersion,registryStatus:'planned',creator:admin.publicKey.toBase58(),nonce:terms.nonce.toString(),softCapLamports:terms.soft.toString(),hardCapLamports:terms.hard.toString(),deadlineUnix:Number(terms.deadline),launchDeadlineUnix:Number(terms.launchDeadline)});
  await registry.capabilities.grant({...id,kind:'keeper',programVersion,tags:[2,3,4,5,6],expiresAt:new Date(Date.now()+3_600_000).toISOString()});
 }
 const service=createSignerService({keypair:keeper,token,programId:programId.toBase58(),capabilities:async()=>(await loadCapabilities({registry})).capabilities,authorizeLease:input=>registry.capabilities.authorizeLease(input),requireCapability:true,log:l=>signerLog.push(l)});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const port=service.server.address().port;
 t.after(()=>service.server.close());
 const signer=createRemoteSigner({url:'http://127.0.0.1:'+port,token,publicKey:keeper.publicKey});
 const chainLog=[];const baseChain=createChainAdapter({connection,programId,signer,genesisHash:genesis,registry,log:l=>chainLog.push(l)});
 const chain=receiptBatchSize>1?withReceiptBatches(baseChain,{programVersion}):baseChain;
 const runnerLog=[];const BACKOFF={baseMs:200,maxMs:1000,unknownMs:300};
 const makeRunner=(owner,handlers)=>{
  const opts={registry,handlers,owner,concurrency:1,leaseTtlMs:5000,renewEveryMs:owner==='runner-1'?1_000_000:1000,backoff:BACKOFF,log:l=>runnerLog.push({owner,...l})};
  if(registry.driver!=='postgres')return createJobRunner(opts);
  const scope={genesisHash:genesis,programId:programId.toBase58(),campaignVersion:programVersion};
  const lifecycle=createJobRunner({...opts,scope,lane:'lifecycle'});
  const recovery=createJobRunner({...opts,scope,lane:'recovery',servedClasses:['refunds']});
  return {async tick(){await lifecycle.tick();await recovery.tick();}};
 };
 const jobOf=async(id,key)=>registry.jobs.get((await registry.jobs.enqueue({...id,operationKey:key,jobClass:'settlement'})).job.jobId);
 async function drive(runner,id,key,{maxMs=120_000}={}){const until=Date.now()+maxMs;let j=await jobOf(id,key);while(!['done','failed'].includes(j.state)&&Date.now()<until){await runner.tick();await sleep(150);j=await jobOf(id,key);}return j;}
 // ---- funding closes ----
 const before=await chain.readCampaign(idA);assert.equal(before.total,totalA);assert.equal(before.receiptCount,5n);
 const list=await chain.listReceipts(idA);assert.equal(list.complete,true);assert.equal(list.receipts.length,5,'getProgramAccounts enumerates every receipt of the campaign');
 assert.equal((await chain.listReceipts(idB)).receipts.length,2);
 while(await chainTime(connection)<termsA.deadline)await sleep(500);
 // ---- A: settle with a crash after K settles; a second runner finishes; nothing settles twice ----
 const K=2;let landed=0;let revive;const revived=new Promise(r=>revive=r);
 const crashing={...chain,async settle(id,r,o){const out=await chain.settle(id,r,o);if(out.status==='confirmed'){landed++;if(landed===K){await revived;return out;}}return out;}};
 await registry.jobs.enqueue({...idA,operationKey:'settle-receipts',jobClass:'settlement'});
 const runner1=makeRunner('runner-1',{settlement:settleReceipts({chain:crashing})});
 const dead=runner1.tick();dead.catch(()=>{});
 const waitUntil=Date.now()+60_000;while(landed<K&&Date.now()<waitUntil)await sleep(100);assert.equal(landed,K,'the first runner landed K settles before dying');
 const held=await jobOf(idA,'settle-receipts');assert.equal(held.state,'leased');assert.equal(held.leaseOwner,'runner-1');assert.equal(held.fencingToken,1);
 await sleep(5500);// the lease expires; nothing renewed it
 const runner2=makeRunner('runner-2',{settlement:settleReceipts({chain,batchSize:receiptBatchSize}),refunds:refundReceipts({chain,batchSize:receiptBatchSize}),'launch-assert-ready':launchAssertReady({chain,notReadyDelayMs:300}),launch:launch({chain,notReadyDelayMs:300})});
 const settled=await drive(runner2,idA,'settle-receipts');
 assert.equal(settled.state,'done',JSON.stringify(settled.result));assert.equal(settled.fencingToken,2);assert.equal(settled.result.receiptCount,5);assert.equal(settled.result.settled,5-K,'the second runner settled only what was left');
 const settlementPackets=receiptBatchSize>1?K+1:5;
 assert.equal(chain.calls.confirmed,settlementPackets,'only the two completed receipts and the remaining settlement packets landed');
 const afterSettle=await chain.readCampaign(idA);assert.equal(afterSettle.settledCount,5n);assert.equal(afterSettle.phase,0,'settlement never moves the phase; finalize or the first refund does');
 const expectedAccepted=[...committedA.values()].reduce((s,c)=>s+policy.accepted(c,totalA,termsA.hard),0n);assert.equal(afterSettle.settledAccepted,expectedAccepted);
 // the crashed runner revives: its lease is gone, so its next side effect is refused and it publishes nothing
 revive();await dead;
 assert.ok(runnerLog.some(l=>l.owner==='runner-1'&&l.event==='job-stale-runner'),'the stale runner reported itself');
 assert.equal((await jobOf(idA,'settle-receipts')).state,'done');assert.equal(chain.calls.confirmed,settlementPackets,'the revived runner sent nothing');
 // a stale runner that still tries to sign with the old fencing token is refused by the signing service
 const staleReceipt=list.receipts[0];
 await assert.rejects(chain.settle(idA,staleReceipt,{operationId:'settle:'+idA.campaign+':'+staleReceipt.address+':stale',fencingToken:1,operationKey:'settle-receipts'}),e=>e.status===409&&e.category==='stale-fencing-token');
 assert.ok(signerLog.some(l=>l.event==='signer-refused'&&l.category==='stale-fencing-token'));
 // ---- A: refunds of the over-cap excess ----
 const balancesBeforeRefund=await Promise.all(participants.map(p=>balance(p.publicKey)));
 await registry.jobs.enqueue({...idA,operationKey:'refund-receipts',jobClass:'refunds'});
 const refunded=await drive(runner2,idA,'refund-receipts');assert.equal(refunded.state,'done',JSON.stringify(refunded.result));assert.equal(refunded.result.failedCampaign,false);
 const afterRefund=await chain.readCampaign(idA);assert.equal(afterRefund.refunded,totalA-expectedAccepted,'every excess lamport is refunded');assert.equal(afterRefund.phase,1,'the first refund after the deadline records the campaign as closed and funded');
 const receiptsA=await chain.listReceipts(idA);assert.equal(receiptsA.complete,true);
 let acceptedSum=0n,refundedSum=0n;
 for(const r of receiptsA.receipts){const i=participants.findIndex(p=>p.publicKey.toBase58()===r.owner);assert.equal(r.committed,committedA.get(i));assert.equal(r.accepted,policy.accepted(r.committed,totalA,termsA.hard));assert.equal(r.accepted+r.refunded,r.committed,'conservation per receipt');acceptedSum+=r.accepted;refundedSum+=r.refunded;
  assert.equal(await balance(participants[i].publicKey)-balancesBeforeRefund[i],r.refunded,'the refund reached the owner');}
 assert.equal(acceptedSum,afterRefund.settledAccepted);assert.equal(refundedSum,afterRefund.refunded);assert.equal(acceptedSum+refundedSum,afterRefund.total,'conservation in total');
 // refunds are idempotent: a second pass sends nothing
 await registry.jobs.enqueue({...idA,operationKey:'refund-receipts:again',jobClass:'refunds'});
 const again=await drive(runner2,idA,'refund-receipts:again');assert.equal(again.state,'done');assert.equal(again.result.refunded,0);
 // ---- A: readiness, then the launch ----
 await registry.jobs.enqueue({...idA,operationKey:'launch-assert-ready',jobClass:'launch'});
 const ready=await drive(runner2,idA,'launch-assert-ready');assert.equal(ready.state,'done',JSON.stringify(ready.result));assert.equal(ready.result.ready,true);
 assert.equal((await jobOf(idA,'launch')).state,'queued','readiness enqueued the launch job');
 const launched=await drive(runner2,idA,'launch',{maxMs:180_000});
 assert.equal(launched.state,'done',JSON.stringify(launched.result)+' '+JSON.stringify(chainLog.slice(-3)));
 assert.equal(launched.result.verified,true);
 const live=await chain.readCampaign(idA);assert.equal(live.phase,3);assert.ok(live.launchTime>=termsA.deadline);
 const a=client.launchAddresses(programId,campaignA,live.terms,live.feeNft);assert.equal(live.pool,a.pool.toBase58());
 const verify=await chain.verifyLaunch(idA);assert.deepEqual(verify.failures,[]);
 // The tier-2 config is the mainnet one, creator fee rate included (offset 108); the pool it made has the creator fee off (byte 390).
 const configBytes=(await connection.getAccountInfo(tier.address,'confirmed')).data;
 assert.notEqual(configBytes.readBigUInt64LE(108),0n,'the ledger carries the mainnet config bytes: creator_fee_rate is not zeroed');
 const poolBytes=(await connection.getAccountInfo(a.pool,'confirmed')).data;assert.equal(poolBytes[390],0,'plain initialize leaves enable_creator_fee off');assert.equal(verify.checks.creatorFeeEnabled,false);
 const mintInfo=await getMint(connection,mintA);assert.equal(mintInfo.mintAuthority,null);assert.equal(mintInfo.freezeAuthority,null);
 const liquidity=live.split.liquidity;assert.equal(liquidity,policy.split(termsA.supply,policy.SPLIT_STANDARD).liquidity);
 assert.equal((await getAccount(connection,custodyA.address)).amount,termsA.supply-liquidity,'custody holds supply minus liquidity');
 const coinVault=a.mint0.equals(mintA)?a.vault0:a.vault1,solVault=a.mint0.equals(mintA)?a.vault1:a.vault0;
 assert.equal((await getAccount(connection,coinVault)).amount,liquidity,'the pool holds the liquidity reserve');
 assert.equal((await getAccount(connection,solVault)).amount,expectedAccepted,'the pool holds the accepted SOL');
 assert.equal((await getAccount(connection,wsolA.address)).amount,0n,'the WSOL custody is back to its prior balance');
 assert.equal((await getAccount(connection,a.lp)).amount,0n,'the launch authority keeps no LP');
 const locked=await getAccount(connection,a.lockVault);assert.ok(locked.amount>0n,'every LP token is locked');
 assert.equal(verify.checks.lpSupply,locked.amount+100n);
 const feeNftAccount=await getAccount(connection,a.feeNftAccount);assert.equal(feeNftAccount.amount,1n);assert.ok(feeNftAccount.owner.equals(campaignA));
 const rent=BigInt(await connection.getMinimumBalanceForRentExemption(client.CAMPAIGN_LEN));assert.equal(live.lamports,rent,'the campaign keeps its rent and nothing else once every refund is paid');
 assert.equal((await jobOf(idA,'launch')).result.pool,live.pool);
 // a second launch job is done at once and sends nothing
 const launchesBefore=chain.calls.launch;await registry.jobs.enqueue({...idA,operationKey:'launch:again',jobClass:'launch'});
 assert.equal((await drive(runner2,idA,'launch:again')).state,'done');assert.equal(chain.calls.launch,launchesBefore);
 // ---- A: claims ----
 const reserve=live.split.participants;let claimedSum=0n;
 for(const r of receiptsA.receipts){
  const i=participants.findIndex(p=>p.publicKey.toBase58()===r.owner),p=participants[i];
  const ata=await getOrCreateAssociatedTokenAccount(connection,admin,mintA,p.publicKey);
  await sendUser([client.claimParticipantInstruction(programId,campaignA,mintA,p.publicKey)],[p],p);
  const expected=policy.participantTokens(reserve,r.accepted,live.settledAccepted);
  assert.equal((await getAccount(connection,ata.address)).amount,expected,'participant '+i+' receives floor(accepted × reserve / accepted total)');claimedSum+=expected;
  await sendUser([client.claimParticipantInstruction(programId,campaignA,mintA,p.publicKey)],[p],p);// once per receipt: a repeat is a no-op
  assert.equal((await getAccount(connection,ata.address)).amount,expected);
 }
 const afterClaims=await chain.readCampaign(idA);assert.equal(afterClaims.participantClaimed,claimedSum);assert.ok(claimedSum<=reserve);
 const devAta=await getOrCreateAssociatedTokenAccount(connection,admin,mintA,dev.publicKey);
 const devSignature=await sendUser([client.claimDevInstruction(programId,campaignA,mintA,dev.publicKey)],[]);
 const devTx=await connection.getTransaction(devSignature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
 const devPaid=(await getAccount(connection,devAta.address)).amount;
 const instant=policy.share(termsA.supply,policy.VESTING_THREE_MONTHS.instantBps);
 assert.equal(devPaid,policy.devEntitled(termsA.supply,policy.VESTING_THREE_MONTHS,live.launchTime,BigInt(devTx.blockTime)),'the dev claim pays the instant share plus the linear share elapsed at the claim block');
 assert.ok(devPaid>=instant&&devPaid<instant+policy.share(termsA.supply,policy.VESTING_THREE_MONTHS.linearBps)/1000n,'the instant 1 % at launch, a sliver of the linear 2 % after a few seconds');
 assert.equal((await chain.readCampaign(idA)).devClaimed,devPaid);
 assert.equal((await getAccount(connection,custodyA.address)).amount,termsA.supply-liquidity-claimedSum-devPaid,'custody = supply − liquidity − claims');
 // ---- B: below the soft cap: finalize records the failure, refunds pay every lamport back ----
 const beforeB=await chain.readCampaign(idB);assert.equal(beforeB.total,1_200_000_000n);assert.ok(beforeB.total<termsB.soft);
 await sendUser([client.finalizeInstruction(programId,campaignB)],[]);
 assert.equal((await chain.readCampaign(idB)).phase,2,'finalize after the deadline marks a campaign below its soft cap refund-only');
 const readyB=await chain.assertReady(idB);assert.equal(readyB.ready,false);assert.equal(readyB.failed,true);
 await registry.jobs.enqueue({...idB,operationKey:'launch-assert-ready',jobClass:'launch'});
 const readinessB=await drive(runner2,idB,'launch-assert-ready');assert.equal(readinessB.state,'failed');assert.equal(readinessB.result.category,'campaign-failed');
 const balancesBeforeB=await Promise.all(participants.slice(0,2).map(p=>balance(p.publicKey)));
 await registry.jobs.enqueue({...idB,operationKey:'refund-receipts',jobClass:'refunds'});
 const refundedB=await drive(runner2,idB,'refund-receipts');assert.equal(refundedB.state,'done',JSON.stringify(refundedB.result));assert.equal(refundedB.result.failedCampaign,true);assert.equal(refundedB.result.refunded,2);
 const afterB=await chain.readCampaign(idB);assert.equal(afterB.refunded,afterB.total);assert.equal(afterB.lamports,rent,'only the rent stays');
 for(const r of (await chain.listReceipts(idB)).receipts){const i=participants.findIndex(p=>p.publicKey.toBase58()===r.owner);assert.equal(r.refunded,r.committed);assert.equal(r.accepted,0n);assert.equal(await balance(participants[i].publicKey)-balancesBeforeB[i],r.committed,'every lamport went back to its owner');}
 // ---- A: real swaps, separately leased harvest, payout and child burn ----
 await fund(treasury.publicKey,100_000_000n);
 const feeAuthority=client.feeAuthority(programId,campaignA);
 for(const [mint,owner]of [[mintA,feeAuthority],[NATIVE_MINT,feeAuthority],[NATIVE_MINT,treasury.publicKey],[NATIVE_MINT,dev.publicKey]])await getOrCreateAssociatedTokenAccount(connection,admin,mint,owner,true);
 const treasuryBefore=(await getAccount(connection,client.associatedTokenAddress(treasury.publicKey,NATIVE_MINT))).amount;
 const devBefore=(await getAccount(connection,client.associatedTokenAddress(dev.publicKey,NATIVE_MINT))).amount;
 await sendUser([client.feesInitInstruction(programId,campaignA,treasury.publicKey,keeper.publicKey)],[treasury]);
 await registry.capabilities.grant({...idA,kind:'keeper',programVersion,tags:[2,3,4,5,6,21,23,26],expiresAt:new Date(Date.now()+3_600_000).toISOString()});
 const fees=createFeeAdapter({connection,registry,chain});
 const feeScope={genesisHash:genesis,programId:programId.toBase58(),campaignVersion:programVersion};
 const feeRunner=lane=>{
  const scoped=registry.driver==='postgres';
  const servedClasses=lane==='harvest'?['fee-harvest']:['distribution','token-burn'];
  // SQLite remains a serial local adapter test, not a distributed role test.
  const kinds=scoped?servedClasses:['fee-harvest','distribution','token-burn'];
  return createJobRunner({registry,owner:'fees-'+lane,...(scoped?{lane,scope:feeScope,servedClasses}:{}),concurrency:1,backoff:BACKOFF,handlers:Object.fromEntries(kinds.map(kind=>[kind,feeHandler({chain:fees,registry,kind})]))});
 };
 const harvest=feeRunner('harvest'),economics=feeRunner('economics');
 const tradeSol=await getOrCreateAssociatedTokenAccount(connection,admin,NATIVE_MINT,admin.publicKey);
 const tradeCoin=await getOrCreateAssociatedTokenAccount(connection,admin,mintA,admin.publicKey);
 await sendUser([SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:tradeSol.address,lamports:200_000_000}),createSyncNativeInstruction(tradeSol.address)],[]);
 const pool=client.cpmmAddresses(termsA.ammProgram,termsA.ammConfig,mintA),cp={programId:termsA.ammProgram,ammConfig:termsA.ammConfig};
 await sendUser([swapInstruction(cp,pool,admin.publicKey,NATIVE_MINT,200_000_000n,1n)],[]);
 const bought=(await getAccount(connection,tradeCoin.address)).amount;assert.ok(bought>0n);
 await sendUser([swapInstruction(cp,pool,admin.publicKey,mintA,bought/2n,1n)],[]);
 if(registry.driver==='postgres')await seedFeeJobs(registry,idA);
 else await registry.jobs.enqueue({...idA,operationKey:'fee-harvest:0',jobClass:'fee-harvest'});
 const collected=await drive(harvest,idA,'fee-harvest:0');assert.equal(collected.state,'done',JSON.stringify(collected.result));assert.equal(collected.result.status,'confirmed');
 const collectedState=(await fees.snapshot(idA)).fees;assert.ok(collectedState.solCollected>0n);assert.ok(collectedState.coinPending>0n);
 if(registry.driver!=='postgres')await seedFeeJobs(registry,idA);
 assert.equal((await jobOf(idA,'distribution:0')).state,'queued','harvesting does not run or wait for economics');
 const supplyBeforeBurn=(await getMint(connection,mintA)).supply;
 const distributed=await drive(economics,idA,'distribution:0');assert.equal(distributed.state,'done',JSON.stringify(distributed.result));assert.equal(distributed.result.status,'confirmed');
 const burned=await drive(economics,idA,'token-burn:0');assert.equal(burned.state,'done',JSON.stringify(burned.result));assert.equal(burned.result.status,'confirmed');
 const finalFees=(await fees.snapshot(idA)).fees,entitled=policy.feeEntitlements(finalFees.solCollected,termsA.feeWeights);
 assert.equal(finalFees.treasuryPaid,entitled.treasury);assert.equal(finalFees.devPaid,entitled.dev);
 assert.equal((await getAccount(connection,client.associatedTokenAddress(treasury.publicKey,NATIVE_MINT))).amount-treasuryBefore,entitled.treasury);
 assert.equal((await getAccount(connection,client.associatedTokenAddress(dev.publicKey,NATIVE_MINT))).amount-devBefore,entitled.dev);
 assert.equal(finalFees.coinPending,0n);assert.equal(finalFees.coinBurned,collectedState.coinPending);
 assert.equal(supplyBeforeBurn-(await getMint(connection,mintA)).supply,finalFees.coinBurned);
 assert.equal((await getAccount(connection,a.lp)).amount,0n,'fee collection gives the keeper no unlocked LP');
 assert.equal((await getAccount(connection,a.feeNftAccount)).amount,1n,'fee rights stay in campaign custody');
 // Repeating the exact completed operation after counters changed returns its
 // journal receipt; no fresh payout/burn and no zero-amount instruction is built.
 const sendsBeforeReplay=chain.calls.sent;
 for(const kind of ['fee-harvest','distribution','token-burn'])assert.equal((await fees.runFeeOperation(idA,kind,{operationId:kind+':0',operationKey:kind+':0',fencingToken:1})).status,'confirmed');
 assert.equal(chain.calls.sent,sendsBeforeReplay);
 if(registry.driver==='postgres'){
  // Market worker reads actual finalized launch/swap/harvest transactions; only
  // swaps appear in volume. It has no wallet/signer configuration or credentials.
  await connection.confirmTransaction(burned.result.signature,'finalized');
  const policy={ratePerSecond:100,burst:100,lanes:{indexing:{ratePerSecond:50,burst:50},backfill:{ratePerSecond:50,burst:50}}};
  const worker=await createPublicMarketWorker({registry,config:{mode:'localnet-rehearsal',programVersion,lane:'indexing',genesisHash:genesis,programId:programId.toBase58(),rpcUrl:pre.rpc,concurrency:1,rpcAdmission:{resource:'e2e-market',policy}}});
  await registry.jobs.enqueue({...idA,operationKey:'market-live:0',jobClass:'market-index'});
  const indexed=await drive(worker,idA,'market-live:0');assert.equal(indexed.state,'done',JSON.stringify(indexed.result));
  const marketScope={genesis,pool:live.pool},trades=await worker.store.trades(marketScope);
  const reader=createPublicMarketReader({store:worker.store,genesisHash:genesis,programId:programId.toBase58()});
  const publicTrades=await reader.read({campaign:idA.campaign,kind:'trades'});
  assert.equal(publicTrades.status,'live');assert.equal(publicTrades.trades.length,2);assert.equal(publicTrades.openingReference.isTrade,false);assert.equal(publicTrades.coverage.complete,true);
  assert.equal(trades.trades.length,2,'launch, harvest and lock withdrawals never become trades');
  assert.deepEqual(trades.trades.map(x=>x.side).sort(),['buy','sell']);assert.equal(trades.commitment,'finalized');
  const candles=await worker.store.candles(marketScope,{from:Number(live.launchTime)-120,to:Number(await chainTime(connection))+120});
  assert.equal(candles.reduce((sum,x)=>sum+x.trades,0),2);
  const volume=trades.trades.reduce((sum,x)=>sum+BigInt(x.solLamports),0n);assert.equal(candles.reduce((sum,x)=>sum+BigInt(x.volumeSol),0n),volume);
  await worker.stop();t.diagnostic(JSON.stringify({indexedFinalizedTrades:trades.trades.length,marketVolumeLamports:String(volume)}));
 }
 t.diagnostic(JSON.stringify({feeCollection:collected.result.signature,feeDistribution:distributed.result.signature,feeBurn:burned.result.signature,solCollected:String(finalFees.solCollected),treasuryPaid:String(finalFees.treasuryPaid),devPaid:String(finalFees.devPaid),childBurned:String(finalFees.coinBurned)}));
 // ---- evidence ----
 t.diagnostic(JSON.stringify({registryDriver:registry.driver,receiptBatchSize,programId:programId.toBase58(),campaignA:campaignA.toBase58(),pool:live.pool,feeNft:live.feeNft,launchSignature:launched.result.signature,settledAccepted:expectedAccepted.toString(),refundedA:afterRefund.refunded.toString(),lockedLp:locked.amount.toString(),participantClaimed:claimedSum.toString(),devClaimed:devPaid.toString(),campaignB:campaignB.toBase58(),refundedB:afterB.refunded.toString(),keeperSends:chain.calls,signerSigned:signerLog.filter(l=>l.event==='signer-signed').length,signerRefused:signerLog.filter(l=>l.event==='signer-refused').length}));
});
