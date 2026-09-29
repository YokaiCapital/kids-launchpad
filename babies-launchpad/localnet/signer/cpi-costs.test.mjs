import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,TransactionMessage,AddressLookupTableAccount} from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {launchInstruction,feesInitInstruction,RAYDIUM_CPMM,RAYDIUM_LOCK,AMM_CONFIG_TIERS} from '../protocol-v2/client.mjs';
import {launchFundingFirstInstruction,launchTableAddresses} from '../protocol-v3/client.mjs';
import {AddressLookupTableProgram,SystemProgram} from '@solana/web3.js';
import {rentLamports,launchAuthority} from '../signer-policy.mjs';
import {normalizeCapability,evaluateCapabilityRequest} from './capabilities.mjs';
import {CPI_RENT_BYTES,createCpiRentReader} from './cpi-costs.mjs';
import {createSignerService} from '../signer-service.mjs';
const key=()=>Keypair.generate().publicKey,NOW=1790000000000;
function fixture(){
 const payer=Keypair.generate(),program=key(),campaign=key(),genesis=key().toBase58(),mint=key(),nft=key();
 const terms={childMint:mint,ammProgram:RAYDIUM_CPMM,lockProgram:RAYDIUM_LOCK,ammConfig:AMM_CONFIG_TIERS[0].address};
 const launch=()=>launchInstruction(program,campaign,terms,payer.publicKey,nft).instruction,init=()=>feesInitInstruction(program,campaign,payer.publicKey,payer.publicKey);
 const message=ixs=>new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:key().toBase58(),instructions:ixs}).compileToV0Message();
 const raw={campaign:String(campaign),programId:String(program),genesisHash:genesis,programVersion:3,tags:[6,20],expiresAt:new Date(NOW+3600000).toISOString()};
 const evidence={genesisHash:genesis,validUntil:NOW+30000,lamportsByBytes:Object.fromEntries(CPI_RENT_BYTES.map(n=>[n,String(rentLamports(n))]))};
 const evaluate=(m,extra={})=>evaluateCapabilityRequest({message:m,campaign:String(campaign),operator:payer.publicKey,fencingToken:1,operationId:'launch:1',capabilities:new Map([[String(campaign),normalizeCapability(raw,{now:()=>NOW})]]),cpiRentEvidence:evidence,now:NOW,...extra});
 return {payer,program,campaign,genesis,mint,nft,raw,evidence,evaluate,message,launch,init};
}
test('v3 launch and fee initialization include CPI rent; v1 and v2 costs are unchanged',()=>{
 const f=fixture(),m=f.message([f.launch()]);const v=f.evaluate(m);assert.equal(v.ok,true);
 assert.equal(v.spendLamports,10000n+rentLamports(82)+rentLamports(165)*2n+rentLamports(256)+rentLamports(679));
 assert.equal(f.evaluate(f.message([f.init()])).spendLamports,5000n+rentLamports(160));
 for(const programVersion of [1,2]){const caps=new Map([[String(f.campaign),normalizeCapability({...f.raw,programVersion},{now:()=>NOW})]]);assert.equal(f.evaluate(m,{capabilities:caps,cpiRentEvidence:null}).spendLamports,10000n);}
});
test('missing, stale, wrong-ledger and unsafe rent evidence fail closed',()=>{
 const f=fixture(),m=f.message([f.launch()]);
 for(const cpiRentEvidence of [null,{...f.evidence,validUntil:NOW},{...f.evidence,validUntil:NOW+30001},{...f.evidence,genesisHash:String(key())},{...f.evidence,lamportsByBytes:{...f.evidence.lamportsByBytes,82:'9007199254740992'}}])assert.equal(f.evaluate(m,{cpiRentEvidence}).ok,false);
});
test('payer substitutions and changed CPI templates cannot hide account-creation costs',()=>{
 const f=fixture();let ix=f.launch();ix.keys[1].pubkey=key();assert.equal(f.evaluate(f.message([ix])).ok,false);
 ix=f.launch();ix.keys[6].isSigner=false;assert.equal(f.evaluate(f.message([ix])).ok,false);
 ix=f.launch();ix.data=Buffer.from([6,0]);assert.equal(f.evaluate(f.message([ix])).ok,false);
 ix=f.init();ix.keys.pop();assert.equal(f.evaluate(f.message([ix])).ok,false);
});
test('CPI and top-level rent share the lowered capability ceiling',()=>{
 const f=fixture(),cap=normalizeCapability({...f.raw,limits:{maxRentLamports:Number(rentLamports(160))}},{now:()=>NOW}),capabilities=new Map([[String(f.campaign),cap]]);
 assert.equal(f.evaluate(f.message([f.init()]),{capabilities}).ok,true);
 const ata=createAssociatedTokenAccountIdempotentInstruction(f.payer.publicKey,key(),new PublicKey(launchAuthority(f.program,f.campaign)),f.mint);
 assert.match(f.evaluate(f.message([ata,f.init()]),{capabilities}).reason,/Combined rent/);
 assert.match(f.evaluate(f.message([f.launch()]),{capabilities}).reason,/CPI rent exceeds/);
});
test('v3 does not price Token-2022 extension accounts as classic 165-byte ATAs',()=>{
 const f=fixture(),ata=createAssociatedTokenAccountIdempotentInstruction(f.payer.publicKey,key(),new PublicKey(launchAuthority(f.program,f.campaign)),f.mint);
 ata.keys[5].pubkey=new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
 assert.match(f.evaluate(f.message([ata,f.init()])).reason,/Unqualified v3 associated/);
 const caps=new Map([[String(f.campaign),normalizeCapability({...f.raw,programVersion:2},{now:()=>NOW})]]);
 assert.equal(f.evaluate(f.message([ata,f.init()]),{capabilities:caps}).ok,true,'legacy v2 behavior unchanged');
});
test('v3 ATA-only setup also requires live rent and accounts for increased cluster rent',()=>{
 const f=fixture(),ata=createAssociatedTokenAccountIdempotentInstruction(f.payer.publicKey,key(),new PublicKey(launchAuthority(f.program,f.campaign)),f.mint),m=f.message([ata,f.init()]);
 const before=f.evaluate(m);assert.equal(before.ok,true);
 const higher={...f.evidence,lamportsByBytes:{...f.evidence.lamportsByBytes,165:String(rentLamports(165)+1000n)}};
 assert.equal(f.evaluate(m,{cpiRentEvidence:higher}).spendLamports,before.spendLamports+1000n);
 const justAta=f.message([ata]);const cap=normalizeCapability(f.raw,{now:()=>NOW});
 // Capability path still requires a launch-program instruction; no standalone
 // repair bypass is introduced by the rent reader.
 assert.equal(f.evaluate(justAta,{capabilities:new Map([[String(f.campaign),cap]])}).ok,false);
});
test('live rent reader coalesces concurrent reads and refuses wrong-chain, bad amounts and timeout',async()=>{
 const f=fixture();let reads=0,bad=false,genesis=f.genesis;
 const read=createCpiRentReader({genesisHash:f.genesis,now:()=>NOW,connection:{getGenesisHash:async()=>genesis,getMinimumBalanceForRentExemption:async(n,c)=>{assert.equal(c,'finalized');reads++;return bad?NaN:Number(rentLamports(n));}}});
 const replies=await Promise.all(Array.from({length:20},()=>read()));assert.equal(reads,CPI_RENT_BYTES.length);assert.deepEqual(replies[0],f.evidence);replies[0].lamportsByBytes[82]='1';assert.notEqual(replies[1].lamportsByBytes[82],'1');
 genesis=String(key());await assert.rejects(read(),/ledger/);genesis=f.genesis;bad=true;await assert.rejects(read(),/unavailable/);
 const stalled=createCpiRentReader({genesisHash:f.genesis,timeoutMs:10,connection:{getGenesisHash:()=>new Promise(()=>{})}});await assert.rejects(stalled(),/timed out/);
});
test('service loads CPI costs before the final lease check; expiry cannot cross the signing boundary',async()=>{
 const f=fixture();let now=NOW,expire=false,calls=[];
 const cap=normalizeCapability(f.raw,{now:()=>NOW});
 const service=createSignerService({keypair:f.payer,token:'t'.repeat(40),programId:f.program,now:()=>now,capabilities:new Map([[String(f.campaign),cap]]),
  readCpiRent:async()=>{calls.push('rent');return f.evidence;},authorizeLease:async()=>{calls.push('lease');if(expire)now+=31000;return {allowed:true,validForMs:30000};}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
 const post=m=>fetch('http://127.0.0.1:'+service.server.address().port+'/sign',{method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40),'content-type':'application/json'},body:JSON.stringify({campaign:String(f.campaign),fencingToken:1,operationId:expire?'fee:init:expired':'fee:init',operationKey:'fee-init',message:Buffer.from(m.serialize()).toString('base64')})});
 try{const first=await post(f.message([f.init()]));assert.equal(first.status,200);assert.deepEqual(calls,['rent','lease']);
  expire=true;calls=[];const expired=await post(f.message([f.init()]));assert.equal(expired.status,503);assert.match((await expired.json()).error,/rent evidence expired/);assert.deepEqual(calls,['rent','lease']);
 }finally{await new Promise(r=>service.server.close(r));}
});

test('v3 funding-first launch (tag 42) reserves the lock rents plus the mint leg; the mint and fee NFT must co-sign; never a v2 tag',()=>{
 const f=fixture(),display={name:'Funding First',symbol:'FF',uri:'ipfs://'+'b'.repeat(46)};
 const ix42=()=>launchFundingFirstInstruction(f.program,f.campaign,{childMint:f.mint,ammProgram:RAYDIUM_CPMM,lockProgram:RAYDIUM_LOCK,ammConfig:AMM_CONFIG_TIERS[0].address},f.payer.publicKey,f.nft,display).instruction;
 // The 33-account packet only fits through a lookup table; the evaluator sees the resolved keys as the signer resolves them.
 const table=new AddressLookupTableAccount({key:key(),state:{deactivationSlot:2n**64n-1n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[...new Set(ix42().keys.filter(k=>!k.isSigner).map(k=>String(k.pubkey)))].map(k=>new PublicKey(k))}});
 const caps=tags=>new Map([[String(f.campaign),normalizeCapability({...f.raw,tags},{now:()=>NOW})]]);
 const ev=(ix,tags=[42])=>{const m=new TransactionMessage({payerKey:f.payer.publicKey,recentBlockhash:key().toBase58(),instructions:[ix]}).compileToV0Message([table]);return f.evaluate(m,{capabilities:caps(tags),loadedAddresses:m.getAccountKeys({addressLookupTableAccounts:[table]}).accountKeysFromLookups});};
 const v=ev(ix42());assert.equal(v.ok,true,v.reason);
 assert.equal(v.spendLamports,15000n+rentLamports(82)*2n+rentLamports(165)*4n+rentLamports(256)+rentLamports(607)+10000000n,'three signatures, eight rents and the Metaplex creation fee');
 assert.equal(ev(ix42(),[6]).ok,false,'tag 42 is outside a tag-6 grant');
 let ix=ix42();ix.keys[3].isSigner=false;assert.equal(ev(ix).ok,false,'the child mint must sign');
 ix=ix42();ix.keys[6].isSigner=false;assert.equal(ev(ix).ok,false,'the fee NFT must sign');
 ix=f.launch();ix.data=Buffer.concat([Buffer.from([42]),ix42().data.subarray(1)]);assert.equal(ev(ix).ok,false,'29 accounts are not a funding-first launch');
 ix=ix42();ix.data=Buffer.from([42]);assert.equal(ev(ix).ok,false,'display bytes are part of the template');
 assert.throws(()=>normalizeCapability({...f.raw,programVersion:2,tags:[42]},{now:()=>NOW}),/not a keeper tag of program version 2/);
});

test('a version-3 tag-42 grant may sign the keeper\'s lookup-table setup and nothing else that skips the program',()=>{
 const f=fixture(),terms={childMint:f.mint,ammProgram:RAYDIUM_CPMM,lockProgram:RAYDIUM_LOCK,ammConfig:AMM_CONFIG_TIERS[0].address};
 const addresses=launchTableAddresses(f.program,f.campaign,terms,f.nft),[create,table]=AddressLookupTableProgram.createLookupTable({authority:f.payer.publicKey,payer:f.payer.publicKey,recentSlot:10});
 const extend=AddressLookupTableProgram.extendLookupTable({lookupTable:table,authority:f.payer.publicKey,payer:f.payer.publicKey,addresses:addresses.slice(0,20)});
 const caps=(tags,programVersion=3)=>new Map([[String(f.campaign),normalizeCapability({...f.raw,tags,programVersion},{now:()=>NOW})]]);
 const v=f.evaluate(f.message([create,extend]),{capabilities:caps([42]),cpiRentEvidence:null});assert.equal(v.ok,true,v.reason);
 assert.equal(v.spendLamports,5000n+rentLamports(56)+rentLamports(640));assert.deepEqual(v.operations,['alt-create','alt-extend']);
 assert.equal(f.evaluate(f.message([extend]),{capabilities:caps([42]),cpiRentEvidence:null}).ok,true,'an extension alone');
 assert.match(f.evaluate(f.message([create,extend]),{capabilities:caps([6,20]),cpiRentEvidence:null}).reason,/funding-first launch tag/);
 assert.throws(()=>caps([6,20,42],2),/not a keeper tag of program version 2/,'version 2 can never hold tag 42');
 assert.match(f.evaluate(f.message([create,extend]),{capabilities:caps([6,20],2),cpiRentEvidence:null}).reason,/does not invoke the launch program/,'version 2 never signs a table setup');
 assert.equal(f.evaluate(f.message([create,extend,SystemProgram.transfer({fromPubkey:f.payer.publicKey,toPubkey:key(),lamports:1})]),{capabilities:caps([42]),cpiRentEvidence:null}).ok,false,'a transfer mixed in');
 const foreign=AddressLookupTableProgram.extendLookupTable({lookupTable:table,authority:key(),payer:f.payer.publicKey,addresses:addresses.slice(0,2)});
 assert.equal(f.evaluate(f.message([foreign]),{capabilities:caps([42]),cpiRentEvidence:null}).ok,false,'another authority');
});
