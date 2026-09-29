import {PublicKey,VersionedTransaction,TransactionMessage} from '@solana/web3.js';
const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),ATA=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),SYSTEM=new PublicKey('11111111111111111111111111111111');
const bytes=text=>new TextEncoder().encode(text);
export function decodeApprovedClaim(raw,{owner,programId,campaign,mint,action}){
 const tx=VersionedTransaction.deserialize(raw),m=tx.message,ownerKey=new PublicKey(owner),program=new PublicKey(programId),campaignKey=new PublicKey(campaign),mintKey=new PublicKey(mint);
 if(m.header.numRequiredSignatures!==1||m.staticAccountKeys[0]?.toBase58()!==owner||m.addressTableLookups?.length)throw Error('Unexpected claim payer, signer or lookup table');
 const pda=(...seeds)=>PublicKey.findProgramAddressSync(seeds,program)[0],ata=(who)=>PublicKey.findProgramAddressSync([who.toBytes(),TOKEN.toBytes(),mintKey.toBytes()],ATA)[0];
 const authority=pda(bytes('launch_authority'),campaignKey.toBytes()),source=ata(authority),dest=ata(ownerKey),receipt=pda(bytes('commitment'),campaignKey.toBytes(),ownerKey.toBytes());
 const ix=TransactionMessage.decompile(m).instructions;
 const keysEqual=(instruction,expected)=>instruction.keys.length===expected.length&&expected.every((key,i)=>instruction.keys[i].pubkey.equals(key));
 if(action!=='refund'){
  const create=ix.shift();if(!create?.programId.equals(ATA)||create.data.length!==1||create.data[0]!==1||!keysEqual(create,[ownerKey,dest,ownerKey,mintKey,SYSTEM,TOKEN]))throw Error('Unexpected claim token destination');
 }
 const claim=ix[0];if(ix.length!==1||!claim.programId.equals(program))throw Error('Unexpected claim program or extra instruction');
 let expected,tag;
 if(action==='participant'){tag=7;expected=[campaignKey,receipt,authority,mintKey,source,dest,TOKEN];}
 else if(action==='refund'){tag=3;expected=[campaignKey,receipt,ownerKey];}
 else if(action==='dev'){tag=8;expected=[campaignKey,authority,mintKey,source,dest,TOKEN];}
 else if(action==='parentA'||action==='parentB'){
  tag=10;const index=action==='parentA'?0:1;
  expected=[ownerKey,campaignKey,pda(bytes('parents'),campaignKey.toBytes()),pda(bytes('parent_claim'),campaignKey.toBytes(),Uint8Array.of(index),ownerKey.toBytes()),ownerKey,authority,mintKey,source,dest,TOKEN,SYSTEM];
  if(claim.data.length<19||claim.data[1]!==index||claim.data[18]>32||claim.data.length!==19+32*claim.data[18])throw Error('Unexpected parent claim proof');
 }else throw Error('Unknown claim action');
 if(claim.data[0]!==tag||!keysEqual(claim,expected)||(tag!==10&&claim.data.length!==1))throw Error('Claim does not match your wallet or selected allocation');
 return tx;
}
