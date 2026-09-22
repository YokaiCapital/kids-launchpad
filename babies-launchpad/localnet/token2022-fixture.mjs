// Localnet-only fixture: a Token-2022 parent mint shaped like Buttcoin on mainnet (metadata pointer to itself,
// embedded token metadata, 6 decimals, mint and freeze authority revoked after minting). Nothing here runs on mainnet.
import {Keypair,PublicKey,SystemProgram,Transaction} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,ExtensionType,getMintLen,TYPE_SIZE,LENGTH_SIZE,createInitializeMetadataPointerInstruction,createInitializeMint2Instruction,createAssociatedTokenAccountIdempotentInstruction,createMintToInstruction,createSetAuthorityInstruction,AuthorityType,getAssociatedTokenAddressSync,getMint} from '@solana/spl-token';
import {createInitializeInstruction,pack} from '@solana/spl-token-metadata';
export async function createToken2022Parent(connection,payer,{name='Buttcoin fixture',symbol='BUTTFIX',uri='https://kids.fun/fixture',holders=[],withMetadata=process.env.KIDS_TOKEN2022_NO_METADATA!=='1'}={}){
 const build=async(metadataToo)=>{
  const mintKey=Keypair.generate(),mint=mintKey.publicKey;
  const metadata={mint,name,symbol,uri,additionalMetadata:[]};
  const mintLen=getMintLen([ExtensionType.MetadataPointer]),metadataLen=metadataToo?TYPE_SIZE+LENGTH_SIZE+pack(metadata).length:0;
  const lamports=await connection.getMinimumBalanceForRentExemption(mintLen+metadataLen);
  const tx=new Transaction().add(
   SystemProgram.createAccount({fromPubkey:payer.publicKey,newAccountPubkey:mint,space:mintLen,lamports,programId:TOKEN_2022_PROGRAM_ID}),
   createInitializeMetadataPointerInstruction(mint,payer.publicKey,mint,TOKEN_2022_PROGRAM_ID),
   createInitializeMint2Instruction(mint,6,payer.publicKey,payer.publicKey,TOKEN_2022_PROGRAM_ID));
  if(metadataToo)tx.add(createInitializeInstruction({programId:TOKEN_2022_PROGRAM_ID,mint,metadata:mint,name,symbol,uri,mintAuthority:payer.publicKey,updateAuthority:payer.publicKey}));
  for(const {owner,amount} of holders){const ata=getAssociatedTokenAddressSync(mint,owner,true,TOKEN_2022_PROGRAM_ID);tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,ata,owner,mint,TOKEN_2022_PROGRAM_ID),createMintToInstruction(mint,ata,payer.publicKey,amount,[],TOKEN_2022_PROGRAM_ID));}
  await connection.sendTransaction(tx,[payer,mintKey]).then(sig=>connection.confirmTransaction(sig,'confirmed'));
  return mint;
 };
 if(!withMetadata)return build(false);
 // Agave 3.x test validators ship an older Token-2022 whose embedded-metadata initialisation fails to reallocate the
 // mint ('Failed to reallocate account data', hosted localnet 20 Sep 2026). The Token-2022 code paths under rehearsal
 // (owner check, TLV allowlist, custody, burn) only need the metadata POINTER, so fall back to that and say so.
 try{return await build(true);}
 catch(error){if(!/reallocate|realloc/i.test(String(error?.message||error)))throw error;console.error(JSON.stringify({event:'token2022-fixture-fallback',reason:'metadata initialisation refused by this validator; mint created with metadata pointer only'}));return build(false);}
}
/** Revokes mint and freeze authority, mirroring the real parents (both revoked). */
export async function revokeToken2022Authorities(connection,payer,mint){
 const tx=new Transaction().add(createSetAuthorityInstruction(mint,payer.publicKey,AuthorityType.MintTokens,null,[],TOKEN_2022_PROGRAM_ID),createSetAuthorityInstruction(mint,payer.publicKey,AuthorityType.FreezeAccount,null,[],TOKEN_2022_PROGRAM_ID));
 await connection.sendTransaction(tx,[payer]).then(sig=>connection.confirmTransaction(sig,'confirmed'));
 const info=await getMint(connection,mint,'confirmed',TOKEN_2022_PROGRAM_ID);if(info.mintAuthority||info.freezeAuthority)throw Error('Authorities not revoked');
}
