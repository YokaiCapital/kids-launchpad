// Isolated application-journal recovery drill. No RPC requests, hosted keys or ledgers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Keypair,Transaction,VersionedTransaction} from '@solana/web3.js';
import {createClaimIntentService} from '../postlaunch-claim-intents.mjs';
import {refundInstruction} from '../atomic-launch.mjs';
import {writeDurableJson} from '../../shared/durable-json.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'kids-restore-drill-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for(const name of ['source','backup','recovery'])mkdirSync(join(dir,name),{mode:0o700});
 const file=join(dir,'source','claims.json'),backup=join(dir,'backup','claims.json'),restored=join(dir,'recovery','claims.json');
 const owner=Keypair.generate(),campaign=Keypair.generate().publicKey,mint=Keypair.generate().publicKey,programId=Keypair.generate().publicKey;
 const block={blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:999};
 const ledger=new Map(),sent=[];let confirmBeforeError=false,fail=true,payouts=0,builds=0;
 const connection={getLatestBlockhash:async()=>block,getSignatureStatuses:async([signature])=>({value:[ledger.get(signature)||null]}),sendRawTransaction:async raw=>{
  const bytes=Buffer.from(raw),signature=encodeBase58(VersionedTransaction.deserialize(bytes).signatures[0]);sent.push(bytes);
  if((confirmBeforeError||!fail)&&!ledger.has(signature)){payouts++;ledger.set(signature,{err:null,confirmationStatus:'finalized'});}
  if(fail)throw Error('response lost after broadcast');return signature;
 },confirmTransaction:async()=>({value:{err:null}})};
 const context={ctx:{programId,manifest:{sha256:'test-program-hash',genesisHash:'test-ledger'},connection},campaign,state:{mint}};
 const deps={qualified:async()=>context,readClaims:async()=>({owner:owner.publicKey.toBase58(),payouts}),build:async()=>{builds++;return {...context,tx:new Transaction().add(refundInstruction({programId},campaign,owner.publicKey))};}};
 return {file,backup,restored,owner,campaign,context,sent,deps,service:createClaimIntentService({file,...deps}),setAccepted:()=>{confirmBeforeError=true;},allowSend:()=>{fail=false;},payouts:()=>payouts,builds:()=>builds,
  snapshot(){copyFileSync(file,backup);return hash(backup);},restore(){copyFileSync(backup,restored);return createClaimIntentService({file:restored,...deps});}};
}
async function prepareAndLoseResponse(f){
 const who=f.owner.publicKey.toBase58(),intent=await f.service.prepare(who,{campaign:f.campaign.toBase58(),action:'refund',requestId:'restore-drill-request-001'});
 const tx=VersionedTransaction.deserialize(Buffer.from(intent.unsignedTransactionBase64,'base64'));tx.sign([f.owner]);
 await assert.rejects(f.service.submit(who,{intentId:intent.intentId,signedTransactionBase64:Buffer.from(tx.serialize()).toString('base64')}),/response lost/);
 return {who,intent,bytes:Buffer.from(tx.serialize())};
}
test('restored signed journal reconciles finalized receipt without second broadcast or payout',async t=>{
 const f=fixture(t);f.setAccepted();const {who,intent}=await prepareAndLoseResponse(f),snapshotHash=f.snapshot();
 // Original application storage becomes unavailable. Restore into a separate directory.
 writeFileSync(f.file,'unavailable source');const recovered=f.restore();
 const receipt=await recovered.submit(who,{intentId:intent.intentId});
 assert.equal(receipt.signature,encodeBase58(VersionedTransaction.deserialize(f.sent[0]).signatures[0]));assert.equal(f.sent.length,1);assert.equal(f.payouts(),1);assert.equal(f.builds(),1);
 await recovered.submit(who,{intentId:intent.intentId});assert.equal(f.sent.length,1);assert.equal(f.payouts(),1);
 assert.equal(hash(f.backup),snapshotHash,'recovery must never modify backup');
 const record=JSON.parse(readFileSync(f.restored))[intent.intentId];assert.equal(record.confirmedSignature,receipt.signature);
});
test('restored ambiguous journal rebroadcasts identical bytes when no receipt exists',async t=>{
 const f=fixture(t),{who,intent,bytes}=await prepareAndLoseResponse(f),snapshotHash=f.snapshot();f.allowSend();
 const receipt=await f.restore().submit(who,{intentId:intent.intentId});assert.ok(receipt.signature);assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1],bytes);assert.deepEqual(f.sent[0],f.sent[1]);assert.equal(f.payouts(),1);assert.equal(f.builds(),1);assert.equal(hash(f.backup),snapshotHash);
});
test('restore rejects changed ledger, program or wallet before sending',async t=>{
 const f=fixture(t),{who,intent}=await prepareAndLoseResponse(f);f.snapshot();const recovered=f.restore();
 const other=Keypair.generate().publicKey.toBase58();await assert.rejects(recovered.submit(other,{intentId:intent.intentId}),/another wallet/);
 f.context.ctx.manifest.genesisHash='different-ledger';await assert.rejects(recovered.submit(who,{intentId:intent.intentId}),/identity changed/);
 f.context.ctx.manifest.genesisHash='test-ledger';f.context.ctx.manifest.sha256='different-program';await assert.rejects(recovered.submit(who,{intentId:intent.intentId}),/identity changed/);assert.equal(f.sent.length,1);
});
test('corrupt or older backup cannot silently reconstruct a missing signed intent',async t=>{
 const f=fixture(t),{who,intent}=await prepareAndLoseResponse(f);writeFileSync(f.backup,'{"truncated":');assert.throws(()=>f.restore(),SyntaxError);
 writeDurableJson(f.backup,{});const older=f.restore();await assert.rejects(older.submit(who,{intentId:intent.intentId}),/unavailable/);assert.equal(f.sent.length,1);assert.equal(f.builds(),1);
});
