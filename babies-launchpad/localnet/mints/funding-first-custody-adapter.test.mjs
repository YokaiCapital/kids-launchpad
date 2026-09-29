// The trusted launch custody adapter (mints/funding-first-custody.mjs) over the real inventory and the PostgreSQL registry, on a
// mocked finalized ledger: the mint and fee-NFT keys co-sign only the exact launch template rebuilt from the sealed record, the
// extension, the campaign's table plan and the pinned resolution, under an active job lease, with a journal-proven retry.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';
import pg from 'pg';
import {Keypair,PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,AddressLookupTableAccount,AddressLookupTableProgram} from '@solana/web3.js';
import {SqliteVanityMintInventory} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/mint-inventory.js';
import {SqliteLaunchExecutionStore} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/sqlite-execution-store.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import * as c from '../protocol-v2/client.mjs';
import * as policy from '../protocol-v2/policy.mjs';
import {launchFundingFirstInstruction,launchTableAddresses,extAddress,displayHash,OFF_ACCOUNTING_VERSION,ACCOUNTING_VERSION_FUNDING_FIRST,EXT_LEN} from '../protocol-v3/client.mjs';
import {pinCompiledLookups} from '../signer/lookup-resolution.mjs';
import {encodeLookupTableAccount,U64_MAX} from '../test/helpers/lookup-table-account.mjs';
import {verifySignature} from '../../shared/solana.mjs';
import {createFundingFirstCustody,LAUNCH_V2_OPERATION} from './funding-first-custody.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=()=>Keypair.generate().publicKey;
const vector=JSON.parse(readFileSync(new URL('../protocol-v2/test-vectors.json',import.meta.url))).termsHash.find(v=>v.name==='standard');
test('launch custody adapter: exact template from the finalized record, planned table, active lease, journal-proven retry',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),dir=mkdtempSync(join(tmpdir(),'kids-ff-adapter-'));chmodSync(dir,0o700);let pool,inventory;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:6,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  inventory=new SqliteVanityMintInventory({databasePath:join(dir,'inventory.sqlite'),executionStore:new SqliteLaunchExecutionStore(join(dir,'executions.sqlite')),keyId:'test-v1',encryptionKey:randomBytes(32),fallbackToOrdinaryMint:false});
  const mintKp=Keypair.generate(),mint=mintKp.publicKey.toBase58(),sealed=inventory.encrypt(Buffer.from(mintKp.secretKey),mint);inventory.db.prepare("INSERT INTO kids_mints VALUES(?,?,?,?,'available',?,NULL)").run(mint,sealed.nonce,sealed.ciphertext,sealed.tag,new Date().toISOString());
  const creator=Keypair.generate(),keeper=Keypair.generate(),treasury=key(),program=key(),genesis=key();
  const t0={...vector.terms,genesis:c.keyHex(genesis),creator:c.keyHex(creator.publicKey),treasury:c.keyHex(treasury),childMint:c.keyHex(mintKp.publicKey)};
  const campaign=c.campaignAddress(program,creator.publicKey,t0.nonce),data=Buffer.alloc(policy.CAMPAIGN_LEN);
  c.CAMPAIGN_MAGIC.copy(data);policy.encodeTerms(t0).copy(data,8);policy.termsHash(data.subarray(8,808)).copy(data,808);data[OFF_ACCOUNTING_VERSION]=ACCOUNTING_VERSION_FUNDING_FIRST;
  const terms=c.decodeCampaign(data).terms,display={name:'Funding First',symbol:'FF',uri:terms.metadataUri};
  const binding={creator:creator.publicKey.toBase58(),draftId:'funding-first:req-9',idempotencyKey:'funding-first:req-9'};inventory.reserve(binding);
  const custodyKeys=inventory.reserveFundingFirstKeys(binding,{genesisHash:String(genesis),programId:String(program),campaign:String(campaign),requestId:'req-9'});
  const feeNft=new PublicKey(custodyKeys.feeNft);
  const ext=Buffer.alloc(EXT_LEN);Buffer.from('KIDSEXT2').copy(ext);campaign.toBuffer().copy(ext,8);mintKp.publicKey.toBuffer().copy(ext,72);feeNft.toBuffer().copy(ext,104);Buffer.from(displayHash(display),'hex').copy(ext,136);ext[168]=ACCOUNTING_VERSION_FUNDING_FIRST;
  // The opening must have been signed by the custody first (the creator's packet: creator, mint, fee NFT).
  const openIx=new TransactionInstruction({programId:program,keys:[{pubkey:creator.publicKey,isSigner:true,isWritable:true},{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:mintKp.publicKey,isSigner:true,isWritable:true},{pubkey:feeNft,isSigner:true,isWritable:true}],data:Buffer.from([41])});
  const openTx=new VersionedTransaction(new TransactionMessage({payerKey:creator.publicKey,recentBlockhash:String(key()),instructions:[openIx]}).compileToV0Message());openTx.sign([creator]);
  await inventory.fundingFirstOpeningSigner(async input=>({mint,feeNft:custodyKeys.feeNft,creator:input.creator,genesisHash:String(genesis),programId:String(program),campaign:String(campaign),requestId:'req-9',packet:Buffer.from(openTx.serialize()).toString('base64'),message:openTx.message.serialize()}))(binding);
  // The ledger: record, extension and the planned table (keeper-owned, complete).
  const {instruction}=launchFundingFirstInstruction(program,campaign,terms,keeper.publicKey,feeNft,display);
  const entries=launchTableAddresses(program,campaign,terms,feeNft),recentSlot=990,[,tableKey]=AddressLookupTableProgram.createLookupTable({authority:keeper.publicKey,payer:keeper.publicKey,recentSlot});
  const table=new AddressLookupTableAccount({key:tableKey,state:{deactivationSlot:U64_MAX,lastExtendedSlot:10,lastExtendedSlotStartIndex:0,authority:keeper.publicKey,addresses:entries}});
  const accounts=new Map([[String(campaign),{owner:program,executable:false,lamports:1,data}],[String(extAddress(program,campaign)),{owner:program,executable:false,lamports:1,data:ext}],[String(tableKey),{owner:AddressLookupTableProgram.programId,executable:false,lamports:1,data:encodeLookupTableAccount({authority:keeper.publicKey,addresses:entries,lastExtendedSlot:10})}]]);
  const connection={getAccountInfo:async k=>accounts.get(String(k))??null};
  const id={genesisHash:String(genesis),programId:String(program),campaign:String(campaign)};
  await registry.query('INSERT INTO lookup_table_plans(genesis_hash,program_id,campaign,payer,table_address,recent_slot,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',[id.genesisHash,id.programId,id.campaign,String(keeper.publicKey),String(tableKey),recentSlot,'complete',new Date().toISOString(),new Date().toISOString()]);
  const job=(await registry.jobs.enqueue({...id,jobClass:'launch',operationKey:'launch'})).job;await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'keeper-1',ttlMs:60000});
  // An unrelated leased job of the same campaign must never authorize a launch co-signature.
  const other=(await registry.jobs.enqueue({...id,jobClass:'refunds',operationKey:'refunds-review'})).job;await registry.jobs.leaseById({jobId:other.jobId,token:0,owner:'keeper-1',ttlMs:60000});
  let clock=0;const custody=createFundingFirstCustody({inventory,registry,connection,genesisHash:id.genesisHash,programId:id.programId,monotonicNow:()=>clock});
  const operation=canonicalHash({...id,operationId:LAUNCH_V2_OPERATION(id.campaign)});
  const build=(d=display,tables=[table],units=400000)=>{const ix=launchFundingFirstInstruction(program,campaign,terms,keeper.publicKey,feeNft,d).instruction;const message=new TransactionMessage({payerKey:keeper.publicKey,recentBlockhash:String(key()),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units}),ix]}).compileToV0Message(tables);const tx=new VersionedTransaction(message);return {tx,packet:Buffer.from(tx.serialize()).toString('base64'),lookups:pinCompiledLookups(message,{lookups:tables.map(t=>({table:String(t.key),addresses:t.state.addresses.map(String)}))})};};
  const request=(b,patch={})=>custody.signLaunch({mint,campaign:id.campaign,keeper:String(keeper.publicKey),packet:b.packet,lookups:b.lookups,packetRef:{operationId:operation,attempt:1},operationKey:'launch',fencingToken:1,...patch});
  const descriptor=canonicalJson({...id,operationId:LAUNCH_V2_OPERATION(id.campaign),operationKey:'launch',payer:String(keeper.publicKey)});
  const journal=async(b,attempt=1)=>registry.operatorPackets.prepare({operationId:operation,descriptor,prepared:{base64:b.packet,blockhash:String(key()),lastValidBlockHeight:10,lookups:b.lookups},previous:attempt>1?attempt-1:null});
  const first=build();
  await assert.rejects(request(first),/journaled prepared attempt/,'the attempt must be journaled before the custody signs');
  await journal(first);
  // The lease is read LAST, on the database clock, and its remaining validity guards the inventory's synchronous signing.
  // 1. The launch fence rotates after the journal read and before custody signing: refused, nothing signed.
  const originalGet=registry.operatorPackets.get.bind(registry.operatorPackets);let onGet=null;
  registry.operatorPackets.get=async(...args)=>{const row=await originalGet(...args);if(onGet){const hook=onGet;onGet=null;await hook();}return row;};
  onGet=()=>registry.query('UPDATE jobs SET fencing_token=fencing_token+1 WHERE job_id=?',[job.jobId]);
  await assert.rejects(request(first),/lease is not current/,'the launch fence changes after the journal read, before custody signing');
  await registry.query('UPDATE jobs SET fencing_token=fencing_token-1 WHERE job_id=?',[job.jobId]);
  // 2. The lease expires while the journal reads are in flight: refused.
  onGet=()=>registry.query("UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE job_id=?",[job.jobId]);
  await assert.rejects(request(first),/lease is not current/,'the lease expires during a delayed journal read');
  await registry.query('UPDATE jobs SET lease_expires_at=? WHERE job_id=?',[new Date(Date.now()+60000).toISOString(),job.jobId]);
  // 3. The remaining validity is measured once, from the moment the lease query was sent, and carried into the inventory's
  //    synchronous guard: a 30 s round trip and a 121 s pause before signing (a 120 s lease) are refused there, nothing signed;
  //    a 30 s round trip and a 60 s pause (90 s of the 120 s, the round trip counted once, not twice) still sign.
  await registry.query('UPDATE jobs SET lease_expires_at=? WHERE job_id=?',[new Date(Date.now()+120000).toISOString(),job.jobId]);
  const originalQuery=registry.query.bind(registry);let roundTrip=0;
  registry.query=async(...args)=>{const result=await originalQuery(...args);if(String(args[0]).includes('db_now_ms')){clock+=roundTrip;roundTrip=0;}return result;};
  const originalPacket=inventory.fundingFirstPacket.bind(inventory);let pause=0;
  inventory.fundingFirstPacket=(...args)=>{clock+=pause;pause=0;return originalPacket(...args);};
  roundTrip=30000;pause=121000;
  await assert.rejects(request(first),/expired before custody signing/,'a delayed return after the lease read cannot sign after expiry');
  assert.deepEqual(inventory.fundingFirstCustody(mint).signatures.map(s=>s.step),['opening'],'the refused requests signed nothing');
  await assert.rejects(request(first,{fencingToken:2}),/lease is not current/,'a stale fence, with the attempt journaled and every other check passing');
  roundTrip=30000;pause=60000;
  const signed=await request(first);
  assert.equal(signed.step,'launch');assert.equal(signed.generation,0);
  const stx=VersionedTransaction.deserialize(Buffer.from(signed.transactionBase64,'base64')),msg=Buffer.from(stx.message.serialize());
  assert.ok(stx.signatures[0].every(b=>b===0),'the keeper slot stays empty');assert.ok(verifySignature(mint,msg,stx.signatures[1])&&verifySignature(custodyKeys.feeNft,msg,stx.signatures[2]),'mint and fee NFT co-signed the exact template');
  assert.deepEqual(await request(first),signed,'idempotent for the same packet');
  await assert.rejects(request(build({...display,name:'Other'})),/opening commitment/,'a display other than the commitment');
  await assert.rejects(request(build({...display,uri:'ipfs://other'})),/opening commitment/,'a URI other than the sealed one');
  const otherTable=new AddressLookupTableAccount({key:key(),state:{...table.state}});accounts.set(String(otherTable.key),accounts.get(String(tableKey)));
  await assert.rejects(request(build(display,[otherTable])),/planned table/,'a table that is not the plan');
  await assert.rejects(request(first,{packetRef:{operationId:canonicalHash({...id,operationId:'launch:x'}),attempt:1}}),/launch operation/,'another operation id');
  await assert.rejects(request(first,{keeper:String(key())}),/keeper's v0 packet|Launch packet differs/,'another keeper named for the same packet');
  await assert.rejects(request(first,{packet:signed.transactionBase64}),/already carries custody signatures/,'a packet with custody slots filled');
  await assert.rejects(request(build(display,[table],400001)),/already signed another message|Launch packet differs|journaled prepared attempt/,'a second message for attempt 1');
  // A packet rebuilt by ANOTHER keeper over the same table and lease is refused: the keeper is pinned to the plan's payer.
  const otherKeeper=Keypair.generate(),rebuilt=(()=>{const ix=launchFundingFirstInstruction(program,campaign,terms,otherKeeper.publicKey,feeNft,display).instruction;const message=new TransactionMessage({payerKey:otherKeeper.publicKey,recentBlockhash:String(key()),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:400000}),ix]}).compileToV0Message([table]);const tx=new VersionedTransaction(message);return {packet:Buffer.from(tx.serialize()).toString('base64'),lookups:pinCompiledLookups(message,{lookups:[{table:String(table.key),addresses:table.state.addresses.map(String)}]})};})();
  const otherOp=canonicalHash({...id,operationId:LAUNCH_V2_OPERATION(id.campaign)});
  await registry.operatorPackets.progress({operationId:operation,attempt:1,from:'prepared',to:'expired'});
  await registry.operatorPackets.prepare({operationId:otherOp,descriptor,prepared:{base64:rebuilt.packet,blockhash:String(key()),lastValidBlockHeight:10,lookups:rebuilt.lookups},previous:1});
  await assert.rejects(request(rebuilt,{keeper:String(otherKeeper.publicKey),packetRef:{operationId:operation,attempt:2}}),/payer of the campaign's table plan/,'another keeper with the same table and lease');
  await registry.operatorPackets.progress({operationId:operation,attempt:2,from:'prepared',to:'expired'});
  await assert.rejects(request(first,{fencingToken:2}),/journaled prepared attempt/,'the lease is read last: a terminal attempt is refused by the journal before any fence is consulted');
  await assert.rejects(request(first,{operationKey:'settle'}),/launch job only/,'another operation key');
  await assert.rejects(request(first,{operationKey:'refunds-review',fencingToken:1}),/launch job only/,'an unrelated leased job of the campaign, with its own valid token, never authorizes');
  // Retry: attempt 3 (attempts 1 and 2 expired above) needs the journaled attempt 3 and a terminal attempt 2.
  const third=build();
  await assert.rejects(request(third,{packetRef:{operationId:operation,attempt:3}}),/journaled prepared attempt/,'attempt 3 before it is journaled');
  await journal(third,3);
  const retried=await request(third,{packetRef:{operationId:operation,attempt:3}});assert.equal(retried.generation,1,'the custody\'s second signed launch; attempt 2 was never co-signed and left no gap; attempts 1 and 2 are terminal in the journal');
  assert.deepEqual(await request(third,{packetRef:{operationId:operation,attempt:3}}),retried,'a lost answer: the same journaled message of the later generation is answered again from the custody journal');
  await assert.rejects(request(third,{packetRef:{operationId:operation,attempt:3},fencingToken:2}),/lease is not current/,'a replay under a stale fence is refused too');
  await assert.rejects(request(build(),{packetRef:{operationId:operation,attempt:3}}),/journaled prepared attempt|already signed another message/,'one message per attempt');
  const second={packet:signed.transactionBase64,lookups:first.lookups};
  // A mint the record does not seal, or a custody bound to another campaign, never signs.
  data.writeUInt8(data[OFF_ACCOUNTING_VERSION]^1,OFF_ACCOUNTING_VERSION);await assert.rejects(request(third,{packetRef:{operationId:operation,attempt:3}}),/not a funding-first record/);data.writeUInt8(data[OFF_ACCOUNTING_VERSION]^1,OFF_ACCOUNTING_VERSION);
  ext[104]^=1;await assert.rejects(request(third,{packetRef:{operationId:operation,attempt:3}}),/Extension differs/);ext[104]^=1;
  await assert.rejects(custody.signLaunch({mint,campaign:String(key()),keeper:String(keeper.publicKey),packet:first.packet,lookups:first.lookups,packetRef:{operationId:operation,attempt:1},operationKey:'launch',fencingToken:1}),/not bound to this campaign/);
  assert.deepEqual(inventory.fundingFirstCustody(mint).signatures.map(s=>s.step+':'+s.generation),['launch:0','launch:1','opening:0']);
 }finally{try{inventory?.close();}catch{}if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();rmSync(dir,{recursive:true,force:true});}
});
test('launch custody adapter: transport and database failures with codes are dependencies, its own lease refusal is not',{skip:!url},async()=>{
 const {createFundingFirstCustody:make}=await import('./funding-first-custody.mjs');
 const failing=code=>({getAccountInfo:async()=>{throw Object.assign(Error('boom'),code?{code}:{});}});
 const registry={driver:'postgres',operatorPackets:{get(){},latest(){}},query(){}};
 const inventory={fundingFirstLaunchSigner:authorize=>async input=>authorize(input),fundingFirstCustody:()=>({genesisHash:String(Keypair.generate().publicKey),programId:'x',campaign:'y',feeNft:'z',requestId:'r',signatures:[]})};
 for(const code of ['ECONNRESET','ETIMEDOUT','57P01',-32016,undefined]){
  const genesis=String(Keypair.generate().publicKey),program=String(Keypair.generate().publicKey),campaign=String(Keypair.generate().publicKey),keeper=Keypair.generate();
  const view={genesisHash:genesis,programId:program,campaign,feeNft:String(Keypair.generate().publicKey),requestId:'r',signatures:[]};
  const custody=make({inventory:{...inventory,fundingFirstCustody:()=>view},registry,connection:failing(code),genesisHash:genesis,programId:program});
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:keeper.publicKey,recentBlockhash:String(Keypair.generate().publicKey),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1})]}).compileToV0Message());
  const operation=canonicalHash({genesisHash:genesis,programId:program,campaign,operationId:LAUNCH_V2_OPERATION(campaign)});
  await assert.rejects(custody.signLaunch({mint:String(Keypair.generate().publicKey),campaign,keeper:String(keeper.publicKey),packet:Buffer.from(tx.serialize()).toString('base64'),lookups:null,packetRef:{operationId:operation,attempt:1},operationKey:'launch',fencingToken:1}),e=>e.dependency==='failure'&&(code===undefined||e.code===code),'code '+code+' is a dependency');
 }
});
