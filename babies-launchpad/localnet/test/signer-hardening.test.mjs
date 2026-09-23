// Regressions for the security audit of 23 September 2026 (SEC-01, SEC-02, SEC-03).
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Keypair,PublicKey,TransactionInstruction,TransactionMessage,ComputeBudgetProgram,SystemProgram} from '@solana/web3.js';
import {NATIVE_MINT,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {evaluateOperatorMessage,launchAuthority,feeAuthority,DEFAULT_LIMITS,ATA_RENT_LAMPORTS,BASE_FEE_LAMPORTS} from '../signer-policy.mjs';
import {createSignerService} from '../signer-service.mjs';
import {reconcileSignedIntents} from '../chain-reconcile.mjs';
const operator=Keypair.generate(),program=Keypair.generate().publicKey,campaign=Keypair.generate().publicKey,stranger=Keypair.generate().publicKey,treasury=Keypair.generate().publicKey,blockhash='EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k',token='t'.repeat(32);
const kids=tag=>new TransactionInstruction({programId:program,keys:[{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:operator.publicKey,isSigner:true,isWritable:true}],data:Buffer.from([tag])});
const msg=(ixs,price=0)=>new TransactionMessage({payerKey:operator.publicKey,recentBlockhash:blockhash,instructions:[...(price?[ComputeBudgetProgram.setComputeUnitLimit({units:100_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:price})]:[]),...ixs]}).compileToV0Message();
const served=new Set([campaign.toBase58()]);
async function serve(opts={}){const logs=[];const s=createSignerService({keypair:operator,token,programId:program,campaigns:served,log:l=>logs.push(l),...opts});await new Promise(r=>s.server.listen(0,'127.0.0.1',r));return {url:'http://127.0.0.1:'+s.server.address().port,close:()=>new Promise(r=>s.server.close(r)),logs};}
const post=(url,message,operationId)=>fetch(url+'/sign',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({message:Buffer.from(message.serialize()).toString('base64'),operationId})});
test('SEC-01: a request refused by the spending limit does not turn its identical retry into a free signing',async()=>{
 const s=await serve({limits:{...DEFAULT_LIMITS,maxHourlyLamports:1}});
 try{
  const m=msg([kids(21)],120_000);
  const first=await post(s.url,m,'fee:1');assert.equal(first.status,403);assert.match((await first.json()).error,/spending limit/);
  const second=await post(s.url,m,'fee:1');assert.equal(second.status,403,'the retry of a refused request is refused again');
  const third=await post(s.url,m,'fee:1');assert.equal(third.status,403);
  assert.ok(!s.logs.some(l=>l.event==='signer-signed'));
 }finally{await s.close();}
});
test('SEC-01: an approved id retries free, a fresh id is charged, and the state survives a restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-signer-')),stateFile=join(dir,'signer-state.json');
 const m=msg([kids(21)],120_000);// 100k units * 120k micro = 12,000 lamports + 5,000 base fee
 let s=await serve({stateFile,limits:{...DEFAULT_LIMITS,maxHourlyLamports:20_000}});
 try{
  assert.equal((await post(s.url,m,'op:1')).status,200);assert.equal((await post(s.url,m,'op:1')).status,200,'retry of an approved signing');
  assert.equal((await post(s.url,m,'op:2')).status,403,'a second operation exceeds the hourly limit');
  assert.ok(existsSync(stateFile));const saved=JSON.parse(readFileSync(stateFile,'utf8'));assert.equal(saved.ledger.length,1);assert.equal(saved.registry.length,1);
 }finally{await s.close();}
 s=await serve({stateFile,limits:{...DEFAULT_LIMITS,maxHourlyLamports:20_000}});
 try{
  assert.equal((await post(s.url,m,'op:2')).status,403,'after a restart the hourly limit is still spent');
  assert.equal((await post(s.url,m,'op:1')).status,200,'after a restart the approved id still retries');
 }finally{await s.close();}
});
test('operation ids are required when the service says so; unlisted campaigns are refused without an unrestricted flag',async()=>{
 const s=await serve({requireOperationId:true});
 try{assert.equal((await post(s.url,msg([kids(21)]))).status,400);assert.equal((await post(s.url,msg([kids(21)]),'x')).status,200);}finally{await s.close();}
 assert.match(evaluateOperatorMessage(msg([kids(21)]),{operator:operator.publicKey,programId:program}).reason,/campaigns not configured/);
});
test('SEC-02: sponsored accounts are bound to served authorities or recorded recipients, and rent plus base fees count',()=>{
 const ata=owner=>createAssociatedTokenAccountIdempotentInstruction(operator.publicKey,getAssociatedTokenAddressSync(NATIVE_MINT,owner,true),owner,NATIVE_MINT);
 const ev=(ixs,opts={})=>evaluateOperatorMessage(msg(ixs),{operator:operator.publicKey,programId:program,campaigns:served,...opts});
 assert.match(ev([ata(stranger)]).reason,/owner is not served/);
 assert.match(ev([ata(treasury)]).reason,/owner is not served/);
 const ok=ev([ata(treasury)],{recipients:[treasury.toBase58()]});assert.equal(ok.ok,true);assert.equal(ok.spendLamports,ATA_RENT_LAMPORTS+BASE_FEE_LAMPORTS);
 for(const owner of [launchAuthority(program,campaign),feeAuthority(program,campaign),operator.publicKey.toBase58()])assert.equal(ev([ata(new PublicKey(owner))]).ok,true,owner);
 assert.match(ev([ata(new PublicKey(launchAuthority(program,stranger)))]).reason,/owner is not served/,'another campaign\'s authority');
 const keeper=ev([kids(21)]);assert.equal(keeper.spendLamports,BASE_FEE_LAMPORTS,'even a fee-free keeper message costs its signature');
});
test('SEC-03: missing history with an expired blockhash is closed but flagged, or held when the effect may be present',async()=>{
 const connection={getSignatureStatuses:async()=>({value:[null,null]}),getBlockHeight:async()=>1000};
 const rows=()=>({a:{signature:'sig-a',block:{lastValidBlockHeight:10}},b:{signature:'sig-b',block:{lastValidBlockHeight:10}}});
 const flagged=rows();const s1=await reconcileSignedIntents({service:'t',intents:flagged,connection});
 assert.equal(s1.expired,2);assert.equal(s1.expiredUnverified,2);assert.equal(s1.unresolvedSigned,0);assert.equal(flagged.a.closedReason,'expired');assert.equal(flagged.a.expiryUnverified,true);
 const verified=rows();const s2=await reconcileSignedIntents({service:'t',intents:verified,connection,verifyAbsent:async row=>row.signature==='sig-a'});
 assert.equal(s2.expired,1);assert.equal(s2.expiredUnverified,0);assert.equal(s2.effectPresent,1);assert.equal(s2.unresolvedSigned,1);assert.equal(verified.a.closedReason,'expired');assert.equal(verified.b.closedReason,undefined);assert.match(verified.b.chainNote,/effect is present/);
});

test('vault authorities of a served campaign may own sponsored accounts once a distribution program is configured',async()=>{
 const {vaultAuthority}=await import('../signer-policy.mjs');const dp=Keypair.generate().publicKey;
 const ata=owner=>createAssociatedTokenAccountIdempotentInstruction(operator.publicKey,getAssociatedTokenAddressSync(NATIVE_MINT,owner,true),owner,NATIVE_MINT);
 const ev=(ixs,opts={})=>evaluateOperatorMessage(msg(ixs),{operator:operator.publicKey,programId:program,campaigns:served,...opts});
 const vault=new PublicKey(vaultAuthority(dp,campaign,2));
 assert.match(ev([ata(vault)]).reason,/owner is not served/,'without a configured distribution program');
 assert.equal(ev([ata(vault)],{distributionProgram:dp.toBase58()}).ok,true);
 assert.match(ev([ata(new PublicKey(vaultAuthority(dp,stranger,2)))],{distributionProgram:dp.toBase58()}).reason,/owner is not served/,'another campaign');
});
