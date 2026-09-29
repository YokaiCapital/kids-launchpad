import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createMintLeases} from '../mints/leases.mjs';
import {fakeInventory} from '../test/helpers/mint-inventory-fixture.mjs';
import {campaignAddress,launchAuthority} from '../protocol-v2/client.mjs';
import {createMintIntent,buildMintPacket,verifyMintApproval} from './mint-packet.mjs';
import {createMintApprovalJournal} from './mint-approval.mjs';
import {createMintRecovery} from './mint-recovery.mjs';
import {createMintWalletService} from './mint-wallet.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,address=()=>Keypair.generate().publicKey.toBase58();
test('proof-bound mint retry generations preserve identity and refuse ambiguous chain outcomes',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:12,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const creator=Keypair.generate(),owner=creator.publicKey.toBase58(),config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:'http://127.0.0.1:19199',genesisHash:address(),programId:address(),pilotCreator:owner};
  let genesis=config.genesisHash,height=100,slot=120,history=null,historySlot=120,accounts=[null,null,null,null],accountSlot=120,block={blockhash:address(),lastValidBlockHeight:150,observedSlot:50};
  const connection={rpcEndpoint:config.rpcUrl,getGenesisHash:async()=>genesis,isBlockhashValid:async()=>({value:true}),getLatestBlockhash:async()=>block,getLatestBlockhashAndContext:async()=>({context:{slot:50},value:block}),getEpochInfo:async()=>({blockHeight:height,absoluteSlot:slot}),getFirstAvailableBlock:async()=>1,getSignatureStatuses:async()=>({context:{slot:historySlot},value:[history]}),getMultipleAccountsInfoAndContext:async(_keys,options)=>{assert.equal(options.commitment,'finalized');assert.equal(options.minContextSlot,slot);return {context:{slot:accountSlot},value:accounts};}};
  const inventory=fakeInventory({stock:['7e2g1HXJQPCMLED6PQZhHwzYw9iGemwPuUc5FAFMkids']}),leases=createMintLeases({registry,inventory});
  const id=randomUUID(),nonce='34',campaign=campaignAddress(config.programId,owner,nonce).toBase58(),binding={creator:owner,draftId:'asset:'+id,idempotencyKey:'asset:'+id};
  const {lease}=await leases.reserve({network:'localnet',genesisHash:config.genesisHash,programId:config.programId,campaign,...binding});
  const intent=createMintIntent({preparation:{...config,requestId:id,nonce,campaign,authority:launchAuthority(config.programId,campaign).toBase58(),state:'reserved',fundingEnabled:false,mint:lease.mint,leaseId:lease.leaseId},creator:owner,metadata:{name:'Coin',symbol:'Coin',uri:'https://kids.fun/rehearsal/coin.json',documentHash:'a'.repeat(64)},rentLamports:'1461600'});
  const plans={load:async()=>intent},open=()=>createMintApprovalJournal({registry,mintLeases:leases,connection,config,loadIntent:plans.load});
  const sign=b=>{const tx=buildMintPacket(intent,b);tx.sign([creator]);return Buffer.from(tx.serialize()).toString('base64');};
  const firstPacket=sign(block);await open().record(id,{block,creatorPacket:firstPacket});
  // This suite isolates chain evidence/DB concurrency with a synthetic signer
  // boundary. Real two-signature validation + the encrypted signer are tested by the opt-in
  // qualify-mint-retries.mjs on the isolated ledger, never by a fake private key.
  const synthetic=()=>({...open(),validateSigned:async(requestId,encoded)=>{
   const row=await open().read(requestId);assert.equal(encoded,row.signedBase64);
   const verified=verifyMintApproval(intent,row.prepared.block,row.prepared.creatorPacket);
   return {row,message:verified.message,signature:row.signature};
  }});
  const recovery=extra=>createMintRecovery({registry,connection,config,plans,approvals:synthetic(),...extra});
  const captureFixture=async()=>{
   const row=await open().read(id),tx=VersionedTransaction.deserialize(Buffer.from(row.prepared.creatorPacket,'base64')),signature=encodeBase58(tx.signatures[0]);
   await registry.operatorPackets.sign({operationId:row.operationId,attempt:row.attempt,signedBase64:row.prepared.creatorPacket,signature});
   await leases.recordSignature({leaseId:lease.leaseId,messageDigest:createHash('sha256').update(tx.message.serialize()).digest('hex'),signature});return signature;
  };
  let signature=await captureFixture();const input=()=>({requestId:id,expectedSignature:signature});
  await t.test('real boundary rejects a missing reserved-mint signature',async()=>{await assert.rejects(open().validateSigned(id,firstPacket),/invalid signed/);});
  await t.test('owner, ledger, unknown, lagging and merely confirmed failure never authorize retry',async()=>{
   await assert.rejects(recovery().recover(address(),input()));genesis=address();await assert.rejects(recovery().recover(owner,input()),/ledger/);genesis=config.genesisHash;
   assert.equal((await recovery().recover(owner,input())).action,'resume');height=160;slot=180;historySlot=170;
   assert.equal((await recovery().recover(owner,input())).action,'resume');historySlot=180;
   for(const h of [{slot:150,err:null,confirmationStatus:'processed'},{slot:150,err:{InstructionError:[0,'InvalidArgument']},confirmationStatus:'confirmed'},{slot:150,err:null,confirmationStatus:'confirmed'}]){history=h;assert.equal((await recovery().recover(owner,input())).action,'resume');}
   history=null;assert.equal(await open().pendingRetry(id),null);
  });
  await t.test('finalized expiry alone is insufficient if accounts exist or account data lags',async()=>{
   await assert.rejects(recovery().recover(owner,input()),/accounts unavailable/);accountSlot=180;accounts[0]={};assert.equal((await recovery().recover(owner,input())).reason,'mint-accounts-already-exist');accounts[0]=null;
   const original=connection.getSignatureStatuses;connection.getSignatureStatuses=()=>new Promise(()=>{});await assert.rejects(recovery({timeoutMs:10}).recover(owner,input()),/deadline/);connection.getSignatureStatuses=original;
   assert.equal((await open().read(id)).status,'signed');assert.equal(await open().pendingRetry(id),null);
  });
  await t.test('a competing recovery that closes the packet between the reads is the idempotent duplicate, not a conflict',async()=>{
   // The outer call has already read the signed row; a competitor finishes the whole recovery before the outer call
   // validates its packet, so the re-read row no longer matches. That must return the armed generation, not conflict.
   let competed=false;const racing={...synthetic(),validateSigned:async(requestId,encoded)=>{if(!competed){competed=true;const won=await recovery().recover(owner,input());assert.equal(won.generation,1);}return synthetic().validateSigned(requestId,encoded);}};
   const outer=await createMintRecovery({registry,connection,config,plans,approvals:racing}).recover(owner,input());
   assert.equal(competed,true);assert.equal(outer.generation,1);assert.equal(outer.action,'prepare-mint');
   assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM creation_mint_retries')).rows[0].n),1);
  });
  await t.test('concurrent recovery arms exactly one generation without mutating lease or signing',async()=>{
   const before=await registry.mintLeases.get(lease.leaseId),rows=await Promise.all(Array.from({length:10},()=>recovery().recover(owner,input())));
   assert.ok(rows.every(r=>r.generation===1&&r.action==='prepare-mint'));assert.deepEqual(await registry.mintLeases.get(lease.leaseId),before);
   assert.equal((await open().read(id)).status,'expired');assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM creation_mint_retries')).rows[0].n),1);
   assert.equal((await open().pendingRetry(id)).previousSignature,signature);
  });
  let secondPacket;
  await t.test('fresh creator signature advances one packet and CAS lease; old packet cannot replace it',async()=>{
   block={blockhash:address(),lastValidBlockHeight:250,observedSlot:50};secondPacket=sign(block);
   const rows=await Promise.all(Array.from({length:10},()=>open().record(id,{block,creatorPacket:secondPacket})));
   assert.ok(rows.every(r=>r.generation===1));assert.equal((await open().read(id)).attempt,2);assert.equal((await registry.mintLeases.get(lease.leaseId)).signature,null);assert.equal(await open().pendingRetry(id),null);
   const approval=await open().authorize({...binding,reservationId:inventory.findReservation(binding).reservationId});assert.equal(approval.retry.generation,1);assert.equal(approval.mint,intent.mint);
   await assert.rejects(open().record(id,{block:{blockhash:address(),lastValidBlockHeight:250,observedSlot:50},creatorPacket:firstPacket}));
   await assert.rejects(open().record(id,{block,creatorPacket:Buffer.from(buildMintPacket(intent,block).serialize()).toString('base64')}));
   assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM operator_packets')).rows[0].n),2);signature=await captureFixture();
  });
  await t.test('finalized failure still waits for expiry, then permits last bounded generation',async()=>{
   history={slot:190,err:{InstructionError:[0,'InvalidArgument']},confirmationStatus:'finalized'};
   assert.equal((await recovery().recover(owner,input())).reason,'waiting-for-finalized-expiry');
   height=260;slot=280;historySlot=280;accountSlot=280;
   assert.equal((await recovery().recover(owner,input())).generation,2);
   block={blockhash:address(),lastValidBlockHeight:350,observedSlot:50};await open().record(id,{block,creatorPacket:sign(block)});
   const authorization=await open().authorize({...binding,reservationId:inventory.findReservation(binding).reservationId});assert.equal(authorization.retry.generation,2);
   signature=await captureFixture();assert.equal((await recovery().recover(owner,input())).reason,'mint-retry-limit');
   assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM creation_mint_retries')).rows[0].n),2);
   assert.equal((await registry.mintLeases.get(lease.leaseId)).mint,intent.mint);
  });
  await t.test('tampered retry predecessor fails closed',async()=>{
   await registry.query('UPDATE creation_mint_retries SET previous_message_hash=? WHERE request_id=? AND generation=2',['f'.repeat(64),id]);
   await assert.rejects(open().authorize({...binding,reservationId:inventory.findReservation(binding).reservationId}));
  });
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
