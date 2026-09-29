import {PublicKey,TransactionMessage,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {validateApprovedMessage} from '../../../shared/approved-message.mjs';
const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),ATA=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const pda=(program,seeds)=>PublicKey.findProgramAddressSync(seeds,program)[0];
const ata=(owner,mint)=>pda(ATA,[owner.toBytes(),TOKEN.toBytes(),mint.toBytes()]);
const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
/** Independently validate every recipient, instruction, amount and network before asking a wallet to sign. */
export function decodePublicPacket(base64,{vm,owner,action,amountLamports}){
 const tx=VersionedTransaction.deserialize(Uint8Array.from(atob(base64),c=>c.charCodeAt(0))),m=tx.message;
 if(m.header.numRequiredSignatures!==1||m.staticAccountKeys[0].toBase58()!==owner||m.addressTableLookups?.length)throw Error('Unexpected transaction signer or lookup table');
 const program=new PublicKey(vm.identity.programId),campaign=new PublicKey(vm.identity.campaign),wallet=new PublicKey(owner);
 const receipt=pda(program,[new TextEncoder().encode('commitment'),campaign.toBytes(),wallet.toBytes()]);
 const ix=TransactionMessage.decompile(m).instructions;
 if(action==='fee-account'){
  if(vm.terms?.version!=='3'||(vm.devBeneficiary!==owner&&vm.treasury!==owner))throw Error('Fee account restoration is not available for this launch recipient');
  const mint=new PublicKey('So11111111111111111111111111111111111111112'),destination=ata(wallet,mint),expected=[wallet,destination,wallet,mint,SystemProgram.programId,TOKEN],a=ix[0];
  // The repeated wallet key is globally writable/signing after decompilation.
  if(ix.length!==1||!a.programId.equals(ATA)||!equal([...a.data],[1])||!equal(a.keys.map(k=>k.pubkey.toBase58()),expected.map(k=>k.toBase58()))||!equal(a.keys.map(k=>k.isWritable),[true,true,true,false,false,false])||!equal(a.keys.map(k=>k.isSigner),[true,false,true,false,false,false]))throw Error('Unexpected fee account restoration');
  return tx;
 }
 let accounts,data,expectedAta=null;
 if(action==='commit'){
  accounts=[wallet,campaign,receipt,SystemProgram.programId];data=new Uint8Array(49);data[0]=1;data.set(new PublicKey(vm.identity.genesisHash).toBytes(),1);new DataView(data.buffer).setBigUint64(33,BigInt(amountLamports),true);
  // The sequence is chain-selected by the server; preserve it, while validating amount and ledger independently.
  if(ix.length!==1||ix[0].data.length!==49)throw Error('Unexpected commitment instructions');data.set(ix[0].data.subarray(41),41);
 }else if(action==='setup'){
  if(vm.terms?.version!=='3'||vm.creator!==owner)throw Error('Setup return is not available for this launch and creator');
  const authority=pda(program,[new TextEncoder().encode('launch_authority'),campaign.toBytes()]);
  accounts=[campaign,authority,wallet,SystemProgram.programId];data=new Uint8Array(33);data[0]=27;data.set(new PublicKey(vm.identity.genesisHash).toBytes(),1);
  if(ix.length!==1||!equal(ix[0].keys.map(k=>k.isWritable),[false,true,true,false])||!equal(ix[0].keys.map(k=>k.isSigner),[false,false,true,false]))throw Error('Unexpected setup return permissions');
 }else if(action==='refund'){accounts=[campaign,receipt,wallet];data=Uint8Array.of(3);}
 else if(action==='allocation'||action==='dev'){
  if(action==='dev'&&vm.devBeneficiary!==owner)throw Error('This wallet is not the dev beneficiary');
  const mint=new PublicKey(vm.chain.mint),authority=pda(program,[new TextEncoder().encode('launch_authority'),campaign.toBytes()]),destination=ata(wallet,mint),vault=ata(authority,mint);
  accounts=action==='allocation'?[campaign,receipt,authority,mint,vault,destination,TOKEN]:[campaign,authority,mint,vault,destination,TOKEN];data=Uint8Array.of(action==='allocation'?7:8);
  expectedAta=[wallet,destination,wallet,mint,SystemProgram.programId,TOKEN];
 }else throw Error('Unsupported transaction action');
 if(ix.length!==(expectedAta?2:1))throw Error('Unexpected transaction instructions');
 if(expectedAta){const a=ix[0];if(!a.programId.equals(ATA)||!equal([...a.data],[1])||!equal(a.keys.map(k=>k.pubkey.toBase58()),expectedAta.map(k=>k.toBase58())))throw Error('Unexpected token account recipient');}
 const last=ix.at(-1);
 if(!last.programId.equals(program)||!equal([...last.data],[...data])||!equal(last.keys.map(k=>k.pubkey.toBase58()),accounts.map(k=>k.toBase58())))throw Error('Transaction differs from the approved launch action');
 return tx;
}
export function checkedSignedPacket(signed,approved){
 const wire=signed.serialize(),received=VersionedTransaction.deserialize(wire);
 validateApprovedMessage(received.message,VersionedTransaction.deserialize(approved).message);
 return btoa(String.fromCharCode(...wire));
}
