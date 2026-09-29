// Funding-first custody in the encrypted mint inventory: the reserved mint and a fee-NFT key generated beside it are durable
// before any signature, bound to one genesis/program/campaign/request, co-sign the creator's opening (tag 41) and the keeper's
// launch (tag 42, through the campaign's lookup table) exactly once per step and generation, survive a restart, are never
// exported, and refuse every other use (asset route, other campaign, other keys, unauthorized tables, launch before opening).
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes,createHash} from 'node:crypto';
import {Keypair,PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,AddressLookupTableAccount} from '@solana/web3.js';
import {SqliteVanityMintInventory} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/mint-inventory.js';
import {SqliteLaunchExecutionStore} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/sqlite-execution-store.js';
import {verifySignature} from '../../shared/solana.mjs';
const key=()=>Keypair.generate().publicKey.toBase58(),sha=b=>createHash('sha256').update(b).digest('hex');
function open(dir,encryptionKey){const records=new SqliteLaunchExecutionStore(join(dir,'executions.sqlite'));return new SqliteVanityMintInventory({databasePath:join(dir,'inventory.sqlite'),executionStore:records,keyId:'test-v1',encryptionKey,fallbackToOrdinaryMint:false});}
function addMint(inventory){const kp=Keypair.generate(),mint=kp.publicKey.toBase58(),sealed=inventory.encrypt(Buffer.from(kp.secretKey),mint);inventory.db.prepare("INSERT INTO kids_mints VALUES(?,?,?,?,'available',?,NULL)").run(mint,sealed.nonce,sealed.ciphertext,sealed.tag,new Date().toISOString());return mint;}
const opening=(creator,campaign,mint,nft,program,blockhash=key())=>{const ix=new TransactionInstruction({programId:new PublicKey(program),keys:[{pubkey:creator.publicKey,isSigner:true,isWritable:true},{pubkey:new PublicKey(campaign),isSigner:false,isWritable:true},{pubkey:new PublicKey(mint),isSigner:true,isWritable:true},{pubkey:new PublicKey(nft),isSigner:true,isWritable:true}],data:Buffer.from([41,1,2,3])});const tx=new VersionedTransaction(new TransactionMessage({payerKey:creator.publicKey,recentBlockhash:blockhash,instructions:[ix]}).compileToV0Message());tx.sign([creator]);return tx;};
function launchPacket(keeper,campaign,mint,nft,program,table,blockhash=key()){const extras=table.state.addresses.slice(0,20);const ix=new TransactionInstruction({programId:new PublicKey(program),keys:[{pubkey:new PublicKey(campaign),isSigner:false,isWritable:true},{pubkey:keeper.publicKey,isSigner:true,isWritable:true},{pubkey:new PublicKey(mint),isSigner:true,isWritable:true},{pubkey:new PublicKey(nft),isSigner:true,isWritable:true},...extras.map(k=>({pubkey:k,isSigner:false,isWritable:true}))],data:Buffer.from([42,9,9])});return new VersionedTransaction(new TransactionMessage({payerKey:keeper.publicKey,recentBlockhash:blockhash,instructions:[ix]}).compileToV0Message([table]));}
test('funding-first custody: reserve both keys durably, co-sign opening and launch once per step, survive restart, refuse every other use',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-ff-custody-'));chmodSync(dir,0o700);const encryptionKey=randomBytes(32);let inventory=open(dir,encryptionKey);
 try{
  const creator=Keypair.generate(),keeper=Keypair.generate(),program=key(),genesisHash=key(),campaign=key();
  const mint=addMint(inventory),binding={creator:creator.publicKey.toBase58(),draftId:'funding-first:req-1',idempotencyKey:'funding-first:req-1'};
  const scope={genesisHash,programId:program,campaign,requestId:'req-1'};
  assert.throws(()=>inventory.reserveFundingFirstKeys(binding,scope),/Unknown mint reservation/,'no reservation yet');
  const reservation=inventory.reserve(binding);assert.equal(reservation.mintAddress,mint);
  assert.throws(()=>inventory.reserveFundingFirstKeys({...binding,draftId:'asset:x',idempotencyKey:'asset:x'},scope),/Unknown mint reservation/,'another binding is another reservation');
  assert.throws(()=>inventory.reserveFundingFirstKeys(binding,{...scope,campaign:'nope'}),/canonical campaign/);
  const keys=inventory.reserveFundingFirstKeys(binding,scope);assert.equal(keys.mint,mint);assert.equal(keys.created,true);assert.ok(PublicKey.isOnCurve(new PublicKey(keys.feeNft).toBytes()));
  assert.deepEqual(inventory.reserveFundingFirstKeys(binding,scope),{...keys,created:false},'idempotent, the same fee NFT');
  assert.throws(()=>inventory.reserveFundingFirstKeys(binding,{...scope,campaign:key()}),/bound to another (campaign|intent)/,'the mint is bound to one campaign scope');
  const custody=inventory.fundingFirstCustody(mint);assert.deepEqual(custody,{mint,feeNft:keys.feeNft,...scope,signatures:[]});
  // The legacy unsigned release is refused as soon as custody exists, before any signature (the old guard only saw signatures).
  assert.deepEqual(inventory.releaseUnsignedReservation(binding),{released:false,reason:'funding-first'},'bound custody is never returned to the pool, even unsigned');
  assert.equal(inventory.db.prepare('SELECT status FROM kids_mints WHERE mint=?').get(mint).status,'reserved');assert.equal(inventory.db.prepare('SELECT COUNT(*) n FROM kids_mint_reservations WHERE mint=?').get(mint).n,1);
  assert.equal(inventory.db.prepare('SELECT COUNT(*) n FROM kids_fee_nft_keys').get().n,1,'the fee-NFT key is stored before it is shown');
  // The asset route is closed for this mint, and a mint bound to an asset intent is closed for funding first.
  const assetSigner=inventory.assetMintSigner(async()=>{throw Error('must not authorize');});
  await assert.rejects(assetSigner({...binding}),/namespace|another intent/,'the asset route never signs for this binding');
  // The reservation binding may live in the shared 'asset:<request>' namespace (the creation path's preparation binding):
  // custody reserves for it, and the asset route is then closed for that mint by its stored intent binding, not by the name.
  const shared=addMint(inventory),sharedBinding={creator:creator.publicKey.toBase58(),draftId:'asset:req-7',idempotencyKey:'asset:req-7'};const sharedReservation=inventory.reserve(sharedBinding);assert.equal(sharedReservation.mintAddress,shared);
  const sharedKeys=inventory.reserveFundingFirstKeys(sharedBinding,{...scope,campaign:key(),requestId:'req-7'});assert.equal(sharedKeys.mint,shared);assert.equal(sharedKeys.created,true);
  const assetTx=(()=>{const ix=new TransactionInstruction({programId:new PublicKey(program),keys:[{pubkey:creator.publicKey,isSigner:true,isWritable:true},{pubkey:new PublicKey(shared),isSigner:true,isWritable:true}],data:Buffer.from([1])});const tx=new VersionedTransaction(new TransactionMessage({payerKey:creator.publicKey,recentBlockhash:key(),instructions:[ix]}).compileToV0Message());tx.sign([creator]);return tx;})();
  let assetAuthorized=0;
  const sharedAssetSigner=inventory.assetMintSigner(async input=>{assetAuthorized++;return {mint:shared,creator:input.creator,intentHash:sha('asset-intent'),packet:Buffer.from(assetTx.serialize()).toString('base64'),message:assetTx.message.serialize(),lookupTables:[]};});
  await assert.rejects(sharedAssetSigner({...sharedBinding,reservationId:sharedReservation.reservationId}),/another intent or route/,'an otherwise valid asset authorization is refused on the stored intent binding');
  assert.equal(assetAuthorized,1,'the asset route reached its authorization and was refused at the binding, not at the namespace');
  assert.equal(inventory.db.prepare('SELECT COUNT(*) n FROM kids_mint_signatures WHERE mint=?').get(shared).n,0,'the asset route signed nothing');
  const other=addMint(inventory),otherBinding={creator:creator.publicKey.toBase58(),draftId:'funding-first:req-2',idempotencyKey:'funding-first:req-2'};inventory.reserve(otherBinding);
  inventory.db.prepare("UPDATE kids_mints SET intent_hash='deadbeef' WHERE mint=?").run(other);
  assert.throws(()=>inventory.reserveFundingFirstKeys(otherBinding,{...scope,campaign:key(),requestId:'req-2'}),/another intent/);
  // Launch before any opening is refused.
  const table=new AddressLookupTableAccount({key:new PublicKey(key()),state:{deactivationSlot:2n**64n-1n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,authority:undefined,addresses:Array.from({length:24},()=>new PublicKey(key()))}});
  const launchAuth=(tx,patch={})=>async()=>({mint,feeNft:keys.feeNft,keeper:keeper.publicKey.toBase58(),...scope,packet:Buffer.from(tx.serialize()).toString('base64'),message:tx.message.serialize(),lookupTables:[String(table.key)],attempt:1,...patch});
  const launch1=launchPacket(keeper,campaign,mint,keys.feeNft,program,table);
  await assert.rejects(inventory.fundingFirstLaunchSigner(launchAuth(launch1))({mint}),/before any signed opening|not bound/);
   // Opening: creator, mint, fee NFT.
   const open1=opening(creator,campaign,mint,keys.feeNft,program);
   const openAuth=(tx,patch={})=>async input=>({mint,feeNft:keys.feeNft,creator:input.creator,...scope,packet:Buffer.from(tx.serialize()).toString('base64'),message:tx.message.serialize(),...patch});
   const signOpening=inventory.fundingFirstOpeningSigner(openAuth(open1));
   const signed=await signOpening(binding);assert.equal(signed.step,'opening');assert.equal(signed.generation,0);
   const stx=VersionedTransaction.deserialize(Buffer.from(signed.transactionBase64,'base64')),msg=Buffer.from(stx.message.serialize());
   assert.ok(verifySignature(creator.publicKey.toBase58(),msg,stx.signatures[0])&&verifySignature(mint,msg,stx.signatures[1])&&verifySignature(keys.feeNft,msg,stx.signatures[2]),'creator, mint and fee NFT signatures verify');
   assert.deepEqual(await signOpening(binding),signed,'the same message signs identically');
   const open2=opening(creator,campaign,mint,keys.feeNft,program);
   await assert.rejects(inventory.fundingFirstOpeningSigner(openAuth(open2))(binding),/already signed another message/);
   await assert.rejects(inventory.fundingFirstOpeningSigner(openAuth(open2,{retry:{generation:1,previousMessageSha256:'0'.repeat(64)}}))(binding),/exact preceding/);
   const unsigned2=opening(creator,campaign,mint,keys.feeNft,program);unsigned2.signatures[0]=new Uint8Array(64);
   await assert.rejects(inventory.fundingFirstOpeningSigner(openAuth(unsigned2,{retry:{generation:1,previousMessageSha256:signed.messageSha256}}))(binding),/Fresh creator signature/);
   const retried=await inventory.fundingFirstOpeningSigner(openAuth(open2,{retry:{generation:1,previousMessageSha256:signed.messageSha256}}))(binding);assert.equal(retried.generation,1);
   await assert.rejects(inventory.fundingFirstOpeningSigner(openAuth(opening(creator,campaign,mint,key(),program)))(binding),/not creator, mint and fee NFT|another message/,'another fee NFT');
   await assert.rejects(inventory.fundingFirstOpeningSigner(openAuth(open1,{campaign:key()}))(binding),/not bound to this funding-first campaign|reserved key of this campaign/,'another campaign');
   await assert.rejects(inventory.fundingFirstOpeningSigner(openAuth(open1,{message:Buffer.alloc(10)}))(binding),/differs from independently rebuilt/);
   await assert.rejects(inventory.fundingFirstOpeningSigner(openAuth(open1))({...binding,creator:key()}),/not creator, mint and fee NFT|permanently bound|identity mismatch/,'a request by another wallet never matches the packet payer');
   assert.deepEqual(inventory.releaseUnsignedReservation(binding),{released:false,reason:'funding-first'},'a mint with bound custody is never returned to the pool');
   assert.equal(inventory.db.prepare('SELECT status FROM kids_mints WHERE mint=?').get(mint).status,'signed');
   // Launch: keeper, mint, fee NFT through the authorized table; custody slots must be empty; one message per attempt.
   const launched=await inventory.fundingFirstLaunchSigner(launchAuth(launch1))({mint});assert.equal(launched.step,'launch');assert.equal(launched.generation,0);
   const ltx=VersionedTransaction.deserialize(Buffer.from(launched.transactionBase64,'base64')),lmsg=Buffer.from(ltx.message.serialize());
   assert.ok(ltx.signatures[0].every(b=>b===0),'the keeper slot stays empty for the signer service');assert.ok(verifySignature(mint,lmsg,ltx.signatures[1])&&verifySignature(keys.feeNft,lmsg,ltx.signatures[2]));
   assert.deepEqual(await inventory.fundingFirstLaunchSigner(launchAuth(launch1))({mint}),launched,'idempotent');
   const launch2=launchPacket(keeper,campaign,mint,keys.feeNft,program,table);
   await assert.rejects(inventory.fundingFirstLaunchSigner(launchAuth(launch2))({mint}),/bounded|already signed another message/,'a second message in the same attempt: attempts never number fewer than signings');
   await assert.rejects(inventory.fundingFirstLaunchSigner(launchAuth(launch2,{attempt:2}))({mint}),/exact preceding/,'attempt 2 needs the preceding message hash');
   await assert.rejects(inventory.fundingFirstLaunchSigner(launchAuth(launch2,{attempt:1,previousMessageSha256:launched.messageSha256}))({mint}),/bounded/,'attempts never number fewer than signings');
   const second=await inventory.fundingFirstLaunchSigner(launchAuth(launch2,{attempt:5,previousMessageSha256:launched.messageSha256}))({mint});assert.equal(second.generation,1,'the generation is the custody\'s own count, whatever attempt the journal is at');
   await assert.rejects(inventory.fundingFirstLaunchSigner(launchAuth(launch1,{lookupTables:[]}))({mint}),/differs from independently rebuilt/,'unauthorized table');
   await assert.rejects(inventory.fundingFirstLaunchSigner(launchAuth(ltx))({mint}),/already carries custody signatures/);
   await assert.rejects(inventory.fundingFirstLaunchSigner(launchAuth(launch1,{campaign:key()}))({mint}),/not bound|reserved key/);
   await assert.rejects(inventory.fundingFirstLaunchSigner(launchAuth(launch1,{feeNft:key()}))({mint}),/not keeper, mint and fee NFT|reserved key/);
   await assert.rejects(inventory.fundingFirstLaunchSigner(launchAuth(launch1,{mint:other}))({mint}),/identity mismatch/);
   await assert.rejects(inventory.fundingFirstLaunchSigner(launchAuth(launchPacket(keeper,campaign,mint,keys.feeNft,program,table),{attempt:13}))({mint}),/bounded/);
   assert.deepEqual(inventory.fundingFirstCustody(mint).signatures.map(s=>s.step+':'+s.generation),['launch:0','launch:1','opening:0','opening:1']);
   // Restart: the keys and every signature are still there; the same launch message signs identically.
   inventory.close();inventory=open(dir,encryptionKey);
   assert.equal(inventory.fundingFirstCustody(mint).feeNft,keys.feeNft);
   assert.deepEqual(await inventory.fundingFirstLaunchSigner(launchAuth(launch1))({mint}),launched,'identical after restart');
   assert.throws(()=>open(dir,randomBytes(32)),/encryption key|failed authentication/,'another key cannot open the custody');
   // A corrupted fee-NFT record quarantines the mint instead of signing with the wrong key.
   inventory.db.prepare('UPDATE kids_fee_nft_keys SET ciphertext=? WHERE mint=?').run(randomBytes(64),mint);
   await assert.rejects(inventory.fundingFirstLaunchSigner(launchAuth(launchPacket(keeper,campaign,mint,keys.feeNft,program,table),{attempt:6,previousMessageSha256:second.messageSha256}))({mint}),/quarantined/);
   assert.equal(inventory.db.prepare('SELECT status FROM kids_mints WHERE mint=?').get(mint).status,'quarantined');
 }finally{try{inventory.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
