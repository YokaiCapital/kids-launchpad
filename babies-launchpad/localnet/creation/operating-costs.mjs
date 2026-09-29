// Exact cost models for trusted durable packets. Never select a model from an
// HTTP receipt, and never treat an unexplained net payer debit as verified rent.
import {launchFundingFirstInstruction,LAUNCH_V2_ACCOUNTS,LOOKUP_TABLE_CHUNK} from '../protocol-v3/client.mjs';
import {AddressLookupTableProgram} from '@solana/web3.js';
import {PublicKey,TransactionMessage,ComputeBudgetProgram,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {canonicalHash} from '../registry/canonical.mjs';
import {createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {feesInitInstruction,feeStateAddress,launchInstruction,feeAuthority,associatedTokenAddress,WSOL} from '../protocol-v2/client.mjs';
export function feeSetupInstructions({programId,campaign,payer,operator,terms}){
 const authority=feeAuthority(programId,campaign),seen=new Set(),instructions=[];
 for(const [owner,mint] of [[authority,terms.childMint],[authority,WSOL],[terms.treasury,WSOL],[terms.dev,WSOL]]){
  const address=associatedTokenAddress(owner,mint);if(seen.has(String(address)))continue;seen.add(String(address));
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(new PublicKey(payer),address,new PublicKey(owner),new PublicKey(mint)));
 }
 return [...instructions,feesInitInstruction(programId,campaign,payer,operator)];
}
export const MEMO_PROGRAM=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** Memo that binds a return of unused operating reserve to one campaign, payer, creator and amount. */
export const operatingReturnMemo=({genesisHash,programId,campaign,payer,creator,lamports})=>'KIDS operating return:'+canonicalHash({genesisHash,programId,campaign,payer,creator,lamports:String(lamports)});
/** The exact instruction pair of a reserve return: transfer from the payer to the sealed creator, then the binding memo. */
export function operatingReturnInstructions(x,{creator,lamports}){
 return [SystemProgram.transfer({fromPubkey:new PublicKey(x.payer),toPubkey:new PublicKey(creator),lamports:BigInt(lamports)}),
  new TransactionInstruction({programId:MEMO_PROGRAM,keys:[],data:Buffer.from(operatingReturnMemo({genesisHash:x.genesisHash,programId:x.programId,campaign:x.campaign,payer:x.payer,creator,lamports}))})];
}
function rentCeiling(row,x){
 const ceiling=row.costIntent?.maximumRentLamports;
 if(typeof ceiling!=='string'||!/^[1-9][0-9]{0,15}$/.test(ceiling)||BigInt(ceiling)>BigInt(x.maximumLamports))throw Error('Invalid operating rent ceiling');
 return BigInt(ceiling);
}
/** Every account key the runtime loads for the packet, in runtime order (static, then lookup writable, then lookup readonly). */
export function packetAccountKeys(packet){
 const keys=packet.tx.message.getAccountKeys({addressLookupTableAccounts:packet.tables??[]});
 return [...keys.staticAccountKeys,...(keys.accountKeysFromLookups?.writable??[]),...(keys.accountKeysFromLookups?.readonly??[])];
}
// Funding-first launch (tag 42): the accounts the keeper creates or completes, by instruction index and size (the tag-6
// lock leg: fee NFT mint, its account, the locked position, the lock vault; the mint leg: child mint, custody, WSOL
// custody, child metadata), and the accounts the pool leg moves campaign-side funds through (as tag 6).
// The child metadata account (Metaplex CreateMetadataAccountV3): 607 bytes, and the program's creation fee (0.01 SOL) is
// charged to the payer into that account on top of its rent (measured on the ledger: 5,115,600 + 10,000,000 lamports).
export const METAPLEX_CREATE_FEE_LAMPORTS=10_000_000n,METADATA_ACCOUNT_BYTES=607;
const FUNDING_FIRST_RENT=Object.freeze([[3,82],[4,165],[5,165],[6,82],[7,165],[8,256],[9,165],[30,METADATA_ACCOUNT_BYTES]]),FUNDING_FIRST_POOL=Object.freeze([0,2,4,5,18,19,20,21,22,23,24]),FUNDING_FIRST_SIZES=Object.freeze([82,165,256,METADATA_ACCOUNT_BYTES]);
export const FUNDING_FIRST_LAUNCH_MODEL='v3-funding-first-launch',LOOKUP_TABLE_MODEL='v3-lookup-table-rent';
/** The keeper's lookup table for a funding-first launch: one packet creates the table and appends the first chunk, later
 * packets append the next chunks (costIntent: table, recentSlot for a creation, startOffset, chunks). Only the table gains. */
function lookupTableModel(row,packet,x){
 const maximumRentLamports=rentCeiling(row,x),{table,recentSlot,startOffset,chunks,computeUnits}=row.costIntent;
 if(!Number.isInteger(computeUnits)||computeUnits<1||computeUnits>1400000)throw Error('Invalid lookup table compute limit');
 if(!Array.isArray(chunks)||!chunks.length||chunks.some(c=>!Array.isArray(c)||!c.length||c.length>LOOKUP_TABLE_CHUNK))throw Error('Invalid lookup table chunks');
 const payer=new PublicKey(x.payer),tableKey=new PublicKey(table),instructions=[];
 if(recentSlot!==null&&recentSlot!==undefined){
  if(typeof recentSlot!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(recentSlot)||startOffset!==0)throw Error('Invalid lookup table creation');
  const [create,address]=AddressLookupTableProgram.createLookupTable({authority:payer,payer,recentSlot:Number(recentSlot)});
  if(!address.equals(tableKey))throw Error('Lookup table address differs from its creation slot');instructions.push(create);
 }else if(!Number.isInteger(startOffset)||startOffset<1)throw Error('Invalid lookup table extension');
 for(const chunk of chunks)instructions.push(AddressLookupTableProgram.extendLookupTable({lookupTable:tableKey,authority:payer,payer,addresses:chunk.map(a=>new PublicKey(a))}));
 const expected=new TransactionMessage({payerKey:payer,recentBlockhash:row.block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:computeUnits}),...instructions]}).compileToV0Message(packet.tables??[]);
 if(!Buffer.from(expected.serialize()).equals(Buffer.from(packet.bytes)))throw Error('Lookup table packet differs from its reviewed template');
 const index=packetAccountKeys(packet).findIndex(k=>k.equals(tableKey));if(index<1)throw Error('Lookup table destination unavailable');
 return {kind:row.costModel,index,maximumRentLamports};
}
function fundingFirstLaunchModel(row,packet,x){
 const maximumRentLamports=rentCeiling(row,x),{terms,feeNft,computeUnits,display,rentLamportsByBytes}=row.costIntent;
 if(!Number.isInteger(computeUnits)||computeUnits<1||computeUnits>1400000)throw Error('Invalid launch compute limit');
 const rent=Object.fromEntries(FUNDING_FIRST_SIZES.map(n=>{const v=rentLamportsByBytes?.[n];if(typeof v!=='string'||!/^[1-9][0-9]{0,15}$/.test(v))throw Error('Invalid funding-first rent evidence');return [n,BigInt(v)];}));
 const {instruction}=launchFundingFirstInstruction(x.programId,x.campaign,terms,x.payer,feeNft,display);
 if(new Set(instruction.keys.map(k=>String(k.pubkey))).size!==LAUNCH_V2_ACCOUNTS)throw Error('Aliased launch cost accounts');
 const expected=new TransactionMessage({payerKey:new PublicKey(x.payer),recentBlockhash:row.block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:computeUnits}),instruction]}).compileToV0Message(packet.tables??[]);
 if(!Buffer.from(expected.serialize()).equals(Buffer.from(packet.bytes)))throw Error('Funding-first launch packet differs from its reviewed cost template');
 const keys=packetAccountKeys(packet),index=i=>keys.findIndex(k=>k.equals(instruction.keys[i].pubkey));
 // Seven accounts are created by this program or the token programs: their rent is topped up from whatever the address already
 // held. The child metadata is created by the Metaplex program, which adds the full rent AND its creation fee to the account
 // whatever it held before (measured on the ledger: a prior balance of 0, 1,000,000 or 6,000,000 all end 15,115,600 higher), so
 // that account is additive. lamports = rent + fee is the account's maximum charge either way.
 const rentAccounts=FUNDING_FIRST_RENT.map(([i,bytes])=>{const fee=i===30?METAPLEX_CREATE_FEE_LAMPORTS:0n;return {index:index(i),bytes,rent:rent[bytes],fee,additive:i===30,lamports:rent[bytes]+fee};}),poolIndices=FUNDING_FIRST_POOL.map(index);
 if([...rentAccounts.map(r=>r.index),...poolIndices].some(i=>i<1))throw Error('Launch cost destination unavailable');
 if(rentAccounts.reduce((s,r)=>s+r.lamports,0n)>maximumRentLamports)throw Error('Funding-first rent exceeds the reviewed ceiling');
 return {kind:row.costModel,rentAccounts,rentIndices:rentAccounts.map(r=>r.index),poolIndices,maximumRentLamports,keyCount:keys.length};
}
function launchLockModel(row,packet,x){
 const maximumRentLamports=rentCeiling(row,x),{terms,feeNft,computeUnits}=row.costIntent;
 if(!Number.isInteger(computeUnits)||computeUnits<1||computeUnits>1400000)throw Error('Invalid launch compute limit');
 const {instruction}=launchInstruction(x.programId,x.campaign,terms,x.payer,feeNft);
 // The shared launch path uses with_metadata=false. Only the four lock
 // destinations below are funded by the keeper. Pool creation and accepted
 // participant SOL move separately through the campaign/authority accounts.
 if(new Set(instruction.keys.map(k=>String(k.pubkey))).size!==29)throw Error('Aliased launch cost accounts');
 const expected=new TransactionMessage({payerKey:new PublicKey(x.payer),recentBlockhash:row.block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:computeUnits}),instruction]}).compileToV0Message();
 if(!Buffer.from(expected.serialize()).equals(Buffer.from(packet.bytes)))throw Error('Launch packet differs from its reviewed cost template');
 const index=i=>packet.tx.message.staticAccountKeys.findIndex(k=>k.equals(instruction.keys[i].pubkey));
 const rentIndices=[6,7,8,9].map(index),poolIndices=[0,2,4,5,18,19,20,21,22,23,24].map(index);
 if([...rentIndices,...poolIndices].some(i=>i<1))throw Error('Launch cost destination unavailable');
 return {kind:row.costModel,rentIndices,poolIndices,maximumRentLamports};
}
export function operatingCostModel(row,packet,x){
 if(row.costModel==='network-fee-only')return {kind:'network-fee-only'};
 if(row.costIntent?.programVersion!==3)throw Error('Unqualified operating cost model');
 if(row.costModel==='v3-operating-return'){
  // Return of unused operating reserve: the whole amount leaves the payer, the fee is the only cost, the creator is the
  // only other account that moves. The amount stays below the held maximum (which includes the network fee).
  const {creator,lamports,computeUnits}=row.costIntent;
  if(!Number.isInteger(computeUnits)||computeUnits<1||computeUnits>1400000||typeof lamports!=='string'||!/^[1-9][0-9]{0,15}$/.test(lamports)||BigInt(lamports)>=BigInt(x.maximumLamports))throw Error('Invalid operating return intent');
  const to=new PublicKey(creator);if(to.toBase58()!==creator||creator===x.payer)throw Error('Invalid operating return recipient');
  const expected=new TransactionMessage({payerKey:new PublicKey(x.payer),recentBlockhash:row.block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:computeUnits}),...operatingReturnInstructions(x,{creator,lamports})]}).compileToV0Message();
  if(!Buffer.from(expected.serialize()).equals(Buffer.from(packet.bytes)))throw Error('Operating return differs from its reviewed template');
  const index=packet.tx.message.staticAccountKeys.findIndex(k=>k.equals(to));if(index<1)throw Error('Operating return destination unavailable');
  return {kind:row.costModel,index,returnLamports:BigInt(lamports)};
 }
 if(row.costModel==='v3-fee-setup-rent'){
  const maximumRentLamports=rentCeiling(row,x),{operator,terms,computeUnits}=row.costIntent;
  // The binding names the pinned platform treasury explicitly; it is never the payer by default.
  if(typeof x.treasury!=='string')throw Error('Fee setup cost binding needs the pinned treasury');
  if(!Number.isInteger(computeUnits)||computeUnits<1||computeUnits>1400000||String(terms.treasury)!==x.treasury)throw Error('Invalid fee setup policy');
  const instructions=feeSetupInstructions({...x,operator,terms});
  const expected=new TransactionMessage({payerKey:new PublicKey(x.payer),recentBlockhash:row.block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:computeUnits}),...instructions]}).compileToV0Message();
  if(!Buffer.from(expected.serialize()).equals(Buffer.from(packet.bytes)))throw Error('Fee setup differs from its reviewed cost template');
  const addresses=[...instructions.slice(0,-1).map(ix=>ix.keys[1].pubkey),feeStateAddress(x.programId,x.campaign)];
  const rentIndices=addresses.map(a=>packet.tx.message.staticAccountKeys.findIndex(k=>k.equals(a)));
  if(rentIndices.some(i=>i<1)||new Set(rentIndices).size!==rentIndices.length)throw Error('Aliased fee setup costs');
  return {kind:row.costModel,rentIndices,poolIndices:[],maximumRentLamports};
 }
 if(row.costModel==='v3-launch-lock-rent')return launchLockModel(row,packet,x);
 if(row.costModel===FUNDING_FIRST_LAUNCH_MODEL)return fundingFirstLaunchModel(row,packet,x);
 if(row.costModel===LOOKUP_TABLE_MODEL)return lookupTableModel(row,packet,x);
 if(row.costModel!=='v3-fee-state-rent')throw Error('Unqualified operating cost model');
 const operator=new PublicKey(row.costIntent.operator);
 const maximumRentLamports=rentCeiling(row,x);
 const instructions=[feesInitInstruction(x.programId,x.campaign,x.payer,operator)];
 if(row.costIntent.computeUnits!==undefined){
  const units=row.costIntent.computeUnits;if(!Number.isInteger(units)||units<1||units>1400000)throw Error('Invalid fee-state compute limit');
  instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units}));
 }
 const expected=new TransactionMessage({payerKey:new PublicKey(x.payer),recentBlockhash:row.block.blockhash,instructions}).compileToV0Message();
 if(!Buffer.from(expected.serialize()).equals(Buffer.from(packet.bytes)))throw Error('Fee-state packet differs from its reviewed cost template');
 const address=feeStateAddress(x.programId,x.campaign).toBase58(),index=packet.tx.message.staticAccountKeys.findIndex(k=>k.toBase58()===address);
 if(index<1)throw Error('Fee-state rent destination unavailable');
 return {kind:row.costModel,index,maximumRentLamports};
}
export function reconcileOperatingCost(model,{pre,post,fee,failed}){
 const spent=BigInt(pre[0])-BigInt(post[0]);
 if(model.kind==='network-fee-only'){
  if(spent!==fee)throw Error('Operating cost does not reconcile within its reserve');
  return spent;
 }
 if(model.kind==='v3-launch-lock-rent'||model.kind==='v3-fee-setup-rent'){
  let rent=0n;
  for(const index of model.rentIndices){
   const delta=BigInt(post[index])-BigInt(pre[index]);
   if(delta<0n||(failed&&delta!==0n))throw Error('Lock rent does not reconcile');
   rent+=delta;
  }
  if(rent>model.maximumRentLamports||spent!==fee+rent)throw Error('Lock rent does not reconcile');
  const allowed=new Set(failed?[]:[...model.rentIndices,...model.poolIndices]);
  for(let i=1;i<pre.length;i++)if(!allowed.has(i)&&pre[i]!==post[i])throw Error('Unexplained launch asset movement');
  return spent;
 }
 if(model.kind===FUNDING_FIRST_LAUNCH_MODEL){
  // Keeper-paid rent = the rent-exempt minimum of every account the launch creates, less what that address already held
  // (a pre-funded address is completed, an existing associated account costs nothing). Pool-side lamports landing on the
  // custody accounts belong to the campaign, never to this charge. Balances cover the complete loaded key list.
  if(pre.length!==model.keyCount||post.length!==pre.length)throw Error('Funding-first launch balance evidence incomplete');
  let rent=0n;
  for(const {index,rent:minimum,fee,additive} of model.rentAccounts){
   const before=BigInt(pre[index]),after=BigInt(post[index]);
   if(after<before||(failed&&after!==before))throw Error('Funding-first rent does not reconcile');
   if(failed)continue;
   // Additive (Metaplex metadata): exactly rent + fee is added whatever was there. Top-up (the others): only the shortfall.
   const charge=additive?minimum+fee:(before<minimum?minimum-before:0n);
   if(additive?after-before!==charge:after<minimum)throw Error('Funding-first launch left an account below rent exemption');
   rent+=charge;
  }
  if(rent>model.maximumRentLamports||spent!==fee+rent)throw Error('Funding-first rent does not reconcile');
  const allowed=new Set(failed?[]:[...model.rentIndices,...model.poolIndices]);
  for(let i=1;i<pre.length;i++)if(!allowed.has(i)&&pre[i]!==post[i])throw Error('Unexplained funding-first launch asset movement');
  return spent;
 }
 if(model.kind==='v3-operating-return'){
  const returned=BigInt(post[model.index])-BigInt(pre[model.index]);
  if(failed?returned!==0n||spent!==fee:returned!==model.returnLamports||spent!==fee+returned)throw Error('Operating return does not reconcile');
  for(let i=1;i<pre.length;i++)if(i!==model.index&&pre[i]!==post[i])throw Error('Unexplained operating return asset movement');
  return spent;
 }
 const rent=BigInt(post[model.index])-BigInt(pre[model.index]);
 if(rent<0n||rent>model.maximumRentLamports||(failed&&rent!==0n)||spent!==fee+rent)throw Error('Fee-state rent does not reconcile');
 for(let i=1;i<pre.length;i++)if(i!==model.index&&pre[i]!==post[i])throw Error('Unexplained fee-state asset movement');
 return spent;
}
