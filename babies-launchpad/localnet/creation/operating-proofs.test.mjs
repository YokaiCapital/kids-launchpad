import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {encodeBase58} from '../../shared/solana.mjs';
import {buildOperatingFundingPacket,createOperatingProofReader} from './operating-proofs.mjs';
import {AddressLookupTableAccount} from '@solana/web3.js';
import {pinCompiledLookups} from '../signer/lookup-resolution.mjs';
const address=()=>Keypair.generate().publicKey.toBase58();
function fixture(){
 const creator=Keypair.generate(),payer=Keypair.generate(),base={genesisHash:address(),programId:address(),campaign:address(),payer:payer.publicKey.toBase58(),policy:'creator-funded-v1'},intent={...base,creator:creator.publicKey.toBase58(),lamports:'1000000'},block={blockhash:address(),lastValidBlockHeight:100,observedSlot:50};
 const tx=buildOperatingFundingPacket(intent,block);tx.sign([creator]);const funding={binding:intent,transactionBase64:Buffer.from(tx.serialize()).toString('base64'),signature:encodeBase58(tx.signatures[0]),block};
 const spendTx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:block.blockhash,instructions:[SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:payer.publicKey,lamports:0})]}).compileToV0Message());spendTx.sign([payer]);
 const spend={binding:base,operationId:'op',maximumLamports:'6000',costModel:'network-fee-only',transactionBase64:Buffer.from(spendTx.serialize()).toString('base64'),signature:encodeBase58(spendTx.signatures[0]),block};
 const x={...base,operationId:'op',messageHash:createHash('sha256').update(spendTx.message.serialize()).digest('hex'),maximumLamports:'6000'};
 function landed(tx,isFunding){const pre=tx.message.staticAccountKeys.map(()=>2000000),post=pre.slice();post[0]-=5000;if(isFunding){post[0]-=1000000;post[tx.message.staticAccountKeys.findIndex(k=>k.equals(payer.publicKey))]+=1000000;}return {slot:123,transaction:{message:tx.message,signatures:tx.signatures.map(encodeBase58)},meta:{err:null,fee:5000,preBalances:pre,postBalances:post}};}
 let f=landed(tx,true),s=landed(spendTx,false),status=null,height=99,slot=123,genesis=base.genesisHash;
 const calls=[],connection={getGenesisHash:async()=>genesis,getTransaction:async(sig,opts)=>{calls.push(opts);return sig===funding.signature?f:s;},getFirstAvailableBlock:async()=>1,getSignatureStatuses:async()=>({context:{slot},value:[status]}),getEpochInfo:async()=>({blockHeight:height,absoluteSlot:123})};
 const reader=()=>createOperatingProofReader({connection,genesisHash:base.genesisHash,loadFundingPacket:async()=>funding,loadSpendPacket:async()=>spend});
 return {base,funding,spend,x,calls,connection,reader,creator,payer,tx,get fundingTx(){return f;},get spendTx(){return s;},setFunding(v){f=v;},setSpend(v){s=v;},setStatus(v){status=v;},setHeight(v){height=v;},setSlot(v){slot=v;},setGenesis(v){genesis=v;}};
}
test('funding proof requires the exact finalized successful campaign-bound transfer and reconciled balances',async()=>{
 const f=fixture(),input={...f.base,signature:f.funding.signature},proof=await f.reader().verifyFunding(input);assert.equal(proof.lamports,'1000000');assert.equal(proof.source,f.creator.publicKey.toBase58());assert.equal(proof.finalized,true);assert.ok(f.calls.every(c=>c.commitment==='finalized'));
 await assert.rejects(f.reader().verifyFunding({...input,campaign:address()}));f.fundingTx.meta.postBalances[0]--;await assert.rejects(f.reader().verifyFunding(input));f.fundingTx.meta.postBalances[0]++;f.fundingTx.meta.err={InstructionError:[0,'x']};await assert.rejects(f.reader().verifyFunding(input));f.setFunding(null);await assert.rejects(f.reader().verifyFunding(input));
});
test('unsigned or altered funding packets cannot credit an operating budget',async()=>{
 const f=fixture(),input={...f.base,signature:f.funding.signature};f.tx.signatures[0].fill(0);f.funding.transactionBase64=Buffer.from(f.tx.serialize()).toString('base64');await assert.rejects(f.reader().verifyFunding(input));
 const g=fixture();g.funding.binding.lamports='1000001';await assert.rejects(g.reader().verifyFunding({...g.base,signature:g.funding.signature}));
});
test('finalized success and failure charge actual network fees, never a reserved maximum',async()=>{
 const f=fixture();assert.equal((await f.reader().verifyOutcome(f.x)).actualLamports,'5000');f.spendTx.meta.err={InstructionError:[0,'x']};const failed=await f.reader().verifyOutcome(f.x);assert.equal(failed.actualLamports,'5000');assert.equal(failed.executionFailed,true);
 f.spendTx.meta.postBalances[0]++;await assert.rejects(f.reader().verifyOutcome(f.x));f.spendTx.meta.postBalances[0]-=2;await assert.rejects(f.reader().verifyOutcome(f.x));f.spend.costModel='any-cost';await assert.rejects(f.reader().verifyOutcome(f.x));
});
test('unknown/confirmed/lagging results hold exposure; only finalized expiry with history releases it',async()=>{
 const f=fixture();f.setSpend(null);assert.deepEqual(await f.reader().verifyOutcome(f.x),{status:'unknown'});f.setHeight(101);f.setSlot(122);assert.deepEqual(await f.reader().verifyOutcome(f.x),{status:'unknown'});
 f.setSlot(123);f.setStatus({confirmationStatus:'confirmed',slot:122,err:null});assert.deepEqual(await f.reader().verifyOutcome(f.x),{status:'unknown'});f.setStatus(null);const expired=await f.reader().verifyOutcome(f.x);assert.equal(expired.status,'expired');assert.equal(expired.actualLamports,'0');assert.equal(expired.slot,123);
});
test('wrong chain, unsafe numeric evidence and stalled RPC fail closed',async()=>{
 const f=fixture();f.setGenesis(address());await assert.rejects(f.reader().verifyOutcome(f.x));f.setGenesis(f.base.genesisHash);f.spendTx.meta.preBalances[0]=Number.MAX_SAFE_INTEGER+1;await assert.rejects(f.reader().verifyOutcome(f.x));
 const reader=createOperatingProofReader({connection:{getGenesisHash:()=>new Promise(()=>{})},genesisHash:f.base.genesisHash,loadFundingPacket:async()=>f.funding,loadSpendPacket:async()=>f.spend,timeoutMs:10});await assert.rejects(reader.verifyOutcome(f.x),/timed out/);
});
test('missing or malformed execution status cannot settle an operating hold',async()=>{
 const f=fixture();delete f.spendTx.meta.err;await assert.rejects(f.reader().verifyOutcome(f.x),/execution status/);
 for(const err of [undefined,false,0,'',[]]){f.spendTx.meta.err=err;await assert.rejects(f.reader().verifyOutcome(f.x),/execution status/);}
 f.spendTx.meta.err='AccountNotFound';assert.equal((await f.reader().verifyOutcome(f.x)).executionFailed,true);
 f.spendTx.meta.err=null;assert.equal((await f.reader().verifyOutcome(f.x)).actualLamports,'5000');
});
test('stalled durable packet readers are bounded too',async()=>{
 const f=fixture(),reader=createOperatingProofReader({connection:f.connection,genesisHash:f.base.genesisHash,loadFundingPacket:()=>new Promise(()=>{}),loadSpendPacket:()=>new Promise(()=>{}),timeoutMs:10});
 await assert.rejects(reader.verifyFunding({...f.base,signature:f.funding.signature}),/timed out/);
 await assert.rejects(reader.verifyOutcome(f.x),/timed out/);
});

test('a lookup-table spend packet settles only with its pinned resolution, complete balances and the ledger\'s loaded addresses in pinned order',async()=>{
 const f=fixture(),to=Keypair.generate().publicKey,other=Keypair.generate().publicKey;
 const table=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:2n**64n-1n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[other,to]}});
 const message=new TransactionMessage({payerKey:f.payer.publicKey,recentBlockhash:f.spend.block.blockhash,instructions:[SystemProgram.transfer({fromPubkey:f.payer.publicKey,toPubkey:to,lamports:0})]}).compileToV0Message([table]);
 assert.equal(message.addressTableLookups.length,1);const tx=new VersionedTransaction(message);tx.sign([f.payer]);
 const lookups=pinCompiledLookups(message,{lookups:[{table:String(table.key),addresses:[String(other),String(to)]}]});
 const spend={...f.spend,transactionBase64:Buffer.from(tx.serialize()).toString('base64'),signature:encodeBase58(tx.signatures[0]),block:{...f.spend.block,lookups,lookupSlot:100}};
 const x={...f.x,messageHash:createHash('sha256').update(message.serialize()).digest('hex')};
 const reply=(loaded=[String(to)],n=message.staticAccountKeys.length+1)=>{const pre=Array.from({length:n},()=>2000000),post=pre.slice();post[0]-=5000;return {slot:123,transaction:{message,signatures:tx.signatures.map(encodeBase58)},meta:{err:null,preBalances:pre,postBalances:post,fee:5000,loadedAddresses:{writable:loaded,readonly:[]}}};};
 const reader=()=>createOperatingProofReader({connection:f.connection,genesisHash:f.base.genesisHash,loadFundingPacket:async()=>f.funding,loadSpendPacket:async()=>spend});
 f.setSpend(reply());assert.equal((await reader().verifyOutcome(x)).actualLamports,'5000');
 f.setSpend(reply([String(other)]));await assert.rejects(reader().verifyOutcome(x),/differ from the pinned resolution/,'the ledger loaded another address');
 f.setSpend({...reply(),meta:{...reply().meta,loadedAddresses:undefined}});await assert.rejects(reader().verifyOutcome(x),/differ from the pinned resolution/,'no loaded addresses reported');
 f.setSpend(reply([String(to)],message.staticAccountKeys.length));await assert.rejects(reader().verifyOutcome(x),/balance evidence/,'balances for the static keys only');
 const unpinned={...spend,block:{...f.spend.block}};f.setSpend(reply());await assert.rejects(createOperatingProofReader({connection:f.connection,genesisHash:f.base.genesisHash,loadFundingPacket:async()=>f.funding,loadSpendPacket:async()=>unpinned}).verifyOutcome(x),'a lookup packet without its pin never settles');
});
