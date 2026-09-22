import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {Keypair,Transaction,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {participantClaimInstruction,devClaimInstruction,parentClaimInstruction} from '../atomic-claims.mjs';
import {refundInstruction} from '../atomic-launch.mjs';
import {createClaimIntentService,validateSignedClaim} from '../postlaunch-claim-intents.mjs';
import {decodeApprovedClaim} from '../../interaction-review/src/claim-signing.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
const owner=Keypair.generate(),other=Keypair.generate(),campaign=Keypair.generate().publicKey,mint=Keypair.generate().publicKey,programId=Keypair.generate().publicKey;
const ctx={programId},block={blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100};
function transaction(action){const tx=new Transaction({feePayer:owner.publicKey,recentBlockhash:block.blockhash});if(action!=='refund')tx.add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey,getAssociatedTokenAddressSync(mint,owner.publicKey),owner.publicKey,mint));tx.add(action==='participant'?participantClaimInstruction(ctx,campaign,mint,owner.publicKey):action==='refund'?refundInstruction(ctx,campaign,owner.publicKey):action==='dev'?devClaimInstruction(ctx,campaign,mint,owner.publicKey):parentClaimInstruction(ctx,campaign,owner.publicKey,mint,action==='parentA'?0:1,owner.publicKey,500n,5000n,[]));return tx;}
const unsigned=tx=>tx.serialize({requireAllSignatures:false,verifySignatures:false});
const options=action=>({action,owner:owner.publicKey.toBase58(),campaign:campaign.toBase58(),mint:mint.toBase58(),programId:programId.toBase58()});
test('browser validates all five exact claim shapes and rejects recipient/program/extra changes',()=>{
 for(const action of ['participant','refund','dev','parentA','parentB'])assert.ok(decodeApprovedClaim(unsigned(transaction(action)),options(action)));
 const redirect=transaction('participant');redirect.instructions[1].keys[5].pubkey=other.publicKey;assert.throws(()=>decodeApprovedClaim(unsigned(redirect),options('participant')));
 const extra=transaction('dev').add(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:other.publicKey,lamports:1}));assert.throws(()=>decodeApprovedClaim(unsigned(extra),options('dev')));
 const forged=transaction('refund');forged.instructions[0].programId=other.publicKey;assert.throws(()=>decodeApprovedClaim(unsigned(forged),options('refund')));
 assert.throws(()=>decodeApprovedClaim(unsigned(transaction('parentA')),options('parentB')));
});
test('signature validator rejects altered transaction and wrong owner',()=>{
 const tx=transaction('dev'),approved=unsigned(tx).toString('base64');tx.sign(owner);const signed=tx.serialize().toString('base64');assert.ok(validateSignedClaim(signed,approved,owner.publicKey.toBase58()));assert.throws(()=>validateSignedClaim(signed,approved,other.publicKey.toBase58()));
 const changed=transaction('dev');changed.instructions[1].keys[4].pubkey=other.publicKey;changed.sign(owner);assert.throws(()=>validateSignedClaim(changed.serialize().toString('base64'),approved,owner.publicKey.toBase58()));
});
test('durable signed bytes survive ambiguous send and restart; identity and request terms stay bound',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-claim-'));try{
 const file=pathToFileURL(join(dir,'intents.json'));let fail=true,sent=[];
 const connection={getLatestBlockhash:async()=>block,getSignatureStatuses:async()=>({value:[null]}),sendRawTransaction:async raw=>{sent.push(Buffer.from(raw));assert.equal(Object.values(JSON.parse(readFileSync(file)))[0].signed,Buffer.from(raw).toString('base64'));if(fail){fail=false;throw Error('transport ambiguity');}return encodeBase58(VersionedTransaction.deserialize(raw).signatures[0]);},confirmTransaction:async()=>({value:{err:null}})};
 const context={ctx:{programId,manifest:{sha256:'binary',genesisHash:'localgenesis'},connection},campaign,state:{mint}};
 const deps={file,qualified:async()=>context,readClaims:async()=>({owner:owner.publicKey.toBase58()}),build:async()=>({...context,tx:transaction('dev')})};let service=createClaimIntentService(deps);
 const input={campaign:campaign.toBase58(),action:'dev',requestId:'unique-request-123456'},who=owner.publicKey.toBase58();const intent=await service.prepare(who,input);
 await assert.rejects(service.prepare(who,{...input,action:'refund'}),/different claim/);await assert.rejects(service.submit(other.publicKey.toBase58(),{intentId:intent.intentId}),/another wallet/);await assert.rejects(service.submit(who,{intentId:intent.intentId,local:true}),/wallet signature/);
 const tx=VersionedTransaction.deserialize(Buffer.from(intent.unsignedTransactionBase64,'base64'));tx.sign([owner]);await assert.rejects(service.submit(who,{intentId:intent.intentId,signedTransactionBase64:Buffer.from(tx.serialize()).toString('base64')}),/ambiguity/);
 service=createClaimIntentService(deps);const result=await service.submit(who,{intentId:intent.intentId});assert.ok(result.signature);assert.deepEqual(sent[0],sent[1]);await service.submit(who,{intentId:intent.intentId});assert.equal(sent.length,2);
 context.ctx.manifest.genesisHash='changed';await assert.rejects(service.submit(who,{intentId:intent.intentId}),/identity changed/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
