import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair,TransactionInstruction,TransactionMessage,VersionedTransaction,AddressLookupTableProgram} from '@solana/web3.js';
import {openRegistry} from '../registry/registry.mjs';
import {createDurableSender} from './durable-send.mjs';
import {createLocalSigner} from '../operator-signer.mjs';
import {resolvePinnedLookups} from '../signer/lookup-resolution.mjs';
import {encodeLookupTableAccount} from '../test/helpers/lookup-table-account.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {verifySignature} from '../../shared/solana.mjs';
const key=()=>Keypair.generate().publicKey;
test('the durable sender pins the lookup tables it compiles through; unwarm, unknown and duplicate tables never reach a packet',async()=>{
 const registry=openRegistry();registry.migrate();
 try{
  const keeper=Keypair.generate(),program=key(),campaign=key(),tableKey=key(),accounts=[campaign,key(),key()];
  let lastExtendedSlot=10,slot=1000,sent=null;
  const connection={
   getLatestBlockhashAndContext:async()=>({context:{slot},value:{blockhash:key().toBase58(),lastValidBlockHeight:500}}),
   getAccountInfoAndContext:async k=>({context:{slot},value:String(k)===String(tableKey)?{owner:AddressLookupTableProgram.programId,executable:false,lamports:1,data:encodeLookupTableAccount({authority:keeper.publicKey,addresses:accounts,lastExtendedSlot})}:null}),
   getBlockHeight:async()=>100,
   sendRawTransaction:async wire=>{sent=Buffer.from(wire);return 'sig';},
   confirmTransaction:async()=>({context:{slot},value:{err:null}}),
  };
  const send=createDurableSender({connection,keeper:createLocalSigner(keeper),journal:registry.operatorPackets,genesisHash:String(key()),programId:String(program),confirmationWaitMs:1000,calls:{sent:0,unknown:0,confirmed:0}});
  const ix=new TransactionInstruction({programId:program,keys:[{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:accounts[2],isSigner:false,isWritable:false}],data:Buffer.from([5])});
  const result=await send([ix],{operationId:'launch:1',campaign:String(campaign),lookupTables:[String(tableKey)]});
  assert.equal(result.status,'confirmed');
  const row=await registry.operatorPackets.latest(result.packetRef.operationId);
  assert.deepEqual(row.prepared.lookups,[{table:String(tableKey),addresses:accounts.map(String),writableIndexes:[0],readonlyIndexes:[2]}]);
  assert.equal(row.prepared.lookupSlot,slot);
  assert.deepEqual(JSON.parse(row.descriptor).lookupTables,[String(tableKey)],'the table set is part of the semantic identity');
  const tx=VersionedTransaction.deserialize(Buffer.from(row.prepared.base64,'base64'));
  assert.equal(tx.message.addressTableLookups.length,1);assert.equal(tx.message.staticAccountKeys.length,3,'payer, compute budget and the program stay static');
  const {loadedAddresses}=resolvePinnedLookups(tx.message,row.prepared.lookups);
  assert.deepEqual(loadedAddresses.writable.map(String),[String(campaign)]);assert.deepEqual(loadedAddresses.readonly.map(String),[String(accounts[2])]);
  assert.ok(sent.equals(Buffer.from(row.signedBase64,'base64')),'the broadcast wire is the journaled signed packet');
  const again=await send([ix],{operationId:'launch:1',campaign:String(campaign),lookupTables:[String(tableKey)]});assert.equal(again.signature,result.signature,'same identity, same packet');
  await assert.rejects(send([ix],{operationId:'launch:1',campaign:String(campaign)}),{code:'IDEMPOTENCY_CONFLICT'},'a different table set is a different operation');
  lastExtendedSlot=slot;await assert.rejects(send([ix],{operationId:'launch:2',campaign:String(campaign),lookupTables:[String(tableKey)]}),/not warm/,'entries extended in the finalized slot');
  lastExtendedSlot=10;
  await assert.rejects(send([ix],{operationId:'launch:3',campaign:String(campaign),lookupTables:[String(key())]}),/not on the ledger/);
  await assert.rejects(send([ix],{operationId:'launch:4',campaign:String(campaign),lookupTables:[String(tableKey),String(tableKey)]}),/Duplicate lookup table/);
  await assert.rejects(send([ix],{operationId:'launch:5',campaign:String(campaign),lookupTables:[String(tableKey),String(key()),String(key())]}),/Invalid lookup tables/);
  assert.equal((await registry.operatorPackets.latest(result.packetRef.operationId)).attempt,1,'refused sends never journal a packet');
  const staticOnly=new TransactionInstruction({programId:program,keys:[{pubkey:key(),isSigner:false,isWritable:true}],data:Buffer.from([5])});
  const plain=await send([staticOnly],{operationId:'launch:6',campaign:String(campaign),lookupTables:[String(tableKey)]});
  const plainRow=await registry.operatorPackets.latest(plain.packetRef.operationId);assert.equal(plainRow.prepared.lookups,undefined,'a packet whose keys are all static pins nothing');
  assert.equal(VersionedTransaction.deserialize(Buffer.from(plainRow.prepared.base64,'base64')).message.addressTableLookups.length,0);
 }finally{registry.close();}
});
test('the preflight commitment is separate from the confirmation commitment: a finalized consumer still preflights at confirmed by default',async()=>{
 const registry=openRegistry();registry.migrate();
 try{
  const keeper=Keypair.generate(),program=key(),campaign=key();const preflights=[];
  const connection={getLatestBlockhashAndContext:async()=>({context:{slot:10},value:{blockhash:key().toBase58(),lastValidBlockHeight:500}}),getBlockHeight:async()=>100,sendRawTransaction:async(wire,o)=>{preflights.push(o.preflightCommitment);return 'sig';},confirmTransaction:async()=>({context:{slot:11},value:{err:null}})};
  const ix=new TransactionInstruction({programId:program,keys:[{pubkey:campaign,isSigner:false,isWritable:true}],data:Buffer.from([5])});
  const send=opts=>createDurableSender({connection,keeper:createLocalSigner(keeper),journal:registry.operatorPackets,genesisHash:String(key()),programId:String(program),confirmationWaitMs:1000,calls:{sent:0,unknown:0,confirmed:0},...opts});
  assert.equal((await send({commitment:'finalized'})([ix],{operationId:'a',campaign:String(campaign)})).status,'confirmed');
  assert.equal((await send({commitment:'finalized',preflightCommitment:'finalized'})([ix],{operationId:'b',campaign:String(campaign)})).status,'confirmed');
  assert.deepEqual(preflights,['confirmed','finalized']);
  assert.throws(()=>send({preflightCommitment:'processed'}),/preflight/);
 }finally{registry.close();}
});
test('custody co-signing: the attempt is journaled first, signatures are attached to it, a lost answer or a crash resumes without a rebuild, deviations attach nothing',async()=>{
 const registry=openRegistry();registry.migrate();
 try{
  const keeper=Keypair.generate(),aux=Keypair.generate(),program=key(),campaign=key(),genesisHash=String(key());
  const connection={getLatestBlockhashAndContext:async()=>({context:{slot:10},value:{blockhash:key().toBase58(),lastValidBlockHeight:500}}),getBlockHeight:async()=>100,sendRawTransaction:async()=>'sig',confirmTransaction:async()=>({context:{slot:11},value:{err:null}})};
  const send=createDurableSender({connection,keeper:createLocalSigner(keeper),journal:registry.operatorPackets,genesisHash,programId:String(program),confirmationWaitMs:1000,calls:{sent:0,unknown:0,confirmed:0}});
  const ix=new TransactionInstruction({programId:program,keys:[{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:aux.publicKey,isSigner:true,isWritable:false}],data:Buffer.from([42])});
  const op=id=>canonicalHash({genesisHash,programId:String(program),campaign:String(campaign),operationId:id});
  const asked=[];const custody=async(tx,ref)=>{asked.push({attempt:ref.attempt,message:Buffer.from(ref.message).toString('hex'),lookups:ref.lookups});tx.sign([aux]);return tx;};
  // 1. Custody unavailable: the attempt is journaled unsigned and nothing else happens; the next send resumes the same attempt.
  await assert.rejects(send([ix],{operationId:'co:1',campaign:String(campaign),coSign:async()=>{throw Error('custody unavailable');}}),/custody unavailable/);
  let row=await registry.operatorPackets.latest(op('co:1'));assert.equal(row.status,'prepared');assert.equal(row.attempt,1);
  const before=VersionedTransaction.deserialize(Buffer.from(row.prepared.base64,'base64'));assert.ok(before.signatures.every(s=>s.every(b=>b===0)),'journaled with empty custody slots');
  const first=await send([ix],{operationId:'co:1',campaign:String(campaign),coSign:custody});assert.equal(first.status,'confirmed');assert.equal(first.packetRef.attempt,1,'the journaled attempt, not a rebuild');
  row=await registry.operatorPackets.latest(op('co:1'));const msg=Buffer.from(before.message.serialize());
  assert.equal(asked[0].message,msg.toString('hex'),'the custody saw the journaled message');
  const prepared=VersionedTransaction.deserialize(Buffer.from(row.prepared.base64,'base64'));assert.ok(prepared.signatures[0].every(b=>b===0)&&verifySignature(String(aux.publicKey),msg,prepared.signatures[1]),'custody attached, keeper slot still empty in the prepared packet');
  const signed=VersionedTransaction.deserialize(Buffer.from(row.signedBase64,'base64'));assert.ok(verifySignature(String(keeper.publicKey),msg,signed.signatures[0])&&verifySignature(String(aux.publicKey),msg,signed.signatures[1]));
  // 2. The custody signed but the answer was lost: the next send asks for the same journaled message and attaches the same signatures.
  let lost=true;const flaky=async(tx,ref)=>{const signedTx=await custody(tx,ref);if(lost){lost=false;throw Error('answer lost');}return signedTx;};
  await assert.rejects(send([ix],{operationId:'co:2',campaign:String(campaign),coSign:flaky}),/answer lost/);
  const again=await send([ix],{operationId:'co:2',campaign:String(campaign),coSign:flaky});assert.equal(again.status,'confirmed');assert.equal(again.packetRef.attempt,1);
  const two=asked.filter(a=>a.attempt===1).slice(-2);assert.equal(two[0].message,two[1].message,'the same message both times');
  // 3. A custody that already attached is not asked again.
  const count=asked.length;assert.equal((await send([ix],{operationId:'co:2',campaign:String(campaign),coSign:custody})).signature,again.signature);assert.equal(asked.length,count,'no request for a complete packet');
  // 4. Deviations attach nothing: another message, an invalid signature, a signature for the keeper.
  for(const [id,bad,pattern] of [['co:3',async()=>{const other=new VersionedTransaction(new TransactionMessage({payerKey:keeper.publicKey,recentBlockhash:key().toBase58(),instructions:[ix]}).compileToV0Message());other.sign([aux]);return other;},/changed the operator message/],['co:4',async tx=>{tx.signatures[1]=new Uint8Array(64).fill(7);return tx;},/invalid auxiliary signature/],['co:5',async tx=>{tx.sign([aux,keeper]);return tx;},/must not sign for the keeper/]]){
   await assert.rejects(send([ix],{operationId:id,campaign:String(campaign),coSign:bad}),pattern);
   const r=await registry.operatorPackets.latest(op(id));assert.equal(r.status,'prepared');assert.ok(VersionedTransaction.deserialize(Buffer.from(r.prepared.base64,'base64')).signatures.every(s=>s.every(b=>b===0)),'nothing attached');
  }
  await assert.rejects(createDurableSender({connection,keeper:createLocalSigner(keeper),journal:registry.operatorPackets,genesisHash,programId:String(program),calls:{sent:0,unknown:0,confirmed:0}})([ix],{operationId:'x',campaign:String(campaign),coSign:'no'}),/must be a function/);
  // 5. Keeper signing fails AFTER the custody attached: the prepared row keeps the attached signatures; a NEW sender (fresh process)
  //    resumes from the durable bytes without asking the custody again, signs and confirms.
  const failingKeeper={kind:'local',publicKey:keeper.publicKey,async sign(){throw Error('signer service down');}};
  const senderA=createDurableSender({connection,keeper:failingKeeper,journal:registry.operatorPackets,genesisHash,programId:String(program),confirmationWaitMs:1000,calls:{sent:0,unknown:0,confirmed:0}});
  await assert.rejects(senderA([ix],{operationId:'co:6',campaign:String(campaign),coSign:custody}),/signer service down/);
  let r6=await registry.operatorPackets.latest(op('co:6'));assert.equal(r6.status,'prepared');
  const p6=VersionedTransaction.deserialize(Buffer.from(r6.prepared.base64,'base64'));assert.ok(verifySignature(String(aux.publicKey),Buffer.from(p6.message.serialize()),p6.signatures[1]),'custody signature attached and durable');
  const asks=asked.length;
  const senderB=createDurableSender({connection,keeper:createLocalSigner(keeper),journal:registry.operatorPackets,genesisHash,programId:String(program),confirmationWaitMs:1000,calls:{sent:0,unknown:0,confirmed:0}});
  const done6=await senderB([ix],{operationId:'co:6',campaign:String(campaign),coSign:async()=>{throw Error('must not be asked: the packet already carries custody signatures');}});
  assert.equal(done6.status,'confirmed');assert.equal(done6.packetRef.attempt,1);assert.equal(asked.length,asks,'no new custody request');
  r6=await registry.operatorPackets.latest(op('co:6'));assert.equal(r6.status,'confirmed');assert.ok(Buffer.from(r6.signedBase64,'base64').equals(Buffer.from(VersionedTransaction.deserialize(Buffer.from(r6.signedBase64,'base64')).serialize())));
  // 6. The attach itself fails to persist: the row stays prepared and unsigned; a new sender resumes, the custody is asked for the
  //    same journaled message once more, the same signatures are attached, and the send completes.
  const journal=registry.operatorPackets;let attachFailures=1;
  const flakyJournal={...journal,attachAuxiliary:async(...a)=>{if(attachFailures-- >0)throw Error('registry write lost');return journal.attachAuxiliary(...a);}};
  const senderC=createDurableSender({connection,keeper:createLocalSigner(keeper),journal:flakyJournal,genesisHash,programId:String(program),confirmationWaitMs:1000,calls:{sent:0,unknown:0,confirmed:0}});
  await assert.rejects(senderC([ix],{operationId:'co:7',campaign:String(campaign),coSign:custody}),/registry write lost/);
  let r7=await journal.latest(op('co:7'));assert.equal(r7.status,'prepared');assert.ok(VersionedTransaction.deserialize(Buffer.from(r7.prepared.base64,'base64')).signatures.every(s=>s.every(b=>b===0)),'nothing attached');
  const before7=asked.filter(a=>a.attempt===1).length;
  const senderD=createDurableSender({connection,keeper:createLocalSigner(keeper),journal,genesisHash,programId:String(program),confirmationWaitMs:1000,calls:{sent:0,unknown:0,confirmed:0}});
  const done7=await senderD([ix],{operationId:'co:7',campaign:String(campaign),coSign:custody});assert.equal(done7.status,'confirmed');assert.equal(done7.packetRef.attempt,1);
  const last7=asked.slice(-2);assert.equal(last7[0].message,last7[1].message,'the same journaled message was presented again');assert.equal(asked.filter(a=>a.attempt===1).length,before7+1);
 }finally{registry.close();}
});
