// Private v3 Standard signer composition. Classifications come from pinned chain
// accounts and exact instruction reconstruction, never worker-supplied labels.
// This does not authorize a signature: the capability/lease boundary still runs.
import {PublicKey,VersionedTransaction,TransactionMessage,ComputeBudgetProgram,SystemProgram,SYSVAR_CLOCK_PUBKEY,AddressLookupTableProgram,AddressLookupTableInstruction,AddressLookupTableAccount} from '@solana/web3.js';
import * as c from '../protocol-v2/client.mjs';
import {operatingCostModel,feeSetupInstructions,MEMO_PROGRAM} from '../creation/operating-costs.mjs';
import {campaignFailed} from '../protocol-v2/policy.mjs';
import {resolvePinnedLookups} from './lookup-resolution.mjs';
import {parseLaunchDisplayData,launchFundingFirstInstruction,launchTableAddresses,extAddress,decodeExt,displayHash,OFF_ACCOUNTING_VERSION,ACCOUNTING_VERSION_FUNDING_FIRST,LAUNCH_V2_TAG,LAUNCH_V2_ACCOUNTS,LOOKUP_TABLE_CHUNK,REFUND_V2_TAG,CLOSE_V2_TAG,ACCOUNT_V2_TAG,RETURN_COLLATERAL_V2_TAG,refundV2Instruction,closeV2Instruction,accountV2Instruction,returnCollateralV2Instruction} from '../protocol-v3/client.mjs';
import {FUNDING_FIRST_LAUNCH_MODEL,LOOKUP_TABLE_MODEL,METAPLEX_CREATE_FEE_LAMPORTS,METADATA_ACCOUNT_BYTES} from '../creation/operating-costs.mjs';
const U64_MAX=2n**64n-1n;
const key=x=>new PublicKey(x).toBase58();
export const OPERATING_COST_REFUSED='OPERATING_COST_REFUSED';
const dependent=error=>{try{if(error&&typeof error==='object'){if(error.code==='CAPACITY_WAIT'||error.code===OPERATING_COST_REFUSED)return error;if(!error.dependency)error.dependency='failure';return error;}}catch{}return Object.assign(Error('Operating cost dependency failed'),{dependency:'failure',cause:error});};
/** A reader whose RPC failures are tagged as dependencies and whose own refusals are typed OPERATING_COST_REFUSED. */
export function createStandardOperatingCostReader({connection:rawConnection,genesisHash,programId,payer,feeOperator,treasury=null}){
 const connection=new Proxy(rawConnection,{get(target,k){const value=target[k];return typeof value==='function'?async(...args)=>{try{return await value.apply(target,args);}catch(error){throw dependent(error);}}:value;}});
 const classify=classifyOperatingCost({connection,genesisHash,programId,payer,feeOperator,treasury});
 return async input=>{try{return await classify(input);}catch(error){if(error?.dependency||error?.code)throw error;throw Object.assign(error instanceof Error?error:Error(String(error)),{code:OPERATING_COST_REFUSED});}};
}
function classifyOperatingCost({connection,genesisHash,programId,payer,feeOperator,treasury=null}){
 const pinned={genesisHash:key(genesisHash),programId:key(programId),payer:key(payer)},operator=key(feeOperator);
 // The sealed treasury is the release's platform treasury; the payer is the keeper. A legacy local fixture names none.
 const platformTreasury=key(treasury??payer);
 return async({binding,descriptor,packet,lookups=null})=>{
  for(const k of Object.keys(pinned))if(binding[k]!==pinned[k]||descriptor[k]!==pinned[k])throw Error('Operating cost scope mismatch');
  if(descriptor.campaign!==binding.campaign)throw Error('Operating campaign mismatch');
  if(await connection.getGenesisHash()!==pinned.genesisHash)throw Error('Operating cost ledger mismatch');
  const raw=Buffer.from(packet,'base64'),tx=VersionedTransaction.deserialize(raw);
  if(raw.length>1232||raw.toString('base64')!==packet||!Buffer.from(tx.serialize()).equals(raw)||tx.version!==0||(lookups==null&&tx.message.addressTableLookups.length)||String(tx.message.staticAccountKeys[0])!==pinned.payer)throw Error('Unqualified operating packet');
  // Lookup-table packets: the pinned resolution (validated against the message) is the only source of the loaded keys.
  const tables=lookups==null?[]:resolvePinnedLookups(tx.message,lookups).tables;
  const decoded=TransactionMessage.decompile(tx.message,tables.length?{addressLookupTableAccounts:tables}:undefined),[compute,...instructions]=decoded.instructions,units=descriptor.computeUnits;
  if(!Number.isInteger(units)||units<1||units>1400000||!compute?.programId.equals(ComputeBudgetProgram.programId)||!instructions.length||instructions.length>8)throw Error('Unqualified operating instruction count');
  const campaign=new PublicKey(binding.campaign),info=await connection.getAccountInfo(campaign,'finalized');
  if(!info||info.executable||!info.owner.equals(new PublicKey(pinned.programId)))throw Error('Operating campaign account unavailable');
  const state=c.decodeCampaign(info.data),terms=state.terms;
  if(terms.mode!==0||terms.genesis!==c.keyHex(pinned.genesisHash)||!c.campaignAddress(pinned.programId,terms.creator,terms.nonce).equals(campaign))throw Error('Operating campaign is not the pinned Standard launch');
  if(instructions.some(ix=>ix.programId.equals(SystemProgram.programId))){
   // Return of the unused operating reserve (option 1): only for a terminally refunded Standard campaign, only to its
   // sealed creator, exactly [transfer, memo] after the compute limit. The amount is bounded by the campaign's own
   // budget through the signer's hold; the accounting lane proves the finalized balances afterwards.
   if(instructions.length!==2||!instructions[0].programId.equals(SystemProgram.programId)||!instructions[1].programId.equals(MEMO_PROGRAM))throw Error('Operating return template is not qualified');
   const transfer=instructions[0],data=Buffer.from(transfer.data);
   if(data.length!==12||data.readUInt32LE(0)!==2||transfer.keys.length!==2||String(transfer.keys[0].pubkey)!==pinned.payer||String(transfer.keys[1].pubkey)!==String(terms.creator))throw Error('Operating return must move from the payer to the sealed creator');
   const lamports=data.readBigUInt64LE(4);if(lamports<=0n)throw Error('Empty operating return');
   const clock=await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'finalized');if(!clock||clock.data.length!==40)throw Error('Operating clock unavailable');
   const now=clock.data.readBigInt64LE(32);
   // Deadline-aware: an open round (even with nothing committed) is never a terminally refunded campaign.
   if(!campaignFailed({phase:state.state.phase,total:state.state.total,soft:terms.soft,deadline:terms.deadline,launchDeadline:terms.launchDeadline},now)||BigInt(state.state.refunded)!==BigInt(state.state.total))throw Error('Operating return needs a terminally refunded campaign');
   const cost={costModel:'v3-operating-return',costIntent:{programVersion:3,creator:String(terms.creator),lamports:String(lamports),computeUnits:units}};
   operatingCostModel({...cost,block:{blockhash:tx.message.recentBlockhash}},{tx,bytes:tx.message.serialize()},{...binding,treasury:platformTreasury});
   if(await connection.getGenesisHash()!==pinned.genesisHash)throw Error('Operating cost ledger changed');
   return cost;
  }
  if(instructions.some(ix=>ix.programId.equals(c.ASSOCIATED_TOKEN_PROGRAM))){
   if(String(terms.treasury)!==platformTreasury)throw Error('Fee setup campaign treasury is not the pinned treasury');
   const setup=feeSetupInstructions({...pinned,campaign,operator,terms});
   const rents=await Promise.all([160,165].map(n=>connection.getMinimumBalanceForRentExemption(n,'finalized')));
   if(rents.some(n=>!Number.isSafeInteger(n)||n<1))throw Error('Operating rent unavailable');
   const cost={costModel:'v3-fee-setup-rent',costIntent:{programVersion:3,operator,terms:Object.fromEntries(['childMint','treasury','dev'].map(k=>[k,String(terms[k])])),computeUnits:units,maximumRentLamports:String(BigInt(rents[0])+BigInt(setup.length-1)*BigInt(rents[1]))}};
   operatingCostModel({...cost,block:{blockhash:tx.message.recentBlockhash}},{tx,bytes:tx.message.serialize()},{...binding,treasury:platformTreasury});
   if(await connection.getGenesisHash()!==pinned.genesisHash)throw Error('Operating cost ledger changed');
   return cost;
  }
  if(instructions.every(ix=>ix.programId.equals(AddressLookupTableProgram.programId))){
   // The keeper's lookup table for a funding-first launch: created (first packet) and extended with exactly the launch
   // template's non-signer accounts in template order, LOOKUP_TABLE_CHUNK per extension, nothing else; the table on the
   // ledger (finalized) must be the keeper's, active, and hold exactly the template prefix before the next chunk.
   if(info.data[OFF_ACCOUNTING_VERSION]!==ACCOUNTING_VERSION_FUNDING_FIRST)throw Error('Lookup tables are set up for funding-first records only');
   const extInfo=await connection.getAccountInfo(extAddress(pinned.programId,campaign),'finalized');
   if(!extInfo||extInfo.executable||!extInfo.owner.equals(new PublicKey(pinned.programId)))throw Error('Funding-first extension unavailable');
   const ext=decodeExt(extInfo.data);if(ext.campaign!==binding.campaign||ext.version!==ACCOUNTING_VERSION_FUNDING_FIRST||ext.mint!==String(terms.childMint))throw Error('Extension differs from the record');
   const expected=launchTableAddresses(pinned.programId,campaign,terms,ext.feeNft),payerKey=new PublicKey(pinned.payer);
   const kinds=instructions.map(ix=>{try{return AddressLookupTableInstruction.decodeInstructionType(ix);}catch{return null;}});
   if(!kinds.every((k,i)=>k==='ExtendLookupTable'||(k==='CreateLookupTable'&&i===0)))throw Error('Lookup table template is not qualified');
   let table,offset=0,recentSlot=null;
   if(kinds[0]==='CreateLookupTable'){
    const d=AddressLookupTableInstruction.decodeCreateLookupTable(instructions[0]);
    if(!d.authority.equals(payerKey)||!d.payer.equals(payerKey))throw Error('Lookup table authority or payer is not the keeper');
    const [,address]=AddressLookupTableProgram.createLookupTable({authority:payerKey,payer:payerKey,recentSlot:Number(d.recentSlot)});
    table=address;recentSlot=String(d.recentSlot);
    if(await connection.getAccountInfo(table,'finalized'))throw Error('Lookup table already exists');
   }else{
    const d=AddressLookupTableInstruction.decodeExtendLookupTable(instructions[0]);table=d.lookupTable;
    const live=await connection.getAccountInfo(table,'finalized');
    if(!live||live.executable||!live.owner.equals(AddressLookupTableProgram.programId))throw Error('Lookup table is not on the ledger');
    const state=AddressLookupTableAccount.deserialize(live.data);
    if(!state.authority||!state.authority.equals(payerKey)||BigInt(state.deactivationSlot)!==U64_MAX)throw Error('Lookup table is not the keeper\'s active table');
    offset=state.addresses.length;if(!offset||offset>=expected.length||state.addresses.some((a,i)=>!a.equals(expected[i])))throw Error('Lookup table contents differ from the launch template');
   }
   const startOffset=offset,chunks=[];
   for(const ix of instructions.slice(kinds[0]==='CreateLookupTable'?1:0)){
    const d=AddressLookupTableInstruction.decodeExtendLookupTable(ix);
    if(!d.lookupTable.equals(table)||!d.authority.equals(payerKey)||!(d.payer??payerKey).equals(payerKey))throw Error('Lookup table extension differs');
    const chunk=expected.slice(offset,offset+d.addresses.length);
    if(!d.addresses.length||d.addresses.length>LOOKUP_TABLE_CHUNK||chunk.length!==d.addresses.length||chunk.some((a,i)=>!a.equals(d.addresses[i])))throw Error('Lookup table extension is not the next template chunk');
    chunks.push(chunk.map(String));offset+=chunk.length;
   }
   if(!chunks.length)throw Error('Lookup table packet extends nothing');
   const before=recentSlot===null?56+32*startOffset:0,after=56+32*offset;
   const rentBefore=before?await connection.getMinimumBalanceForRentExemption(before,'finalized'):0,rentAfter=await connection.getMinimumBalanceForRentExemption(after,'finalized');
   if(!Number.isSafeInteger(rentBefore)||!Number.isSafeInteger(rentAfter)||rentAfter<=rentBefore)throw Error('Operating rent unavailable');
   const cost={costModel:LOOKUP_TABLE_MODEL,costIntent:{programVersion:3,table:String(table),recentSlot,startOffset,chunks,computeUnits:units,maximumRentLamports:String(rentAfter-rentBefore)}};
   operatingCostModel({...cost,block:{blockhash:tx.message.recentBlockhash}},{tx,bytes:Buffer.from(tx.message.serialize()),tables},{...binding,treasury:platformTreasury});
   if(await connection.getGenesisHash()!==pinned.genesisHash)throw Error('Operating cost ledger changed');
   return cost;
  }
  const tags=instructions.map(ix=>ix.data[0]);
  if(instructions.some(ix=>String(ix.programId)!==pinned.programId||String(ix.keys[0]?.pubkey)!==binding.campaign)||tags.some(t=>t!==tags[0])||instructions.length>1&&![3,4,REFUND_V2_TAG,ACCOUNT_V2_TAG].includes(tags[0]))throw Error('Mixed or foreign operating instructions');
  // Funding-first bookkeeping (tags 44-47) runs on version-2 records only; the old money tags never do (the program refuses them).
  const fundingFirstRecord=info.data[OFF_ACCOUNTING_VERSION]===ACCOUNTING_VERSION_FUNDING_FIRST;
  if([REFUND_V2_TAG,CLOSE_V2_TAG,ACCOUNT_V2_TAG,RETURN_COLLATERAL_V2_TAG].includes(tags[0])!==fundingFirstRecord&&[2,3,4,5,6,REFUND_V2_TAG,CLOSE_V2_TAG,ACCOUNT_V2_TAG,RETURN_COLLATERAL_V2_TAG].includes(tags[0]))throw Error('Operating instruction tag does not match the record\'s accounting version');
  const rebuilt=[],seen=new Set();let cost={costModel:'network-fee-only'};
  for(const ix of instructions){
   const tag=ix.data[0],body=Buffer.from(ix.data);
   if(tag===2)rebuilt.push(c.finalizeInstruction(pinned.programId,campaign));
   else if(tag===5)rebuilt.push(c.assertReadyInstruction(pinned.programId,campaign));
   else if(tag===3||tag===4){
    const address=ix.keys[1]?.pubkey;if(!address||seen.has(String(address)))throw Error('Duplicate or missing operating receipt');seen.add(String(address));
    const r=await connection.getAccountInfo(address,'finalized');if(!r||r.executable||!r.owner.equals(new PublicKey(pinned.programId)))throw Error('Operating receipt unavailable');
    const receipt=c.decodeReceipt(r.data);
    if(!receipt.campaign.equals(campaign)||!c.receiptAddress(pinned.programId,campaign,receipt.owner).equals(address))throw Error('Foreign operating receipt');
    if(tag===3&&String(receipt.owner)===pinned.payer)throw Error('Refund recipient cannot be the operating cost payer');
    rebuilt.push((tag===3?c.refundInstruction:c.settleInstruction)(pinned.programId,campaign,receipt.owner));
   }else if(tag===6){
    const feeNft=ix.keys[6]?.pubkey;if(!feeNft)throw Error('Launch fee NFT missing');
    const sizes=[82,165,256,679],rents=await Promise.all(sizes.map(n=>connection.getMinimumBalanceForRentExemption(n,'finalized')));
    if(rents.some(n=>!Number.isSafeInteger(n)||n<1))throw Error('Operating rent unavailable');
    const maximumRentLamports=String(BigInt(rents[0])+2n*BigInt(rents[1])+BigInt(rents[2])+BigInt(rents[3]));
    rebuilt.push(c.launchInstruction(pinned.programId,campaign,terms,pinned.payer,feeNft).instruction);
    cost={costModel:'v3-launch-lock-rent',costIntent:{programVersion:3,maximumRentLamports,computeUnits:units,feeNft:String(feeNft),terms:Object.fromEntries(['childMint','ammProgram','ammConfig','lockProgram'].map(k=>[k,String(terms[k])]))}};
   }else if(tag===LAUNCH_V2_TAG){
    // Funding-first launch (tag 42): the version-2 record's launch with the mint leg. The display bytes must be the ones
    // committed at the opening (extension display hash) and name the sealed URI; the keeper pays the eight rents below.
    if(instructions.length!==1||ix.keys.length!==LAUNCH_V2_ACCOUNTS)throw Error('Funding-first launch template is not qualified');
    if(info.data[OFF_ACCOUNTING_VERSION]!==ACCOUNTING_VERSION_FUNDING_FIRST)throw Error('Campaign is not a funding-first record');
    const display=parseLaunchDisplayData(body.subarray(1));if(display.uri!==terms.metadataUri)throw Error('Launch display URI differs from the sealed URI');
    const feeNft=ix.keys[6]?.pubkey;if(!feeNft)throw Error('Launch fee NFT missing');
    const extInfo=await connection.getAccountInfo(extAddress(pinned.programId,campaign),'finalized');
    if(!extInfo||extInfo.executable||!extInfo.owner.equals(new PublicKey(pinned.programId)))throw Error('Funding-first extension unavailable');
    const ext=decodeExt(extInfo.data);
    if(ext.campaign!==binding.campaign||ext.version!==ACCOUNTING_VERSION_FUNDING_FIRST||ext.mint!==String(terms.childMint)||ext.feeNft!==String(feeNft)||ext.displayHash!==displayHash(display))throw Error('Launch display differs from the opening commitment');
    const sizes=[82,165,256,METADATA_ACCOUNT_BYTES],rents=await Promise.all(sizes.map(n=>connection.getMinimumBalanceForRentExemption(n,'finalized')));
    if(rents.some(n=>!Number.isSafeInteger(n)||n<1))throw Error('Operating rent unavailable');
    const [r82,r165,r256,rMeta]=rents.map(BigInt);
    rebuilt.push(launchFundingFirstInstruction(pinned.programId,campaign,terms,pinned.payer,feeNft,display).instruction);
    cost={costModel:FUNDING_FIRST_LAUNCH_MODEL,costIntent:{programVersion:3,maximumRentLamports:String(2n*r82+4n*r165+r256+rMeta+METAPLEX_CREATE_FEE_LAMPORTS),computeUnits:units,feeNft:String(feeNft),display,terms:Object.fromEntries(['childMint','ammProgram','ammConfig','lockProgram'].map(k=>[k,String(terms[k])])),rentLamportsByBytes:Object.fromEntries(sizes.map((n,i)=>[n,String(rents[i])]))}};
   }else if(tag===REFUND_V2_TAG||tag===ACCOUNT_V2_TAG){
    // Funding-first refund (44: campaign, receipt, owner, extension) and exact-once accounting (46: campaign, receipt,
    // extension): network fee only; the receipt is this campaign's and a refund never pays the operating cost payer.
    if(body.length!==1)throw Error('Funding-first bookkeeping carries no body');
    const address=ix.keys[1]?.pubkey;if(!address||seen.has(String(address)))throw Error('Duplicate or missing operating receipt');seen.add(String(address));
    const r=await connection.getAccountInfo(address,'finalized');if(!r||r.executable||!r.owner.equals(new PublicKey(pinned.programId)))throw Error('Operating receipt unavailable');
    const receipt=c.decodeReceipt(r.data);
    if(!receipt.campaign.equals(campaign)||!c.receiptAddress(pinned.programId,campaign,receipt.owner).equals(address))throw Error('Foreign operating receipt');
    if(tag===REFUND_V2_TAG&&String(receipt.owner)===pinned.payer)throw Error('Refund recipient cannot be the operating cost payer');
    rebuilt.push((tag===REFUND_V2_TAG?refundV2Instruction:accountV2Instruction)(pinned.programId,campaign,receipt.owner));
   }else if(tag===CLOSE_V2_TAG){
    if(body.length!==1||instructions.length!==1)throw Error('Funding-first close template is not qualified');
    rebuilt.push(closeV2Instruction(pinned.programId,campaign));
   }else if(tag===RETURN_COLLATERAL_V2_TAG){
    // The rounding collateral goes back to the sealed creator only (never the payer); the program decides the amount.
    if(body.length!==1||instructions.length!==1||String(terms.creator)===pinned.payer)throw Error('Funding-first collateral template is not qualified');
    rebuilt.push(returnCollateralV2Instruction(pinned.programId,campaign,terms.creator));
   }else if(tag===20){
    if(String(terms.treasury)!==platformTreasury)throw Error('Fee-state campaign treasury is not the pinned treasury');
    const rent=await connection.getMinimumBalanceForRentExemption(160,'finalized');if(!Number.isSafeInteger(rent)||rent<1)throw Error('Operating rent unavailable');
    rebuilt.push(c.feesInitInstruction(pinned.programId,campaign,pinned.payer,operator));
    cost={costModel:'v3-fee-state-rent',costIntent:{programVersion:3,operator,maximumRentLamports:String(rent),computeUnits:units}};
   }else if(tag===21||tag===26){
    if(body.length!==9)throw Error('Invalid operating fee amount');const amount=body.readBigUInt64LE(1);if(amount===0n)throw Error('Empty operating fee instruction');
    rebuilt.push(tag===21?c.feesCollectInstruction(pinned.programId,campaign,terms,state.state,pinned.payer,amount):c.feesBurnChildInstruction(pinned.programId,campaign,terms,pinned.payer,amount));
   }else if(tag===23)rebuilt.push(c.feesDistributeInstruction(pinned.programId,campaign,terms,pinned.payer));
   else throw Error('Operating cost template is not qualified');
  }
  const expected=new TransactionMessage({payerKey:new PublicKey(pinned.payer),recentBlockhash:tx.message.recentBlockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units}),...rebuilt]}).compileToV0Message(tables);
  const bytes=Buffer.from(tx.message.serialize());
  if(!Buffer.from(expected.serialize()).equals(bytes))throw Error('Operating packet differs from its exact cost template');
  operatingCostModel({...cost,block:{blockhash:tx.message.recentBlockhash}},{tx,bytes,tables},{...binding,treasury:platformTreasury});
  if(await connection.getGenesisHash()!==pinned.genesisHash)throw Error('Operating cost ledger changed');
  return cost;
 };
}
