// The keeper's funding-first path in the chain adapter, on a mocked ledger with the durable journal: launchTable sends the
// creation packet and the further chunks (waiting for the previous chunk to finalize, because the signer proves the table
// at finalized commitment), bound to the campaign's durable plan; launchFundingFirst pins the finalized table into the
// durable packet, compiles the 33-account launch through it and journals the mint and fee NFT co-signatures.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Keypair,PublicKey,VersionedTransaction,TransactionMessage,AddressLookupTableProgram,AddressLookupTableInstruction} from '@solana/web3.js';
import {openRegistry} from '../registry/registry.mjs';
import {createChainAdapter} from './chain-adapter.mjs';
import * as c from './client.mjs';
import * as policy from './policy.mjs';
import {extAddress,launchTableAddresses,displayHash,OFF_ACCOUNTING_VERSION,ACCOUNTING_VERSION_FUNDING_FIRST,EXT_LEN,LOOKUP_TABLE_CHUNK,parseLaunchDisplayData} from '../protocol-v3/client.mjs';
import {resolvePinnedLookups} from '../signer/lookup-resolution.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {encodeLookupTableAccount,U64_MAX} from '../test/helpers/lookup-table-account.mjs';
const vector=JSON.parse(readFileSync(new URL('./test-vectors.json',import.meta.url))).termsHash.find(v=>v.name==='standard');
const key=()=>Keypair.generate().publicKey;
function fixture(){
 const keeper=Keypair.generate(),creator=key(),treasury=key(),program=key(),genesis=key(),mint=Keypair.generate(),feeNft=Keypair.generate();
 const t0={...vector.terms,genesis:c.keyHex(genesis),creator:c.keyHex(creator),treasury:c.keyHex(treasury),childMint:c.keyHex(mint.publicKey)};
 const campaign=c.campaignAddress(program,creator,t0.nonce),data=Buffer.alloc(policy.CAMPAIGN_LEN);
 c.CAMPAIGN_MAGIC.copy(data);policy.encodeTerms(t0).copy(data,8);policy.termsHash(data.subarray(8,808)).copy(data,808);data[OFF_ACCOUNTING_VERSION]=ACCOUNTING_VERSION_FUNDING_FIRST;
 const terms=c.decodeCampaign(data).terms,display={name:'Funding First',symbol:'FF',uri:terms.metadataUri};
 const ext=Buffer.alloc(EXT_LEN);Buffer.from('KIDSEXT2').copy(ext);campaign.toBuffer().copy(ext,8);mint.publicKey.toBuffer().copy(ext,72);feeNft.publicKey.toBuffer().copy(ext,104);Buffer.from(displayHash(display),'hex').copy(ext,136);ext[168]=ACCOUNTING_VERSION_FUNDING_FIRST;
 const accounts=new Map([[String(campaign),{owner:program,executable:false,lamports:7000000,data}],[String(extAddress(program,campaign)),{owner:program,executable:false,lamports:2000000,data:ext}]]);
 const table={key:null,addresses:[],lastExtendedSlot:0};let slot=1000,finalizedLag=0;const sent=[];
 const connection={
  getAccountInfoAndContext:async(k,commitment)=>{if(table.key&&String(k)===table.key){const visible=commitment==='finalized'?table.addresses.slice(0,Math.max(0,table.addresses.length-finalizedLag)):table.addresses;if(!visible.length)return {context:{slot},value:null};return {context:{slot},value:{owner:AddressLookupTableProgram.programId,executable:false,lamports:1,data:encodeLookupTableAccount({authority:keeper.publicKey,addresses:visible,lastExtendedSlot:table.lastExtendedSlot})}};}const a=accounts.get(String(k));return {context:{slot},value:a??null};},
  getAccountInfo:async k=>accounts.get(String(k))??null,
  getLatestBlockhashAndContext:async()=>({context:{slot},value:{blockhash:key().toBase58(),lastValidBlockHeight:slot+150}}),
  getBlockHeight:async()=>slot,
  sendRawTransaction:async wire=>{const tx=VersionedTransaction.deserialize(Buffer.from(wire));sent.push(tx);
   // The ledger applies lookup-table instructions: create, then extend.
   if(!tx.message.addressTableLookups.length)for(const ix of TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:[]}).instructions){if(!ix.programId.equals(AddressLookupTableProgram.programId))continue;const kind=AddressLookupTableInstruction.decodeInstructionType(ix);if(kind==='CreateLookupTable'){table.key=String(AddressLookupTableInstruction.decodeCreateLookupTable(ix).lookupTable??ix.keys[0].pubkey);}else if(kind==='ExtendLookupTable'){table.addresses.push(...AddressLookupTableInstruction.decodeExtendLookupTable(ix).addresses);table.lastExtendedSlot=slot;}}
   slot++;return 'sig';},
  confirmTransaction:async()=>({context:{slot},value:{err:null}}),
 };
 const registry=openRegistry();registry.migrate();
 const chain=createChainAdapter({connection,programId:program,signer:keeper,genesisHash:genesis,registry,commitment:'confirmed',confirmationWaitMs:1000});
 const id={genesisHash:String(genesis),programId:String(program),campaign:String(campaign)};
 return {keeper,program,campaign,terms,display,mint,feeNft,chain,id,registry,table,sent,accounts,setSlot:v=>{slot=v;},setLag:v=>{finalizedLag=v;}};
}
test('launchTable: creation packet, then each further chunk once the previous one is finalized, all bound to the plan',async()=>{
 const f=fixture();
 try{
  const recentSlot=990,[,planned]=AddressLookupTableProgram.createLookupTable({authority:f.keeper.publicKey,payer:f.keeper.publicKey,recentSlot});
  await assert.rejects(f.chain.launchTable(f.id,{}),/plan required/);
  await assert.rejects(f.chain.launchTable(f.id,{plan:{table:String(key()),recentSlot}}),/does not derive/);
  const after=[];
  const result=await f.chain.launchTable(f.id,{plan:{table:planned.toBase58(),recentSlot},operationKey:'launch-table',fencingToken:1,afterPacket:async(r,step)=>{after.push([step,r.status,f.sent.length]);}});
  assert.equal(result.status,'confirmed');assert.equal(result.table,planned.toBase58());assert.equal(result.steps,2);assert.equal(result.addresses,30);
  assert.deepEqual(after,[[1,'confirmed',1],[2,'confirmed',2]],'the hook runs after each confirmed packet, before the next chunk is sent');
  const expected=launchTableAddresses(f.program,f.campaign,f.terms,f.feeNft.publicKey);
  assert.deepEqual(f.table.addresses.map(String),expected.map(String),'the ledger table holds the launch template in order');
  assert.equal(f.sent.length,2);
  const first=TransactionMessage.decompile(f.sent[0].message,{addressLookupTableAccounts:[]}).instructions,second=TransactionMessage.decompile(f.sent[1].message,{addressLookupTableAccounts:[]}).instructions;
  assert.deepEqual(first.slice(1).map(ix=>AddressLookupTableInstruction.decodeInstructionType(ix)),['CreateLookupTable','ExtendLookupTable']);assert.equal(AddressLookupTableInstruction.decodeExtendLookupTable(first[2]).addresses.length,LOOKUP_TABLE_CHUNK);
  assert.deepEqual(second.slice(1).map(ix=>AddressLookupTableInstruction.decodeInstructionType(ix)),['ExtendLookupTable']);assert.equal(AddressLookupTableInstruction.decodeExtendLookupTable(second[1]).addresses.length,10);
  const rows=[];for(const n of [1,2,3]){const row=await f.registry.operatorPackets.latest(canonicalHash({...f.id,operationId:'launch-table:'+planned.toBase58()+':'+n}));if(row)rows.push(JSON.parse(row.descriptor));}
  assert.deepEqual(rows.map(d=>d.operationId),['launch-table:'+planned.toBase58()+':1','launch-table:'+planned.toBase58()+':2'],'packet ids are bound to the planned table, one per chunk');
  assert.ok(rows.every(d=>d.operationKey==='launch-table'&&d.computeUnits===100000));
  const again=await f.chain.launchTable(f.id,{plan:{table:planned.toBase58(),recentSlot},operationKey:'launch-table',fencingToken:1});
  assert.equal(again.status,'confirmed');assert.equal(f.sent.length,2,'a retry returns the journaled packets, nothing is rebuilt');
 }finally{f.registry.close();}
});
test('launchTable: a chunk is never sent before the previous one is finalized; an unfinished wait is an unknown outcome',async()=>{
 const f=fixture();f.setLag(100);
 try{
  const recentSlot=990,[,planned]=AddressLookupTableProgram.createLookupTable({authority:f.keeper.publicKey,payer:f.keeper.publicKey,recentSlot});
  const result=await f.chain.launchTable(f.id,{plan:{table:planned.toBase58(),recentSlot},finalityWaitMs:1200});
  assert.equal(result.status,'unknown');assert.match(result.error,/awaiting lookup table finality before chunk 2/);assert.equal(result.step,2);assert.equal(f.sent.length,1,'only the creation packet left the process');
 }finally{f.registry.close();}
});
test('launchFundingFirst: the finalized, warm table is pinned into the durable packet, the launch compiles through it, mint and fee NFT co-sign',async()=>{
 const f=fixture();
 try{
  const recentSlot=990,[,planned]=AddressLookupTableProgram.createLookupTable({authority:f.keeper.publicKey,payer:f.keeper.publicKey,recentSlot});
  await f.chain.launchTable(f.id,{plan:{table:planned.toBase58(),recentSlot}});
  f.setSlot(2000);
  await assert.rejects(f.chain.launchFundingFirst(f.id,{table:planned.toBase58(),mint:f.mint,feeNft:key(),display:f.display}),/signers/);
  const launched=await f.chain.launchFundingFirst(f.id,{table:planned.toBase58(),mint:f.mint,feeNft:f.feeNft,display:f.display,operationKey:'launch',fencingToken:1});
  assert.equal(launched.status,'confirmed');assert.equal(launched.table,planned.toBase58());assert.equal(launched.mint,f.mint.publicKey.toBase58());assert.equal(launched.feeNft,f.feeNft.publicKey.toBase58());
  const row=await f.registry.operatorPackets.latest(launched.packetRef.operationId),d=JSON.parse(row.descriptor);
  assert.deepEqual(d.lookupTables,[planned.toBase58()]);assert.equal(d.intent.action,'launch-v2');assert.equal(d.intent.displayHash,displayHash(f.display));assert.equal(d.computeUnits,400000);
  assert.equal(row.prepared.lookups.length,1);assert.equal(row.prepared.lookups[0].table,planned.toBase58());assert.equal(row.prepared.lookups[0].addresses.length,30);
  const tx=VersionedTransaction.deserialize(Buffer.from(row.signedBase64,'base64'));
  assert.equal(tx.message.header.numRequiredSignatures,3,'keeper, mint and fee NFT');assert.ok(tx.serialize().length<=1232);
  const {loadedAddresses,tables}=resolvePinnedLookups(tx.message,row.prepared.lookups);assert.ok(loadedAddresses.writable.length+loadedAddresses.readonly.length>=25,'most launch accounts resolve through the table');
  const ix=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:tables}).instructions[1];assert.equal(ix.keys.length,33);assert.equal(ix.data[0],42);assert.deepEqual(parseLaunchDisplayData(ix.data.subarray(1)),f.display);
  assert.ok(ix.keys[3].pubkey.equals(f.mint.publicKey)&&ix.keys[3].isSigner);assert.ok(ix.keys[6].pubkey.equals(f.feeNft.publicKey)&&ix.keys[6].isSigner);
 }finally{f.registry.close();}
});
test('launchFundingFirst with a custody co-signer: the reserved keys come from the extension and the hook receives the launch reference',async()=>{
 const f=fixture();
 try{
  const recentSlot=990,[,planned]=AddressLookupTableProgram.createLookupTable({authority:f.keeper.publicKey,payer:f.keeper.publicKey,recentSlot});
  await f.chain.launchTable(f.id,{plan:{table:planned.toBase58(),recentSlot}});f.setSlot(2000);
  const refs=[];
  const launched=await f.chain.launchFundingFirst(f.id,{table:planned.toBase58(),display:f.display,operationKey:'launch',fencingToken:1,coSign:async(tx,ref)=>{refs.push(ref);tx.sign([f.mint,f.feeNft]);return tx;}});
  assert.equal(launched.status,'confirmed');assert.equal(launched.mint,f.mint.publicKey.toBase58());assert.equal(launched.feeNft,f.feeNft.publicKey.toBase58());
  assert.equal(refs.length,1);assert.equal(refs[0].campaign,f.id.campaign);assert.equal(refs[0].keeper,f.keeper.publicKey.toBase58());assert.equal(refs[0].mint,f.mint.publicKey.toBase58());assert.equal(refs[0].feeNft,f.feeNft.publicKey.toBase58());assert.equal(refs[0].operationKey,'launch');assert.equal(refs[0].fencingToken,1);assert.equal(refs[0].attempt,1);assert.equal(refs[0].lookups.length,1);
  await assert.rejects(f.chain.launchFundingFirst(f.id,{table:planned.toBase58(),display:f.display}),/co-signer/);
  const wrongMint=Keypair.generate();await assert.rejects(f.chain.launchFundingFirst(f.id,{table:planned.toBase58(),display:f.display,mint:wrongMint,feeNft:f.feeNft}),/differ from the sealed extension/);
 }finally{f.registry.close();}
});
