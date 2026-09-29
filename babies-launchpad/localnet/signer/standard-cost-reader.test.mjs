import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Keypair,PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,SystemProgram,SYSVAR_CLOCK_PUBKEY,AddressLookupTableAccount} from '@solana/web3.js';
import {pinCompiledLookups} from './lookup-resolution.mjs';
import {launchFundingFirstInstruction,launchTableAddresses,extAddress,displayHash,OFF_ACCOUNTING_VERSION,ACCOUNTING_VERSION_FUNDING_FIRST,EXT_LEN} from '../protocol-v3/client.mjs';
import {AddressLookupTableProgram} from '@solana/web3.js';
import {encodeLookupTableAccount} from '../test/helpers/lookup-table-account.mjs';
import {FUNDING_FIRST_LAUNCH_MODEL,LOOKUP_TABLE_MODEL} from '../creation/operating-costs.mjs';
import * as c from '../protocol-v2/client.mjs';
import * as policy from '../protocol-v2/policy.mjs';
import {createStandardOperatingCostReader} from './standard-cost-reader.mjs';
import {feeSetupInstructions,operatingCostModel,reconcileOperatingCost,operatingReturnInstructions,MEMO_PROGRAM} from '../creation/operating-costs.mjs';
import {normalizeCapability} from './capabilities.mjs';
const vector=JSON.parse(readFileSync(new URL('../protocol-v2/test-vectors.json',import.meta.url))).termsHash.find(v=>v.name==='standard');
const key=()=>Keypair.generate().publicKey;
function fixture(){
 // Separate identities as on mainnet: the payer (keeper) and the sealed platform treasury are different keys.
 const genesis=key(),program=key(),payer=key(),treasury=key(),creator=key(),operator=key(),nft=key();
 const t={...vector.terms,genesis:c.keyHex(genesis),creator:c.keyHex(creator),treasury:c.keyHex(treasury)};
 const campaign=c.campaignAddress(program,creator,t.nonce),data=Buffer.alloc(policy.CAMPAIGN_LEN);
 c.CAMPAIGN_MAGIC.copy(data);policy.encodeTerms(t).copy(data,8);policy.termsHash(data.subarray(8,808)).copy(data,808);
 const terms=c.decodeCampaign(data).terms,pool=c.cpmmAddresses(terms.ammProgram,terms.ammConfig,terms.childMint).pool;
 pool.toBuffer().copy(data,928);nft.toBuffer().copy(data,960);
 const state={pool,feeNft:nft},accounts=new Map([[String(campaign),{data,owner:program,executable:false}]]);let ledger=String(genesis);
 const connection={getGenesisHash:async()=>ledger,getAccountInfo:async address=>accounts.get(String(address))??null,getMinimumBalanceForRentExemption:async size=>(size+128)*6960};
 const base={genesisHash:String(genesis),programId:String(program),payer:String(payer),campaign:String(campaign),maximumLamports:'20000000'},descriptor={...base,computeUnits:600000};
 const reader=createStandardOperatingCostReader({connection,...base,feeOperator:operator,treasury:String(treasury)});
 const make=(instructions,compute=[ComputeBudgetProgram.setComputeUnitLimit({units:descriptor.computeUnits})])=>({binding:{...base},descriptor:{...descriptor},packet:Buffer.from(new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:String(key()),instructions:[...compute,...instructions]}).compileToV0Message()).serialize()).toString('base64')});
 const receipt=(owner=key())=>{const address=c.receiptAddress(program,campaign,owner),d=Buffer.alloc(c.RECEIPT_LEN);c.RECEIPT_MAGIC.copy(d);campaign.toBuffer().copy(d,8);owner.toBuffer().copy(d,40);accounts.set(String(address),{data:d,owner:program});return {owner,address};};
 return {base,descriptor,reader,make,receipt,terms,state,accounts,data,program,campaign,payer,treasury,operator,nft,connection,setLedger:x=>{ledger=x;}};
}
test('sealed Standard templates classify lifecycle, batched refunds and fee operations',async()=>{
 const f=fixture(),r=f.receipt(),r2=f.receipt();
 const templates=[
  [c.finalizeInstruction(f.program,f.campaign)],
  [c.assertReadyInstruction(f.program,f.campaign)],
  [c.settleInstruction(f.program,f.campaign,r.owner),c.settleInstruction(f.program,f.campaign,r2.owner)],
  [c.refundInstruction(f.program,f.campaign,r.owner),c.refundInstruction(f.program,f.campaign,r2.owner)],
  [c.feesCollectInstruction(f.program,f.campaign,f.terms,f.state,f.payer,123n)],
  [c.feesDistributeInstruction(f.program,f.campaign,f.terms,f.payer)],
  [c.feesBurnChildInstruction(f.program,f.campaign,f.terms,f.payer,123n)]];
 for(const ixs of templates)assert.deepEqual(await f.reader(f.make(ixs)),{costModel:'network-fee-only'});
 const init=await f.reader(f.make([c.feesInitInstruction(f.program,f.campaign,f.payer,f.operator)]));assert.equal(init.costModel,'v3-fee-state-rent');assert.equal(init.costIntent.maximumRentLamports,'2004480');
 const lock=await f.reader(f.make([c.launchInstruction(f.program,f.campaign,f.terms,f.payer,f.nft).instruction]));assert.equal(lock.costModel,'v3-launch-lock-rent');assert.equal(lock.costIntent.maximumRentLamports,'13829520');
});
test('cost reader rejects recipient substitution, operator rotation, extra transfer, priority fee and altered flags',async()=>{
 const f=fixture(),distribution=()=>c.feesDistributeInstruction(f.program,f.campaign,f.terms,f.payer);
 const foreign=distribution();foreign.keys[5].pubkey=key();
 const wrongFlag=distribution();wrongFlag.keys[7].isWritable=true;
 const extraData=distribution();extraData.data=Buffer.from([23,1]);
 const cases=[f.make([foreign]),f.make([wrongFlag]),f.make([extraData]),f.make([distribution(),SystemProgram.transfer({fromPubkey:f.payer,toPubkey:key(),lamports:1})]),f.make([c.feesRotateOperatorInstruction(f.program,f.campaign,f.payer,key())]),f.make([c.feesInitInstruction(f.program,f.campaign,f.payer,key())]),f.make([distribution()],[ComputeBudgetProgram.setComputeUnitLimit({units:600000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000})])];
 for(const input of cases)await assert.rejects(f.reader(input));
});
test('receipt cost review refuses duplicates, foreign receipts and refund-payer aliasing',async()=>{
 const f=fixture(),r=f.receipt(),ix=c.refundInstruction(f.program,f.campaign,r.owner);
 await assert.rejects(f.reader(f.make([ix,ix])),/Duplicate/);
 const alias=f.receipt(f.payer);await assert.rejects(f.reader(f.make([c.refundInstruction(f.program,f.campaign,alias.owner)])),/recipient/);
 const a=f.accounts.get(String(r.address));key().toBuffer().copy(a.data,8);await assert.rejects(f.reader(f.make([ix])),/Foreign/);
});
test('ledger, sealed state, payer and malformed scope fail closed',async()=>{
 for(const mutate of [f=>f.setLedger(String(key())),f=>{f.data[10]^=1;},f=>{f.accounts.get(String(f.campaign)).owner=key();}]){
  const f=fixture();mutate(f);await assert.rejects(f.reader(f.make([c.finalizeInstruction(f.program,f.campaign)])));
 }
 const f=fixture(),x=f.make([c.finalizeInstruction(f.program,f.campaign)]);x.descriptor.payer=String(key());await assert.rejects(f.reader(x),/scope/);
 const i=f.make([c.feesInitInstruction(f.program,f.campaign,f.payer,f.operator)]);i.binding.maximumLamports='1000';await assert.rejects(f.reader(i),/ceiling/);
});
test('fee setup sponsors only exact sealed accounts and reconciles new or existing account rent',async()=>{
 const f=fixture(),instructions=feeSetupInstructions({programId:f.program,campaign:f.campaign,payer:f.payer,operator:f.operator,terms:f.terms}),input=f.make(instructions),cost=await f.reader(input);
 assert.equal(cost.costModel,'v3-fee-setup-rent');assert.equal(cost.costIntent.maximumRentLamports,'10161600');
 const tx=VersionedTransaction.deserialize(Buffer.from(input.packet,'base64')),model=operatingCostModel({...cost,block:{blockhash:tx.message.recentBlockhash}},{tx,bytes:tx.message.serialize()},{...input.binding,treasury:String(f.treasury)});
 // A reader pinned to another treasury (a legacy fixture that names none uses the payer) refuses this campaign's fee setup.
 await assert.rejects(createStandardOperatingCostReader({connection:f.connection,...f.base,feeOperator:f.operator})(input),/pinned treasury/);
 assert.throws(()=>operatingCostModel({...cost,block:{blockhash:tx.message.recentBlockhash}},{tx,bytes:tx.message.serialize()},input.binding),/pinned treasury/);
 const pre=tx.message.staticAccountKeys.map(()=>0),post=pre.slice();pre[0]=20000000;
 // One ATA already exists. Its rent cannot be charged a second time.
 model.rentIndices.forEach((index,i)=>{if(i===0){pre[index]=post[index]=2039280;}else post[index]=i===model.rentIndices.length-1?2004480:2039280;});
 post[0]=pre[0]-5000-model.rentIndices.reduce((n,i)=>n+post[i]-pre[i],0);
 assert.equal(reconcileOperatingCost(model,{pre,post,fee:5000n,failed:false}),8127320n);
 const failed=pre.slice();failed[0]-=5000;assert.equal(reconcileOperatingCost(model,{pre,post:failed,fee:5000n,failed:true}),5000n);
 post[model.rentIndices[0]]--;assert.throws(()=>reconcileOperatingCost(model,{pre,post,fee:5000n,failed:false}));
 const substitute=feeSetupInstructions({programId:f.program,campaign:f.campaign,payer:f.payer,operator:f.operator,terms:{...f.terms,dev:key()}});await assert.rejects(f.reader(f.make(substitute)),/template/);
 await assert.rejects(f.reader(f.make([...instructions.slice(0,-1),instructions[0],instructions.at(-1)])),/template/);
});
test('fee-setup grant never grants legacy programs, ordinary transfers or arbitrary tag combinations',()=>{
 const f=fixture(),grant={...f.base,kind:'fee-setup',programVersion:3,recipients:[String(f.terms.treasury),String(f.terms.dev)],tags:[20],expiresAt:new Date(Date.now()+60000).toISOString()};
 assert.equal(normalizeCapability(grant).kind,'fee-setup');
 for(const patch of [{programVersion:2},{tags:[20,23]},{tags:[6]},{recipients:[]},{recipients:[String(f.terms.dev),String(f.terms.dev)]}])assert.throws(()=>normalizeCapability({...grant,...patch}),/Fee setup/);
 assert.throws(()=>normalizeCapability({...grant,kind:'keeper'}),/no recipients/);
});
test('a reserve return qualifies only for a terminally refunded campaign, only to its sealed creator, only as the exact transfer and memo',async()=>{
 const f=fixture(),creator=String(f.terms.creator),lamports='19995000';
 const clock=Buffer.alloc(40);const setClock=unix=>{clock.writeBigInt64LE(BigInt(unix),32);f.accounts.set(String(SYSVAR_CLOCK_PUBKEY),{data:clock,owner:SystemProgram.programId,executable:false});};
 const setState=({phase,total,refunded})=>{f.data[840]=phase;f.data.writeBigUInt64LE(total,848);f.data.writeBigUInt64LE(refunded,856);};
 const build=(ixs)=>f.make(ixs);
 const good=operatingReturnInstructions({genesisHash:f.base.genesisHash,programId:f.base.programId,campaign:f.base.campaign,payer:f.base.payer},{creator,lamports});
 // Not failed yet: funding window still open with the soft cap met.
 setState({phase:0,total:f.terms.soft,refunded:f.terms.soft});setClock(f.terms.launchDeadline-1n);
 await assert.rejects(f.reader(build(good)),/terminally refunded/);
 // Deadline-aware: an open round with nothing committed (refunded equals total, both zero) is not terminally refunded either.
 setState({phase:0,total:0n,refunded:0n});setClock(f.terms.deadline-1n);
 await assert.rejects(f.reader(build(good)),/terminally refunded/);
 // Refund-only but refunds incomplete.
 setState({phase:2,total:2000000000n,refunded:1999999000n});setClock(f.terms.launchDeadline+1n);
 await assert.rejects(f.reader(build(good)),/terminally refunded/);
 // Terminally refunded: exact template qualifies as a return of the reviewed amount.
 setState({phase:2,total:2000000000n,refunded:2000000000n});
 const cost=await f.reader(build(good));assert.equal(cost.costModel,'v3-operating-return');assert.deepEqual(cost.costIntent,{programVersion:3,creator,lamports,computeUnits:f.descriptor.computeUnits});
 const stranger=String(key());
 await assert.rejects(f.reader(build(operatingReturnInstructions({genesisHash:f.base.genesisHash,programId:f.base.programId,campaign:f.base.campaign,payer:f.base.payer},{creator:stranger,lamports}))),/sealed creator/);
 const wrongMemo=[good[0],{...good[1],data:Buffer.from('KIDS operating return:'+'f'.repeat(64))}];
 await assert.rejects(f.reader(build([good[0],new (good[1].constructor)({programId:MEMO_PROGRAM,keys:[],data:Buffer.from('KIDS operating return:'+'f'.repeat(64))})])),/differs/);
 await assert.rejects(f.reader(build([...good,c.finalizeInstruction(f.program,f.campaign)])),/not qualified/);
 await assert.rejects(f.reader(build([good[0]])),/not qualified/);
 await assert.rejects(f.reader(build(operatingReturnInstructions({genesisHash:f.base.genesisHash,programId:f.base.programId,campaign:f.base.campaign,payer:f.base.payer},{creator,lamports:'20000000'}))),/Invalid operating return intent/);
 void wrongMemo;
});

test('a lookup-table packet reaches the exact template only through its pinned resolution',async()=>{
 const f=fixture(),ix=c.assertReadyInstruction(f.program,f.campaign);
 const table=new AddressLookupTableAccount({key:key(),state:{deactivationSlot:2n**64n-1n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[key(),f.campaign,key()]}});
 const compile=tables=>new TransactionMessage({payerKey:f.payer,recentBlockhash:String(key()),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:f.descriptor.computeUnits}),ix]}).compileToV0Message(tables);
 const message=compile([table]);assert.equal(message.addressTableLookups.length,1,'the campaign resolves through the table');
 const packet=Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
 const lookups=pinCompiledLookups(message,{lookups:[{table:String(table.key),addresses:table.state.addresses.map(String)}]});
 assert.deepEqual(lookups[0].writableIndexes.concat(lookups[0].readonlyIndexes),[1]);
 const read=patch=>f.reader({binding:{...f.base},descriptor:{...f.descriptor},packet,...patch});
 assert.deepEqual(await read({lookups}),{costModel:'network-fee-only'},'pinned: decompiled and recompiled through the same table');
 await assert.rejects(read({}),/Unqualified/,'a lookup-table packet without its pin is unqualified');
 await assert.rejects(read({lookups:[{...lookups[0],addresses:[String(key()),String(key()),String(key())]}]}),/foreign|differs|Unqualified/,'a pin whose entries differ resolves to other accounts and never matches');
 await assert.rejects(read({lookups:[{...lookups[0],writableIndexes:[],readonlyIndexes:[2]}]}),/differ from the pinned resolution/,'indexes other than the message selects');
 await assert.rejects(read({lookups:[{...lookups[0],table:String(key())}]}),/differs from the pinned resolution/,'another table');
 const plain=Buffer.from(new VersionedTransaction(compile([])).serialize()).toString('base64');
 await assert.rejects(read({packet:plain,lookups}),/differ from the pinned resolution/,'a pin for a packet that uses no table');
 assert.deepEqual(await read({packet:plain}),{costModel:'network-fee-only'},'static packets are unchanged');
});

test('funding-first launch (tag 42) classifies only for a version-2 record whose display matches the opening commitment and the sealed URI',async()=>{
 const f=fixture(),display={name:'Funding First',symbol:'FF',uri:f.terms.metadataUri};
 const ext=Buffer.alloc(EXT_LEN);Buffer.from('KIDSEXT2').copy(ext);f.campaign.toBuffer().copy(ext,8);f.terms.childMint.toBuffer().copy(ext,72);f.nft.toBuffer().copy(ext,104);Buffer.from(displayHash(display),'hex').copy(ext,136);ext[168]=ACCOUNTING_VERSION_FUNDING_FIRST;
 const extKey=String(extAddress(f.program,f.campaign));f.accounts.set(extKey,{data:ext,owner:f.program,executable:false});
 const packetFor=(d,tables)=>{const {instruction}=launchFundingFirstInstruction(f.program,f.campaign,f.terms,f.payer,f.nft,d);const message=new TransactionMessage({payerKey:f.payer,recentBlockhash:String(key()),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:f.descriptor.computeUnits}),instruction]}).compileToV0Message(tables);return {message,instruction,packet:Buffer.from(new VersionedTransaction(message).serialize()).toString('base64')};};
 const {instruction}=launchFundingFirstInstruction(f.program,f.campaign,f.terms,f.payer,f.nft,display);
 const table=new AddressLookupTableAccount({key:key(),state:{deactivationSlot:2n**64n-1n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[...new Set(instruction.keys.filter(k=>!k.isSigner).map(k=>String(k.pubkey)))].map(k=>new PublicKey(k))}});
 const built=packetFor(display,[table]),lookups=pinCompiledLookups(built.message,{lookups:[{table:String(table.key),addresses:table.state.addresses.map(String)}]});
 const read=patch=>f.reader({binding:{...f.base,maximumLamports:'40000000'},descriptor:{...f.descriptor},packet:built.packet,lookups,...patch});
 await assert.rejects(read({}),/not a funding-first record/,'a version-0 record cannot launch through tag 42');
 f.data[OFF_ACCOUNTING_VERSION]=ACCOUNTING_VERSION_FUNDING_FIRST;
 const cost=await read({});
 assert.equal(cost.costModel,FUNDING_FIRST_LAUNCH_MODEL);assert.equal(cost.costIntent.maximumRentLamports,'28868560','eight rents at the network rate plus the Metaplex creation fee');assert.deepEqual(cost.costIntent.display,display);assert.equal(cost.costIntent.feeNft,String(f.nft));
 assert.deepEqual(cost.costIntent.rentLamportsByBytes,{82:'1461600',165:'2039280',256:'2672640',607:'5115600'});assert.equal(cost.costIntent.computeUnits,f.descriptor.computeUnits);
 await assert.rejects(read({packet:packetFor({...display,uri:'ipfs://other'},[table]).packet,lookups:pinCompiledLookups(packetFor({...display,uri:'ipfs://other'},[table]).message,{lookups:[{table:String(table.key),addresses:table.state.addresses.map(String)}]})}),/sealed URI/);
 await assert.rejects(read({packet:packetFor({...display,name:'Other'},[table]).packet,lookups:pinCompiledLookups(packetFor({...display,name:'Other'},[table]).message,{lookups:[{table:String(table.key),addresses:table.state.addresses.map(String)}]})}),/opening commitment/);
 ext[104]^=1;await assert.rejects(read({}),/opening commitment/,'the extension names another fee NFT');ext[104]^=1;
 f.accounts.delete(extKey);await assert.rejects(read({}),/extension unavailable/);f.accounts.set(extKey,{data:ext,owner:f.program,executable:false});
 await assert.rejects(read({lookups:null}),/Unqualified/,'a lookup packet without its pin');
 const two=new TransactionMessage({payerKey:f.payer,recentBlockhash:String(key()),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:f.descriptor.computeUnits}),instruction,c.assertReadyInstruction(f.program,f.campaign)]}).compileToV0Message([table]);
 await assert.rejects(read({packet:Buffer.from(new VersionedTransaction(two).serialize()).toString('base64'),lookups:pinCompiledLookups(two,{lookups:[{table:String(table.key),addresses:table.state.addresses.map(String)}]})}),/Mixed or foreign|not qualified/);
 assert.deepEqual(await read({}),cost,'the qualified template is stable');
});

test('the keeper\'s lookup-table setup classifies only as the exact launch template chunks on a funding-first record',async()=>{
 const f=fixture(),display={name:'Funding First',symbol:'FF',uri:f.terms.metadataUri};
 const ext=Buffer.alloc(EXT_LEN);Buffer.from('KIDSEXT2').copy(ext);f.campaign.toBuffer().copy(ext,8);f.terms.childMint.toBuffer().copy(ext,72);f.nft.toBuffer().copy(ext,104);Buffer.from(displayHash(display),'hex').copy(ext,136);ext[168]=ACCOUNTING_VERSION_FUNDING_FIRST;
 f.accounts.set(String(extAddress(f.program,f.campaign)),{data:ext,owner:f.program,executable:false});
 const expected=launchTableAddresses(f.program,f.campaign,f.terms,f.nft);assert.equal(expected.length,30);
 const recentSlot=1234,[create,table]=AddressLookupTableProgram.createLookupTable({authority:f.payer,payer:f.payer,recentSlot});
 const extend=(addresses,authority=f.payer,lookupTable=table)=>AddressLookupTableProgram.extendLookupTable({lookupTable,authority,payer:f.payer,addresses});
 const packetOf=ixs=>Buffer.from(new VersionedTransaction(new TransactionMessage({payerKey:f.payer,recentBlockhash:String(key()),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:f.descriptor.computeUnits}),...ixs]}).compileToV0Message()).serialize()).toString('base64');
 const read=ixs=>f.reader({binding:{...f.base},descriptor:{...f.descriptor},packet:packetOf(ixs)});
 await assert.rejects(read([create,extend(expected.slice(0,20))]),/funding-first records only/,'a version-0 record has no table setup');
 f.data[OFF_ACCOUNTING_VERSION]=ACCOUNTING_VERSION_FUNDING_FIRST;
 const first=await read([create,extend(expected.slice(0,20))]);
 assert.equal(first.costModel,LOOKUP_TABLE_MODEL);assert.equal(first.costIntent.table,String(table));assert.equal(first.costIntent.recentSlot,String(recentSlot));assert.equal(first.costIntent.startOffset,0);
 assert.deepEqual(first.costIntent.chunks,[expected.slice(0,20).map(String)]);assert.equal(first.costIntent.maximumRentLamports,String((56+640+128)*6960));
 await assert.rejects(read([create,extend(expected.slice(0,21))]),/next template chunk/,'21 addresses');
 await assert.rejects(read([create,extend(expected.slice(1,21))]),/next template chunk/,'not the first chunk');
 await assert.rejects(read([create,extend([...expected.slice(0,19),key()])]),/next template chunk/,'a stranger in the chunk');
 await assert.rejects(read([create,extend(expected.slice(0,20),key())]),/authority or payer is not the keeper|extension differs/,'another authority');
 await assert.rejects(read([extend(expected.slice(0,20))]),/not on the ledger/,'extending a table that does not exist');
 await assert.rejects(read([create]),/extends nothing/);
 f.accounts.set(String(table),{data:encodeLookupTableAccount({authority:f.payer,addresses:expected.slice(0,20),lastExtendedSlot:1}),owner:AddressLookupTableProgram.programId,executable:false});
 await assert.rejects(read([create,extend(expected.slice(0,20))]),/already exists/);
 const second=await read([extend(expected.slice(20))]);
 assert.equal(second.costIntent.recentSlot,null);assert.equal(second.costIntent.startOffset,20);assert.deepEqual(second.costIntent.chunks,[expected.slice(20).map(String)]);
 assert.equal(second.costIntent.maximumRentLamports,String((56+32*30+128)*6960-(56+640+128)*6960));
 await assert.rejects(read([extend(expected.slice(20)),extend(expected.slice(20))]),/next template chunk/,'a chunk twice');
 await assert.rejects(read([extend(expected.slice(19))]),/next template chunk/,'overlapping chunk');
 f.accounts.set(String(table),{data:encodeLookupTableAccount({authority:key(),addresses:expected.slice(0,20)}),owner:AddressLookupTableProgram.programId,executable:false});
 await assert.rejects(read([extend(expected.slice(20))]),/keeper's active table/,'a table of another authority');
 f.accounts.set(String(table),{data:encodeLookupTableAccount({authority:f.payer,addresses:[...expected.slice(0,19),key()]}),owner:AddressLookupTableProgram.programId,executable:false});
 await assert.rejects(read([extend(expected.slice(20))]),/differ from the launch template/,'a table whose prefix is not the template');
 f.accounts.set(String(table),{data:encodeLookupTableAccount({authority:f.payer,addresses:expected}),owner:AddressLookupTableProgram.programId,executable:false});
 await assert.rejects(read([extend(expected.slice(20))]),/differ from the launch template/,'a complete table has nothing to extend');
});
// Funding-first bookkeeping (tags 44-47) on a version-2 record: exact templates, network fee only; every substitution refused.
import {refundV2Instruction,closeV2Instruction,accountV2Instruction,returnCollateralV2Instruction,REFUND_V2_TAG} from '../protocol-v3/client.mjs';
import {TransactionInstruction} from '@solana/web3.js';
test('funding-first bookkeeping templates (44-47) classify as network fee only on a version-2 record and refuse every substitution',async()=>{
 const f=fixture();f.data[OFF_ACCOUNTING_VERSION]=ACCOUNTING_VERSION_FUNDING_FIRST;
 const r=f.receipt(),r2=f.receipt(),creator=new PublicKey(f.terms.creator);
 for(const ixs of [[refundV2Instruction(f.program,f.campaign,r.owner),refundV2Instruction(f.program,f.campaign,r2.owner)],[accountV2Instruction(f.program,f.campaign,r.owner),accountV2Instruction(f.program,f.campaign,r2.owner)],[closeV2Instruction(f.program,f.campaign)],[returnCollateralV2Instruction(f.program,f.campaign,creator)]]){
  const cost=await f.reader(f.make(ixs));assert.deepEqual(cost,{costModel:'network-fee-only'});
  // Fee-only reconciliation: the payer (never the treasury) spent exactly the fee; anything else does not reconcile.
  const model=operatingCostModel({...cost,block:{blockhash:String(key())}},{tx:VersionedTransaction.deserialize(Buffer.from(f.make(ixs).packet,'base64')),bytes:Buffer.alloc(1)},{...f.base,treasury:String(f.treasury)});
  assert.equal(reconcileOperatingCost(model,{pre:[100000n,5n],post:[95000n,5n],fee:5000n,failed:false}),5000n);
  assert.throws(()=>reconcileOperatingCost(model,{pre:[100000n,5n],post:[94000n,5n],fee:5000n,failed:false}),/reconcile/);
 }
 // Accounting-version mismatch: the bookkeeping tags never run on a per-receipt record, the old money tags never on a version-2 record.
 f.data[OFF_ACCOUNTING_VERSION]=0;await assert.rejects(f.reader(f.make([refundV2Instruction(f.program,f.campaign,r.owner)])),/accounting version/);
 await assert.rejects(f.reader(f.make([closeV2Instruction(f.program,f.campaign)])),/accounting version/);
 f.data[OFF_ACCOUNTING_VERSION]=ACCOUNTING_VERSION_FUNDING_FIRST;await assert.rejects(f.reader(f.make([c.refundInstruction(f.program,f.campaign,r.owner)])),/accounting version/);
 await assert.rejects(f.reader(f.make([c.settleInstruction(f.program,f.campaign,r.owner)])),/accounting version/);
 // Substituted destination, extension or creator: the exact template differs.
 const swapKey=(ix,i,pubkey)=>{const keys=ix.keys.map((k,j)=>j===i?{...k,pubkey}:k);return new TransactionInstruction({programId:ix.programId,keys,data:ix.data});};
 await assert.rejects(f.reader(f.make([swapKey(refundV2Instruction(f.program,f.campaign,r.owner),2,key())])),/template/,'refund to another destination');
 await assert.rejects(f.reader(f.make([swapKey(refundV2Instruction(f.program,f.campaign,r.owner),3,key())])),/template/,'another extension');
 await assert.rejects(f.reader(f.make([swapKey(accountV2Instruction(f.program,f.campaign,r.owner),2,key())])),/template/,'accounting with another extension');
 await assert.rejects(f.reader(f.make([returnCollateralV2Instruction(f.program,f.campaign,key())])),/template/,'collateral to someone other than the sealed creator');
 await assert.rejects(f.reader(f.make([swapKey(closeV2Instruction(f.program,f.campaign),1,key())])),/template/,'close with another extension');
 // Duplicate and foreign receipts, a refund to the operating payer, mixed tags, a body, more than one close or collateral.
 await assert.rejects(f.reader(f.make([refundV2Instruction(f.program,f.campaign,r.owner),refundV2Instruction(f.program,f.campaign,r.owner)])),/Duplicate/);
 const foreign=c.receiptAddress(f.program,f.campaign,key());f.accounts.set(String(foreign),{data:(()=>{const d=Buffer.alloc(c.RECEIPT_LEN);c.RECEIPT_MAGIC.copy(d);key().toBuffer().copy(d,8);key().toBuffer().copy(d,40);return d;})(),owner:f.program});
 await assert.rejects(f.reader(f.make([swapKey(refundV2Instruction(f.program,f.campaign,r.owner),1,foreign)])),/Foreign|template/);
 const alias=f.receipt(f.payer);await assert.rejects(f.reader(f.make([refundV2Instruction(f.program,f.campaign,alias.owner)])),/recipient/);
 assert.deepEqual(await f.reader(f.make([accountV2Instruction(f.program,f.campaign,alias.owner)])),{costModel:'network-fee-only'},'accounting the payer\'s own receipt moves nothing');
 await assert.rejects(f.reader(f.make([refundV2Instruction(f.program,f.campaign,r.owner),accountV2Instruction(f.program,f.campaign,r2.owner)])),/Mixed/);
 const withBody=refundV2Instruction(f.program,f.campaign,r.owner);await assert.rejects(f.reader(f.make([new TransactionInstruction({programId:withBody.programId,keys:withBody.keys,data:Buffer.from([REFUND_V2_TAG,1])})])),/no body/);
 await assert.rejects(f.reader(f.make([closeV2Instruction(f.program,f.campaign),closeV2Instruction(f.program,f.campaign)])),/Mixed|qualified/);
 await assert.rejects(f.reader(f.make([returnCollateralV2Instruction(f.program,f.campaign,creator),returnCollateralV2Instruction(f.program,f.campaign,creator)])),/Mixed|qualified/);
 // The sealed creator as the operating payer: no collateral template (it would pay the keeper).
 const g=fixture();g.data[OFF_ACCOUNTING_VERSION]=ACCOUNTING_VERSION_FUNDING_FIRST;
 const sealedCreator=String(g.terms.creator),own=createStandardOperatingCostReader({connection:g.connection,...g.base,payer:sealedCreator,feeOperator:g.operator,treasury:String(g.treasury)});
 const ownPacket=Buffer.from(new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(sealedCreator),recentBlockhash:String(key()),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:g.descriptor.computeUnits}),returnCollateralV2Instruction(g.program,g.campaign,new PublicKey(sealedCreator))]}).compileToV0Message()).serialize()).toString('base64');
 await assert.rejects(own({binding:{...g.base,payer:sealedCreator},descriptor:{...g.descriptor,payer:sealedCreator},packet:ownPacket}),/qualified/);
});
