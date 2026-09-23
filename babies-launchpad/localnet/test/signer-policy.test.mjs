// Adversarial regression tests for the signer (architecture audit, 23 Sep 2026): the reproduction that passed before
// the fix was a compute-only message requesting a 1.4 SOL priority fee. Permitted-program abuse is tested, not only
// foreign-program rejection.
import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair,PublicKey,TransactionInstruction,TransactionMessage,SystemProgram,ComputeBudgetProgram,AddressLookupTableProgram} from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction,createTransferInstruction,createInitializeMint2Instruction,TOKEN_PROGRAM_ID,MINT_SIZE} from '@solana/spl-token';
import {evaluateOperatorMessage,createSpendLedger,createOperationRegistry,launchAuthority,DEFAULT_LIMITS} from '../signer-policy.mjs';
import {createSignerService} from '../signer-service.mjs';
const operator=Keypair.generate(),program=Keypair.generate().publicKey,campaign=Keypair.generate().publicKey,other=Keypair.generate(),blockhash='EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k',token='t'.repeat(40);
const kids=(tag,accounts=[{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:operator.publicKey,isSigner:true,isWritable:true}])=>new TransactionInstruction({programId:program,keys:accounts,data:Buffer.from([tag])});
const msg=(instructions,payer=operator.publicKey,tables=[])=>new TransactionMessage({payerKey:payer,recentBlockhash:blockhash,instructions}).compileToV0Message(tables);
const ev=(instructions,opts={})=>evaluateOperatorMessage(msg(instructions),{operator:operator.publicKey,programId:program,unrestricted:true,...opts});
test('REPRODUCTION: a compute-only message with a 1.4 SOL priority fee is refused, with or without a launch instruction',()=>{
 const fee=[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1_000_000_000n})];
 assert.equal(ev(fee).ok,false);assert.match(ev(fee).reason,/priority fee|does nothing|invoke/);
 const withKids=ev([...fee,kids(21)]);assert.equal(withKids.ok,false);assert.match(withKids.reason,/priority fee/);
 const sane=ev([ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10_000n}),kids(21)]);assert.equal(sane.ok,true);assert.equal(sane.priorityFeeLamports,12_000n);
});
test('user-signed tags, unknown tags and unserved campaigns are refused; keeper tags on a served campaign pass',()=>{
 for(const tag of [1,3,7,8,10,11,99])assert.equal(ev([kids(tag)]).ok,false,'tag '+tag);
 for(const tag of [2,4,5,6,20,21,22,23,24,25,26])assert.equal(ev([kids(tag)]).ok,true,'tag '+tag);
 const served=new Set([campaign.toBase58()]);assert.equal(ev([kids(21)],{campaigns:served}).ok,true);
 assert.match(ev([kids(21,[{pubkey:other.publicKey,isSigner:false,isWritable:true}])],{campaigns:served}).reason,/not served/);
 assert.match(ev([kids(0)]).reason,/not allowed/);assert.equal(ev([kids(0,[{pubkey:operator.publicKey,isSigner:true,isWritable:true},{pubkey:campaign,isSigner:false,isWritable:true}])],{provisioning:true,campaigns:served}).ok,true);
});
test('permitted programs cannot be abused: token transfers, system transfers to strangers, foreign lookup-table authority',()=>{
 const ata=Keypair.generate().publicKey;
 assert.match(ev([kids(21),createTransferInstruction(ata,other.publicKey,operator.publicKey,5n)]).reason,/token instruction not allowed/);
 assert.match(ev([kids(21),SystemProgram.transfer({fromPubkey:operator.publicKey,toPubkey:other.publicKey,lamports:1})]).reason,/system transfer not allowed/);
 const auth=launchAuthority(program,campaign.toBase58());
 assert.match(ev([kids(21),SystemProgram.transfer({fromPubkey:operator.publicKey,toPubkey:other.publicKey,lamports:1})],{provisioning:true,campaigns:new Set([campaign.toBase58()])}).reason,/destination/);
 const okTransfer=ev([kids(21),SystemProgram.transfer({fromPubkey:operator.publicKey,toPubkey:new PublicKey(auth),lamports:300_000_000})],{provisioning:true,campaigns:new Set([campaign.toBase58()])});assert.equal(okTransfer.ok,true);assert.equal(okTransfer.spendLamports,300_005_000n,'transfer plus the base fee for one signature');
 assert.match(ev([kids(21),SystemProgram.transfer({fromPubkey:operator.publicKey,toPubkey:new PublicKey(auth),lamports:600_000_000})],{provisioning:true,campaigns:new Set([campaign.toBase58()])}).reason,/amount out of bounds/);
 const [createIx]=AddressLookupTableProgram.createLookupTable({authority:other.publicKey,payer:operator.publicKey,recentSlot:1});assert.match(ev([createIx]).reason,/authority or payer/);
 const [okCreate]=AddressLookupTableProgram.createLookupTable({authority:operator.publicKey,payer:operator.publicKey,recentSlot:1});assert.equal(ev([okCreate]).ok,true);
 assert.equal(ev([createAssociatedTokenAccountIdempotentInstruction(operator.publicKey,ata,other.publicKey,campaign)]).ok,true);
 assert.match(ev([createAssociatedTokenAccountIdempotentInstruction(other.publicKey,ata,other.publicKey,campaign)],{}).reason,/fee payer|payer/);
 assert.match(ev([kids(21),SystemProgram.transfer({fromPubkey:other.publicKey,toPubkey:operator.publicKey,lamports:1})],{provisioning:true}).reason,/source|transfer/);
});
test('provisioning template: mint creation by a separate signer with bounded rent; other token instructions stay refused',()=>{
 const mint=Keypair.generate();
 const create=SystemProgram.createAccount({fromPubkey:operator.publicKey,newAccountPubkey:mint.publicKey,lamports:1_461_600,space:MINT_SIZE,programId:TOKEN_PROGRAM_ID});
 const init=createInitializeMint2Instruction(mint.publicKey,6,operator.publicKey,operator.publicKey);
 const r=ev([create,init],{provisioning:true});assert.equal(r.ok,true);assert.equal(r.spendLamports,1_471_600n,'rent plus the base fee for two signatures');
 assert.match(ev([create,init]).reason,/account creation not allowed/);
 const big=SystemProgram.createAccount({fromPubkey:operator.publicKey,newAccountPubkey:mint.publicKey,lamports:25_000_000,space:MINT_SIZE,programId:TOKEN_PROGRAM_ID});assert.match(ev([big],{provisioning:true}).reason,/rent out of bounds/);
 const foreignOwner=SystemProgram.createAccount({fromPubkey:operator.publicKey,newAccountPubkey:mint.publicKey,lamports:1,space:10,programId:other.publicKey});assert.match(ev([foreignOwner],{provisioning:true}).reason,/owner not allowed/);
});
test('v0 messages with lookup tables are refused unless resolved; resolved keys are policy-checked',()=>{
 const table={key:Keypair.generate().publicKey,state:{addresses:[campaign,other.publicKey]}};
 const m=new TransactionMessage({payerKey:operator.publicKey,recentBlockhash:blockhash,instructions:[kids(21)]}).compileToV0Message([table]);
 assert.equal(m.addressTableLookups.length,1);
 assert.match(evaluateOperatorMessage(m,{operator:operator.publicKey,programId:program,unrestricted:true}).reason,/lookup tables not resolved/);
 const loaded={writable:[campaign.toBase58()],readonly:[]};
 assert.equal(evaluateOperatorMessage(m,{operator:operator.publicKey,programId:program,loadedAddresses:loaded,campaigns:new Set([campaign.toBase58()])}).ok,true);
});
test('spending ledger and operation registry bound what a stolen token can do',()=>{
 let t=0;const ledger=createSpendLedger({maxHourlyLamports:100,now:()=>t});assert.equal(ledger.charge(60),true);assert.equal(ledger.charge(50),false);t=3_600_001;assert.equal(ledger.charge(50),true);
 const ops=createOperationRegistry({now:()=>t});assert.equal(ops.check('fee:1','h1'),'new');assert.equal(ops.check('fee:1','h1'),'new','a check records nothing');ops.approve('fee:1','h1');assert.equal(ops.check('fee:1','h1'),'retry');assert.equal(ops.check('fee:1','h2'),false);
});
test('the service refuses the 1.4 SOL compute-only message, enforces the hourly limit and operation ids',async()=>{
 const logs=[];const s=createSignerService({keypair:operator,token,programId:program,unrestricted:true,limits:{...DEFAULT_LIMITS,maxHourlyLamports:20_000},log:l=>logs.push(l)});await new Promise(r=>s.server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+s.server.address().port+'/sign';const post=body=>fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});
 try{
  const bad=msg([ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1_000_000_000n})]);
  assert.equal((await post({message:Buffer.from(bad.serialize()).toString('base64')})).status,403);
  const good=msg([ComputeBudgetProgram.setComputeUnitLimit({units:1_000_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:12_000n}),kids(21)]);const goodB64=Buffer.from(good.serialize()).toString('base64');
  assert.equal((await post({message:goodB64,operationId:'fee:1'})).status,200);
  assert.equal((await post({message:goodB64,operationId:'fee:1'})).status,200,'a retry of the same bytes is fine');
  const good2=msg([ComputeBudgetProgram.setComputeUnitLimit({units:1_000_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:11_000n}),kids(21)]);
  assert.equal((await post({message:Buffer.from(good2.serialize()).toString('base64'),operationId:'fee:1'})).status,409,'same id, different message');
  assert.equal((await post({message:Buffer.from(good2.serialize()).toString('base64'),operationId:'fee:2'})).status,403,'hourly spending limit (12,000 + 11,000 lamports > 20,000)');
  assert.ok(logs.some(l=>l.event==='signer-refused'&&/priority fee|does nothing|invoke/.test(l.reason)));
 }finally{await new Promise(r=>s.server.close(r));}
});
test('metadata creation is a provisioning-only operation: immutable, operator as authority and payer, https uri',async()=>{
 const {createMetadataInstruction}=await import('../token-metadata.mjs');
 const mint=Keypair.generate().publicKey,ok=createMetadataInstruction({mint,mintAuthority:operator.publicKey,payer:operator.publicKey,name:'KIDS test coin',symbol:'KTEST',uri:'https://gateway.pinata.cloud/ipfs/bafyTest'});
 assert.equal(ev([ok],{provisioning:true}).ok,true);
 assert.match(ev([ok]).reason,/metadata/);
 const foreign=createMetadataInstruction({mint,mintAuthority:other.publicKey,payer:operator.publicKey,name:'x',symbol:'X',uri:'https://a'});assert.match(ev([foreign],{provisioning:true}).reason,/authority|payer/);
 const mutable=createMetadataInstruction({mint,mintAuthority:operator.publicKey,payer:operator.publicKey,name:'x',symbol:'X',uri:'https://a'});mutable.data[mutable.data.length-2]=1;assert.match(ev([mutable],{provisioning:true}).reason,/not allowed/);
 const http=createMetadataInstruction({mint,mintAuthority:operator.publicKey,payer:operator.publicKey,name:'x',symbol:'X',uri:'http://a'});assert.match(ev([http],{provisioning:true}).reason,/bounds/);
});
