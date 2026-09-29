import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Keypair,PublicKey,VersionedTransaction,Transaction,ComputeBudgetProgram,SystemProgram} from '@solana/web3.js';
import {createPublicWalletService} from './public-wallet.mjs';import * as c from './client.mjs';import * as policy from './policy.mjs';import {openRegistry} from '../registry/registry.mjs';
import {decodePublicPacket,checkedSignedPacket} from '../../interaction-review/src/public/public-signing.mjs';
const vector=JSON.parse(readFileSync(new URL('./test-vectors.json',import.meta.url))).termsHash.find(v=>v.name==='standard');
function setup(programVersion=2){
 const wallet=Keypair.generate(),program=Keypair.generate().publicKey,genesis=Keypair.generate().publicKey,creatorWallet=Keypair.generate(),creator=creatorWallet.publicKey;
 const t={...vector.terms,genesis:c.keyHex(genesis),creator:c.keyHex(creator),dev:c.keyHex(wallet.publicKey),opensAt:'100',deadline:'200',launchDeadline:'300',soft:'1000000000',hard:'2000000000'};
 const campaign=c.campaignAddress(program,creator,t.nonce),data=Buffer.alloc(1024);c.CAMPAIGN_MAGIC.copy(data);policy.encodeTerms(t).copy(data,8);policy.termsHash(data.subarray(8,808)).copy(data,808);
 const clock=Buffer.alloc(40);clock.writeBigInt64LE(150n,32);let budget=null,receipt=null,status=null,height=10,sendError=false,sendCount=0;
 const path=join(mkdtempSync(join(tmpdir(),'kids-wallet-')),'registry.sqlite');let registry=openRegistry({path});registry.migrate();
 const row={genesisHash:genesis.toBase58(),programId:program.toBase58(),campaign:campaign.toBase58(),campaignVersion:programVersion,mode:'standard',registryStatus:'active'};registry.campaigns.upsert(row);const id=[row.genesisHash,row.programId,row.campaign].join(':');
 const rpc={getGenesisHash:async()=>row.genesisHash,getMultipleAccountsInfoAndContext:async()=>({context:{slot:7},value:[{owner:program,data},receipt,{data:clock},...(programVersion===3?[budget]:[])]}),getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}),getFeeForMessage:async()=>({value:5000}),getMinimumBalanceForRentExemption:async()=>1000000,getBalance:async()=>1e11,getBalanceAndContext:async()=>({context:{slot:8},value:1e11}),getAccountInfo:async()=>null,getSignatureStatuses:async()=>({value:[status]}),getBlockHeight:async()=>height,getFirstAvailableBlock:async()=>1,sendRawTransaction:async()=>{sendCount++;assert.equal(registry.walletPackets.list(wallet.publicKey.toBase58())[0].status,'signed');if(sendError)throw Error('network disconnected');return 'accepted';}};
 const service=()=>createPublicWalletService({registry:()=>registry,connection:rpc,genesisHash:row.genesisHash,programIds:[row.programId],programVersion,enabled:true});
 const vm={id,creator:creator.toBase58(),terms:{version:String(programVersion)},identity:{genesisHash:row.genesisHash,programId:row.programId,campaign:row.campaign},devBeneficiary:wallet.publicKey.toBase58(),chain:{mint:c.toKey(t.childMint).toBase58()}};
 return {wallet,creatorWallet,program,genesis,campaign,data,clock,t,row,id,vm,rpc,service,get registry(){return registry;},restart(){registry.close();registry=openRegistry({path});registry.migrate();},setBudget(v){budget=v;},setReceipt(v){receipt=v;},setStatus(v){status=v;},setHeight(v){height=v;},setSendError(v){sendError=v;},get sendCount(){return sendCount;}};
}
const request=w=>({campaignId:w.id,action:'commit',amountLamports:'1000000000',requestId:'stable-request-1'});
test('commit packet has exact program/amount/genesis/current sequence; replay uses same durable packet',async()=>{
 const w=setup(),owner=w.wallet.publicKey.toBase58(),s=w.service();
 const p=await s.prepare(owner,request(w)),again=await s.prepare(owner,request(w));assert.equal(p.intentId,again.intentId);assert.equal(p.unsignedTransactionBase64,again.unsignedTransactionBase64);
 const tx=decodePublicPacket(p.unsignedTransactionBase64,{vm:w.vm,owner,action:'commit',amountLamports:'1000000000'});const legacy=Transaction.from(Buffer.from(p.unsignedTransactionBase64,'base64'));assert.equal(legacy.instructions[0].data.readBigUInt64LE(41),0n);
 assert.throws(()=>decodePublicPacket(p.unsignedTransactionBase64,{vm:w.vm,owner,action:'commit',amountLamports:'2'}),/differs/);
 await assert.rejects(s.prepare(owner,{...request(w),amountLamports:'2'}),/different parameters/);
 tx.sign([w.wallet]);const signed=checkedSignedPacket(tx,VersionedTransaction.deserialize(Buffer.from(p.unsignedTransactionBase64,'base64')).serialize());
 w.setSendError(true);const unknown=await s.submit(owner,{intentId:p.intentId,signedTransactionBase64:signed});assert.equal(unknown.status,'unknown');assert.ok(unknown.signature);
 w.restart();w.setStatus({confirmationStatus:'confirmed',err:null});const result=await w.service().status(owner,{intentId:p.intentId});assert.equal(result.status,'confirmed');assert.equal(result.signature,unknown.signature);assert.equal(w.sendCount,1);
 await assert.rejects(w.service().status(Keypair.generate().publicKey.toBase58(),{intentId:p.intentId}),/not found/);w.registry.close();
});
test('reject altered recipient, amount, signature and excessive wallet fees before any broadcast',async()=>{
 const w=setup(),s=w.service(),owner=w.wallet.publicKey.toBase58(),p=await s.prepare(owner,request(w));
 for(const change of [tx=>{tx.instructions[0].data.writeBigUInt64LE(9n,33);},tx=>tx.add(SystemProgram.transfer({fromPubkey:w.wallet.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1})),tx=>tx.add(ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000000}))]){
  const tx=Transaction.from(Buffer.from(p.unsignedTransactionBase64,'base64'));change(tx);tx.sign(w.wallet);await assert.rejects(s.submit(owner,{intentId:p.intentId,signedTransactionBase64:tx.serialize().toString('base64')}));
 }
 assert.equal(w.sendCount,0);w.registry.close();
});
test('oversubscribed commits stay open until deadline; chain identity mismatch and unsupported programs refuse',async()=>{
 const w=setup(),owner=w.wallet.publicKey.toBase58();w.data.writeBigUInt64LE(3000000000n,848);await w.service().prepare(owner,request(w));
 w.clock.writeBigInt64LE(200n,32);await assert.rejects(w.service().prepare(owner,{...request(w),requestId:'later'}),/not open/);
 w.rpc.getGenesisHash=async()=>Keypair.generate().publicKey.toBase58();await assert.rejects(w.service().positions(owner,{campaignIds:[w.id]}),/Network identity/);w.registry.close();
});
test('live receipt position and dev vesting use integer chain entitlements; failure is unknown',async()=>{
 const w=setup(),owner=w.wallet.publicKey.toBase58();w.data[840]=3;w.data.writeBigInt64LE(120n,920);w.data.writeBigUInt64LE(3000000000n,848);w.data.writeBigUInt64LE(2000000000n,880);
 const r=Buffer.alloc(128);c.RECEIPT_MAGIC.copy(r);w.campaign.toBuffer().copy(r,8);w.wallet.publicKey.toBuffer().copy(r,40);r.writeBigUInt64LE(1500000000n,72);r.writeBigUInt64LE(1000000000n,96);r[113]=1;w.setReceipt({owner:w.program,data:r});
 const account=await w.service().positions(owner,{campaignIds:[w.id]});assert.equal(account.positions[w.id].acceptedLamports,'1000000000');assert.ok(BigInt(account.positions[w.id].tokensBaseUnits)>0n);assert.ok(BigInt(account.positions[w.id].dev.availableBaseUnits)>0n);
 const p=await w.service().prepare(owner,{campaignId:w.id,action:'allocation',requestId:'claim'});decodePublicPacket(p.unsignedTransactionBase64,{vm:w.vm,owner,action:'allocation'});
 w.rpc.getMultipleAccountsInfoAndContext=async()=>{throw Error('rpc fail');};assert.equal((await w.service().positions(owner,{campaignIds:[w.id]})).positions[w.id].eligibility,'unknown');w.registry.close();
});
test('unsigned cancellation is durable and prevents late submission; signed ambiguity cannot be cancelled',async()=>{
 const w=setup(),s=w.service(),owner=w.wallet.publicKey.toBase58(),p=await s.prepare(owner,request(w));
 const tx=VersionedTransaction.deserialize(Buffer.from(p.unsignedTransactionBase64,'base64'));tx.sign([w.wallet]);const wire=Buffer.from(tx.serialize()).toString('base64');
 assert.equal((await s.cancel(owner,{intentId:p.intentId})).status,'cancelled');assert.equal((await s.submit(owner,{intentId:p.intentId,signedTransactionBase64:wire})).status,'cancelled');assert.equal(w.sendCount,0);
 const q=await s.prepare(owner,{...request(w),requestId:'second'}),tx2=VersionedTransaction.deserialize(Buffer.from(q.unsignedTransactionBase64,'base64'));tx2.sign([w.wallet]);w.setSendError(true);await s.submit(owner,{intentId:q.intentId,signedTransactionBase64:Buffer.from(tx2.serialize()).toString('base64')});assert.equal((await s.cancel(owner,{intentId:q.intentId})).status,'unknown');w.registry.close();
});
test('uncertain signed packets stay pending until history-confirmed success or finalized blockheight expiry',async()=>{
 const w=setup(),s=w.service(),owner=w.wallet.publicKey.toBase58(),p=await s.prepare(owner,request(w)),tx=VersionedTransaction.deserialize(Buffer.from(p.unsignedTransactionBase64,'base64'));tx.sign([w.wallet]);w.setSendError(true);
 await s.submit(owner,{intentId:p.intentId,signedTransactionBase64:Buffer.from(tx.serialize()).toString('base64')});w.setHeight(100);assert.equal((await s.status(owner,{intentId:p.intentId})).status,'unknown');
 w.setHeight(101);assert.equal((await s.status(owner,{intentId:p.intentId})).status,'expired');assert.equal(w.registry.walletPackets.pending(owner).length,0);w.registry.close();
});

test('v3 wallet routing is explicit and does not reinterpret old program rows',async()=>{
 const w=setup(3),owner=w.wallet.publicKey.toBase58();
 const old=createPublicWalletService({registry:w.registry,connection:w.rpc,genesisHash:w.row.genesisHash,programIds:[w.row.programId],enabled:true});
 await assert.rejects(old.prepare(owner,request(w)),/not supported/);
 const packet=await w.service().prepare(owner,request(w));assert.ok(packet.unsignedTransactionBase64);
 assert.throws(()=>createPublicWalletService({registry:w.registry,programVersion:4}),/Unsupported/);
 w.registry.close();
});

test('unused setup return: owner/terminal checks, exact browser validation and durable signed bytes',async()=>{
 const w=setup(3),owner=w.creatorWallet.publicKey.toBase58(),s=w.service(),input={campaignId:w.id,action:'setup',requestId:'setup-return:1'};
 w.setBudget({owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports:107843280});
 await assert.rejects(s.prepare(owner,input),/only after launch/);
 w.data[840]=2;
 await assert.rejects(s.prepare(w.wallet.publicKey.toBase58(),input),/recorded creator/);
 const p=await s.prepare(owner,input);assert.equal(p.expectedReturnLamports,'107843280');assert.equal(p.amountLamports,'0');assert.equal(p.rentLamports,'0');
 const tx=decodePublicPacket(p.unsignedTransactionBase64,{vm:w.vm,owner,action:'setup'});
 const bad=Transaction.from(Buffer.from(p.unsignedTransactionBase64,'base64'));bad.instructions[0].keys[2].pubkey=w.wallet.publicKey;
 assert.throws(()=>decodePublicPacket(bad.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),{vm:w.vm,owner,action:'setup'}),/Unexpected|differs/);
 assert.throws(()=>decodePublicPacket(p.unsignedTransactionBase64,{vm:{...w.vm,terms:{version:'2'}},owner,action:'setup'}),/not available/);
 const writable=Transaction.from(Buffer.from(p.unsignedTransactionBase64,'base64'));writable.instructions[0].keys[0].isWritable=true;
 assert.throws(()=>decodePublicPacket(writable.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),{vm:w.vm,owner,action:'setup'}),/permissions/);
 tx.sign([w.creatorWallet]);const signed=checkedSignedPacket(tx,VersionedTransaction.deserialize(Buffer.from(p.unsignedTransactionBase64,'base64')).serialize());
 w.rpc.sendRawTransaction=async()=>{assert.equal(w.registry.walletPackets.get(p.intentId).status,'signed');throw Error('lost response');};
 const outcome=await s.submit(owner,{intentId:p.intentId,signedTransactionBase64:signed});assert.equal(outcome.status,'unknown');assert.ok(outcome.signature);
 w.restart();assert.equal((await w.service().prepare(owner,input)).signature,outcome.signature,'restart retains the same signed intent');
 w.registry.close();
});
test('unread setup custody is unknown, and zero remaining setup is not claimable',async()=>{
 const w=setup(3),owner=w.creatorWallet.publicKey.toBase58(),s=w.service(),input={campaignId:w.id,action:'setup',requestId:'return'};w.data[840]=2;
 w.setBudget({owner:w.program,executable:false,data:Buffer.alloc(0),lamports:123});
 assert.equal((await s.positions(owner,{campaignIds:[w.id]})).positions[w.id].setup.eligibility,'unknown');
 await assert.rejects(s.prepare(owner,input),/Could not verify/);
 w.setBudget(null);await assert.rejects(s.prepare(owner,input),/No unused setup/);w.registry.close();
});
test('v3 fee payout restoration is owner-funded, exact, durable and restricted to sealed recipients',async()=>{
 const w=setup(3),owner=String(w.wallet.publicKey),input={campaignId:w.id,action:'fee-account',requestId:'restore-payout:1'};w.data[840]=3;w.data.writeBigInt64LE(120n,920);
 const state=Buffer.alloc(160);c.FEE_STATE_MAGIC.copy(state);w.campaign.toBuffer().copy(state,8);
 const original=w.rpc.getMultipleAccountsInfoAndContext;let payout=null,stateAccount={owner:w.program,data:state,executable:false};
 w.rpc.getMultipleAccountsInfoAndContext=async(addresses,options)=>addresses.length===2?{context:{slot:8},value:[stateAccount,payout]}:original(addresses,options);
 const s=w.service(),position=(await s.positions(owner,{campaignIds:[w.id]})).positions[w.id];assert.equal(position.feePayout.status,'repair-required');assert.equal(position.feePayout.address,String(c.associatedTokenAddress(w.wallet.publicKey,c.WSOL)));
 await assert.rejects(s.prepare(String(w.creatorWallet.publicKey),input),/live launch recipient/);
 const offer=await s.prepare(owner,input);assert.equal(offer.amountLamports,'0');assert.equal(offer.rentLamports,'1000000');
 const tx=decodePublicPacket(offer.unsignedTransactionBase64,{vm:w.vm,owner,action:'fee-account'});
 for(const mutate of [
  t=>{t.instructions[0].keys[1].pubkey=Keypair.generate().publicKey;},
  t=>{t.instructions[0].keys[3].pubkey=w.program;},
  t=>{t.instructions[0].data=Buffer.from([0]);},
  t=>t.add(SystemProgram.transfer({fromPubkey:w.wallet.publicKey,toPubkey:w.creatorWallet.publicKey,lamports:1}))
 ]){const bad=Transaction.from(Buffer.from(offer.unsignedTransactionBase64,'base64'));mutate(bad);assert.throws(()=>decodePublicPacket(bad.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),{vm:w.vm,owner,action:'fee-account'}),/restoration/);}
 assert.throws(()=>decodePublicPacket(offer.unsignedTransactionBase64,{vm:{...w.vm,terms:{version:'2'}},owner,action:'fee-account'}),/not available/);
 tx.sign([w.wallet]);w.setSendError(true);const signed=checkedSignedPacket(tx,VersionedTransaction.deserialize(Buffer.from(offer.unsignedTransactionBase64,'base64')).serialize()),result=await s.submit(owner,{intentId:offer.intentId,signedTransactionBase64:signed});assert.equal(result.status,'unknown');
 w.restart();assert.equal((await w.service().prepare(owner,input)).signature,result.signature);assert.equal(w.sendCount,1);
 stateAccount=null;await assert.rejects(w.service().prepare(owner,{...input,requestId:'new-restore'}),/No verified/);
 w.registry.close();
 const old=setup(2);old.data[840]=3;old.data.writeBigInt64LE(120n,920);await assert.rejects(old.service().prepare(String(old.wallet.publicKey),{campaignId:old.id,action:'fee-account',requestId:'old-version'}),/live launch recipient/);old.registry.close();
});
test('an unread, existing or unsafe fee account is not presented as missing',async()=>{
 const w=setup(3),owner=String(w.wallet.publicKey);w.data[840]=3;w.data.writeBigInt64LE(120n,920);
 const state=Buffer.alloc(160);c.FEE_STATE_MAGIC.copy(state);w.campaign.toBuffer().copy(state,8);
 const token=Buffer.alloc(165);c.WSOL.toBuffer().copy(token);w.wallet.publicKey.toBuffer().copy(token,32);token[108]=1;token.writeUInt32LE(1,109);token.writeBigUInt64LE(2039280n,113);
 const original=w.rpc.getMultipleAccountsInfoAndContext;let slot=8,payout={owner:c.TOKEN_PROGRAM,data:token,executable:false};
 w.rpc.getMultipleAccountsInfoAndContext=async(addresses,options)=>addresses.length===2?{context:{slot},value:[{owner:w.program,data:state},payout]}:original(addresses,options);
 const status=async()=>(await w.service().positions(owner,{campaignIds:[w.id]})).positions[w.id].feePayout.status;
 assert.equal(await status(),'ready');await assert.rejects(w.service().prepare(owner,{campaignId:w.id,action:'fee-account',requestId:'exists'}),/No verified/);
 token[108]=2;assert.equal(await status(),'unavailable');token[108]=1;slot=6;payout=null;assert.equal(await status(),'unavailable');w.registry.close();
});

test('confirmed packets can advance to finalized without another submission',async()=>{
 const w=setup(3),s=w.service(),owner=String(w.wallet.publicKey),p=await s.prepare(owner,request(w)),tx=VersionedTransaction.deserialize(Buffer.from(p.unsignedTransactionBase64,'base64'));tx.sign([w.wallet]);w.setStatus({confirmationStatus:'confirmed',err:null});
 assert.equal((await s.submit(owner,{intentId:p.intentId,signedTransactionBase64:Buffer.from(tx.serialize()).toString('base64')})).status,'confirmed');
 w.setStatus({confirmationStatus:'finalized',err:null});assert.equal((await s.status(owner,{intentId:p.intentId})).status,'finalized');assert.equal(w.sendCount,1);w.registry.close();
});
test('version 3: the first commitment must reach the manifest minimum (0.05 SOL); a top-up on an existing receipt may be smaller; version 2 has no minimum',async()=>{
 const w=setup(3),owner=w.wallet.publicKey.toBase58(),s=w.service();
 await assert.rejects(s.prepare(owner,{...request(w),amountLamports:'49999999',requestId:'minimum-1'}),/first commitment is at least 0\.05 SOL/);
 const exact=await s.prepare(owner,{...request(w),amountLamports:'50000000',requestId:'minimum-2'});assert.equal(exact.amountLamports,'50000000');
 const r=Buffer.alloc(128);c.RECEIPT_MAGIC.copy(r);w.campaign.toBuffer().copy(r,8);w.wallet.publicKey.toBuffer().copy(r,40);r.writeBigUInt64LE(50000000n,72);w.setReceipt({owner:w.program,data:r});
 const topUp=await s.prepare(owner,{...request(w),amountLamports:'1000',requestId:'minimum-3'});assert.equal(topUp.amountLamports,'1000');
 w.setReceipt(null);
 const custom=createPublicWalletService({registry:()=>w.registry,connection:w.rpc,genesisHash:w.row.genesisHash,programIds:[w.row.programId],programVersion:3,enabled:true,minimumCommitmentLamports:'2000'});
 await assert.rejects(custom.prepare(owner,{...request(w),amountLamports:'1999',requestId:'minimum-4'}),/at least 0\.000002 SOL/);
 w.registry.close();
 const w2=setup(2),owner2=w2.wallet.publicKey.toBase58(),small=await w2.service().prepare(owner2,{...request(w2),amountLamports:'1',requestId:'minimum-5'});assert.equal(small.amountLamports,'1');w2.registry.close();
});
