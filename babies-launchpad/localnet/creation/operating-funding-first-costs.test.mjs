import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,AddressLookupTableAccount} from '@solana/web3.js';
import {launchFundingFirstInstruction,LAUNCH_V2_ACCOUNTS} from '../protocol-v3/client.mjs';
import {RAYDIUM_CPMM,RAYDIUM_LOCK,AMM_CONFIG_TIERS} from '../protocol-v2/client.mjs';
import {operatingCostModel,reconcileOperatingCost,packetAccountKeys,FUNDING_FIRST_LAUNCH_MODEL,LOOKUP_TABLE_MODEL} from './operating-costs.mjs';
import {launchTableAddresses} from '../protocol-v3/client.mjs';
import {AddressLookupTableProgram} from '@solana/web3.js';
import {pinCompiledLookups} from '../signer/lookup-resolution.mjs';
const key=()=>Keypair.generate().publicKey,U64_MAX=2n**64n-1n;
const RENTS={82:'1461600',165:'2039280',256:'2672640',607:'5115600'},CEILING='28868560';
function fixture(){
 const x={payer:String(key()),programId:String(key()),campaign:String(key()),maximumLamports:'40000000'};
 const display={name:'Funding First',symbol:'FF',uri:'ipfs://'+'b'.repeat(46)};
 const row={costModel:FUNDING_FIRST_LAUNCH_MODEL,costIntent:{programVersion:3,maximumRentLamports:CEILING,computeUnits:400000,feeNft:String(key()),display,terms:{childMint:String(key()),ammProgram:String(RAYDIUM_CPMM),ammConfig:String(AMM_CONFIG_TIERS[0].address),lockProgram:String(RAYDIUM_LOCK)},rentLamportsByBytes:{...RENTS}},block:{blockhash:String(key())}};
 const {instruction}=launchFundingFirstInstruction(x.programId,x.campaign,row.costIntent.terms,x.payer,row.costIntent.feeNft,display);
 assert.equal(instruction.keys.length,LAUNCH_V2_ACCOUNTS);
 const table=new AddressLookupTableAccount({key:key(),state:{deactivationSlot:U64_MAX,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[...new Set(instruction.keys.filter(k=>!k.isSigner).map(k=>String(k.pubkey)))].map(k=>new PublicKey(k))}});
 const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:row.costIntent.computeUnits}),instruction];
 const compile=tables=>new TransactionMessage({payerKey:instruction.keys[1].pubkey,recentBlockhash:row.block.blockhash,instructions}).compileToV0Message(tables);
 const message=compile([table]),tx=new VersionedTransaction(message),packet={tx,bytes:tx.message.serialize(),tables:[table]};
 assert.ok(tx.serialize().length<=1232,'the 33-account launch fits through the table');assert.equal(message.addressTableLookups.length,1);
 const lookups=pinCompiledLookups(message,{lookups:[{table:String(table.key),addresses:table.state.addresses.map(String)}]});
 const model=operatingCostModel(row,packet,x),keys=packetAccountKeys(packet),idx=i=>keys.findIndex(k=>k.equals(instruction.keys[i].pubkey));
 const pre=keys.map(()=>0),post=pre.slice();pre[0]=30000000;
 for(const r of model.rentAccounts)post[r.index]=Number(r.lamports);
 const rent=model.rentAccounts.reduce((s,r)=>s+r.lamports,0n);post[0]=pre[0]-10000-Number(rent);
 // Campaign-side movement the keeper never pays: accepted SOL leaves the campaign for the vault, the authority's setup
 // budget pays the pool, leftover wrapped SOL stays on the WSOL custody the keeper just created.
 pre[idx(0)]=50000000000;post[idx(0)]=10000000;pre[idx(2)]=100000000;post[idx(2)]=1000000;post[idx(21)]=49000000000;post[idx(5)]+=990000000;
 return {x,row,packet,model,pre,post,fee:10000n,instruction,keys,idx,rent,table,lookups,compile};
}
test('funding-first launch model: eight keeper rents over the complete loaded key list, pool movement free',()=>{
 const f=fixture();
 assert.equal(f.model.kind,FUNDING_FIRST_LAUNCH_MODEL);assert.equal(f.model.keyCount,f.keys.length);assert.ok(f.keys.length>f.packet.tx.message.staticAccountKeys.length,'rent destinations live behind the lookup table');
 assert.deepEqual(f.model.rentAccounts.map(r=>r.bytes),[82,165,165,82,165,256,165,607]);assert.equal(f.model.rentAccounts[7].lamports,5115600n+10000000n,'child metadata: rent plus the Metaplex creation fee');assert.equal(new Set(f.model.rentIndices).size,8);assert.ok(f.model.rentIndices.every(i=>i>=1));
 assert.deepEqual(f.model.rentAccounts.map(r=>f.keys[r.index]),[3,4,5,6,7,8,9,30].map(i=>f.instruction.keys[i].pubkey));
 assert.equal(f.rent,BigInt(CEILING));assert.equal(f.model.maximumRentLamports,BigInt(CEILING));
 assert.equal(reconcileOperatingCost(f.model,f),10000n+f.rent);
});
test('pre-funded or existing accounts reduce the charge; the charge never includes campaign-side lamports',()=>{
 const f=fixture();const mint=f.model.rentAccounts[0],custody=f.model.rentAccounts[1];
 f.pre[mint.index]=890880;f.post[0]+=890880;assert.equal(reconcileOperatingCost(f.model,f),10000n+f.rent-890880n,'a pre-funded mint is only topped up');
 f.pre[custody.index]=Number(custody.lamports);f.post[0]+=Number(custody.lamports);assert.equal(reconcileOperatingCost(f.model,f),10000n+f.rent-890880n-custody.lamports,'an existing custody account costs nothing');
 f.post[f.idx(5)]+=1000000;assert.equal(reconcileOperatingCost(f.model,f),10000n+f.rent-890880n-custody.lamports,'more wrapped SOL on the custody is not a keeper charge');
});
test('the Metaplex metadata levy is additive: rent plus the creation fee whatever the address held (measured: 0, 1,000,000 and 6,000,000 all end 15,115,600 higher)',()=>{
 const f=fixture(),meta=f.model.rentAccounts[7];assert.equal(meta.fee,10000000n);assert.equal(meta.rent,5115600n);assert.equal(meta.additive,true);assert.ok(f.model.rentAccounts.slice(0,7).every(r=>!r.additive));
 // prior 6,000,000 -> ends 21,115,600: the launch delta is 15,115,600, the keeper pays it in full.
 f.pre[meta.index]=6000000;f.post[meta.index]=21115600;assert.equal(reconcileOperatingCost(f.model,f),10000n+f.rent,'pre-funded above rent: still rent + fee');
 // prior 1,000,000 -> ends 16,115,600.
 const g=fixture(),m=g.model.rentAccounts[7];g.pre[m.index]=1000000;g.post[m.index]=16115600;assert.equal(reconcileOperatingCost(g.model,g),10000n+g.rent,'pre-funded below rent: still rent + fee');
 // A delta other than rent + fee never reconciles: the fee alone, a top-up alone, or a top-up plus the fee.
 for(const [before,after,extra] of [[6000000,16000000,-Number(m.rent)],[1000000,Number(m.rent)+10000000,-1000000],[6000000,11000000,-Number(m.rent)-5000000]]){const h=fixture(),n=h.model.rentAccounts[7];h.pre[n.index]=before;h.post[n.index]=after;h.post[0]-=extra;assert.throws(()=>reconcileOperatingCost(h.model,h),/below rent exemption/);}
});
test('a failed launch charges the fee only; any other movement is refused',()=>{
 const f=fixture();f.post=f.pre.slice();f.post[0]-=10000;assert.equal(reconcileOperatingCost(f.model,{...f,failed:true}),10000n);
 for(const i of [f.model.rentIndices[0],f.model.poolIndices[1]]){const g=fixture();g.post=g.pre.slice();g.post[0]-=10000;g.post[i]++;assert.throws(()=>reconcileOperatingCost(g.model,{...g,failed:true}));}
});
test('the reconciliation refuses unexplained movement, rent refunds, an account left below rent, over-ceiling and short evidence',()=>{
 const cases=[f=>f.post[0]++,f=>{f.post[f.model.rentIndices[0]]=f.pre[f.model.rentIndices[0]]-1;},f=>{f.post[f.model.rentAccounts[7].index]=Number(f.model.rentAccounts[7].lamports)-1;},f=>{f.post[f.idx(10)]++;},f=>{f.post[f.idx(29)]++;},f=>{f.post[f.idx(31)]++;},f=>{f.pre=f.pre.slice(0,-1);f.post=f.post.slice(0,-1);},f=>{f.post[f.model.rentIndices[0]]+=1000000;f.post[0]-=1000000;f.model.maximumRentLamports=f.rent-1n;}];
 for(const mutate of cases){const f=fixture();mutate(f);assert.throws(()=>reconcileOperatingCost(f.model,f));}
});
test('the model binds the exact template: program, campaign, payer, mint, AMM, lock, NFT, display, compute, rents and the pinned tables',()=>{
 const changes=[f=>f.row.costIntent.programVersion=2,f=>f.x.campaign=String(key()),f=>f.x.programId=String(key()),f=>f.x.payer=String(key()),f=>f.row.costIntent.feeNft=String(key()),f=>f.row.costIntent.computeUnits++,f=>f.row.costIntent.display={...f.row.costIntent.display,name:'Other'},f=>f.row.costIntent.display={...f.row.costIntent.display,uri:'ipfs://other'},f=>f.row.costIntent.maximumRentLamports='28868559',f=>f.row.costIntent.maximumRentLamports='40000001',f=>f.row.costIntent.rentLamportsByBytes={...RENTS,607:'x'},f=>delete f.row.costIntent.rentLamportsByBytes,...['childMint','ammProgram','ammConfig','lockProgram'].map(k=>f=>f.row.costIntent.terms[k]=String(key()))];
 for(const mutate of changes){const f=fixture();mutate(f);assert.throws(()=>operatingCostModel(f.row,f.packet,f.x));}
 const f=fixture();assert.throws(()=>operatingCostModel(f.row,{tx:f.packet.tx,bytes:f.packet.bytes},f.x),'a lookup packet without its tables cannot be modelled');
 const other=new AddressLookupTableAccount({key:key(),state:{...f.table.state}});assert.throws(()=>operatingCostModel(f.row,{...f.packet,tables:[other]},f.x),'another table compiles to other bytes');
 const withPrice=new VersionedTransaction(new TransactionMessage({payerKey:f.instruction.keys[1].pubkey,recentBlockhash:f.row.block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:f.row.costIntent.computeUnits}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1}),f.instruction]}).compileToV0Message([f.table]));
 assert.throws(()=>operatingCostModel(f.row,{tx:withPrice,bytes:withPrice.message.serialize(),tables:[f.table]},f.x));
 const g=fixture();g.row.costIntent.terms.childMint=g.x.payer;assert.throws(()=>operatingCostModel(g.row,g.packet,g.x),/Aliased/);
});

test('lookup-table packets: the table is the only account that gains, exactly the reviewed rent, creation bound to its slot',()=>{
 const x={payer:String(key()),programId:String(key()),campaign:String(key()),maximumLamports:'7000000'},payer=new PublicKey(x.payer);
 const terms={childMint:String(key()),ammProgram:String(RAYDIUM_CPMM),ammConfig:String(AMM_CONFIG_TIERS[0].address),lockProgram:String(RAYDIUM_LOCK)};
 const addresses=launchTableAddresses(x.programId,x.campaign,terms,key()),[create,table]=AddressLookupTableProgram.createLookupTable({authority:payer,payer,recentSlot:77});
 const extend=chunk=>AddressLookupTableProgram.extendLookupTable({lookupTable:table,authority:payer,payer,addresses:chunk});
 const build=(ixs,intent)=>{const row={costModel:LOOKUP_TABLE_MODEL,costIntent:{programVersion:3,computeUnits:100000,...intent},block:{blockhash:String(key())}};const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:row.block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:100000}),...ixs]}).compileToV0Message());return {row,packet:{tx,bytes:tx.message.serialize(),tables:[]}};};
 const first=build([create,extend(addresses.slice(0,20))],{table:String(table),recentSlot:'77',startOffset:0,chunks:[addresses.slice(0,20).map(String)],maximumRentLamports:String((56+640+128)*6960)});
 const model=operatingCostModel(first.row,first.packet,x);assert.equal(model.kind,LOOKUP_TABLE_MODEL);assert.ok(model.index>=1);assert.ok(first.packet.tx.message.staticAccountKeys[model.index].equals(table));
 const keys=first.packet.tx.message.staticAccountKeys,pre=keys.map(()=>0),post=pre.slice();pre[0]=20000000;post[model.index]=(56+640+128)*6960;post[0]=pre[0]-5000-post[model.index];
 assert.equal(reconcileOperatingCost(model,{pre,post,fee:5000n}),5000n+BigInt(post[model.index]));
 assert.throws(()=>reconcileOperatingCost(model,{pre,post:post.map((v,i)=>i===model.index?v+1:v),fee:5000n}),/does not reconcile/,'more than the reviewed rent');
 assert.throws(()=>reconcileOperatingCost(model,{pre,post:post.map((v,i)=>i===2&&i!==model.index?v+1:v),fee:5000n}),/Unexplained/,'another account moved');
 const second=build([extend(addresses.slice(20))],{table:String(table),recentSlot:null,startOffset:20,chunks:[addresses.slice(20).map(String)],maximumRentLamports:String(416*6960)});
 assert.equal(operatingCostModel(second.row,second.packet,x).kind,LOOKUP_TABLE_MODEL);
 for(const mutate of [r=>r.costIntent.recentSlot='78',r=>r.costIntent.table=String(key()),r=>r.costIntent.chunks=[addresses.slice(0,19).map(String)],r=>r.costIntent.startOffset=1,r=>r.costIntent.computeUnits++,r=>r.costIntent.maximumRentLamports='7000001',r=>r.costIntent.programVersion=2]){const f=build([create,extend(addresses.slice(0,20))],{table:String(table),recentSlot:'77',startOffset:0,chunks:[addresses.slice(0,20).map(String)],maximumRentLamports:String((56+640+128)*6960)});mutate(f.row);assert.throws(()=>operatingCostModel(f.row,f.packet,x));}
 const otherPayer=build([create,extend(addresses.slice(0,20))],{table:String(table),recentSlot:'77',startOffset:0,chunks:[addresses.slice(0,20).map(String)],maximumRentLamports:String((56+640+128)*6960)});
 assert.throws(()=>operatingCostModel(otherPayer.row,otherPayer.packet,{...x,payer:String(key())}));
});
