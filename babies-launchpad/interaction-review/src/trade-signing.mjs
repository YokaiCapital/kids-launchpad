import {PublicKey,VersionedTransaction,TransactionMessage,SystemProgram} from '@solana/web3.js';
const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),ATA=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),NATIVE=new PublicKey('So11111111111111111111111111111111111111112'),CPMM=new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),CONFIG=new PublicKey('2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5');
const bytes=s=>new TextEncoder().encode(s),u64=(d,o)=>new DataView(d.buffer,d.byteOffset,d.byteLength).getBigUint64(o,true);
export function decodeApprovedTrade(raw,q,expected){
 for(const key of ['owner','campaign','mint','pool','programId','genesisHash','side','inputRaw','minOutputRaw','intentId','expiresAt'])if(q[key]!==expected[key])throw Error('Trade quote changed: '+key);
 if(Date.now()>=q.expiresAt)throw Error('Quote expired');
 const tx=VersionedTransaction.deserialize(raw),m=tx.message,owner=new PublicKey(q.owner),mint=new PublicKey(q.mint),wrapped=new PublicKey(q.wrappedAccount);
 if(m.header.numRequiredSignatures!==2||m.staticAccountKeys[0].toBase58()!==q.owner||m.staticAccountKeys[1].toBase58()!==q.wrappedAccount||m.addressTableLookups?.length)throw Error('Unexpected trade signers');
 const pda=(s,...keys)=>PublicKey.findProgramAddressSync([bytes(s),...keys.map(k=>k.toBytes())],CPMM)[0];
 const ordered=[mint,NATIVE].sort((a,b)=>{const x=a.toBytes(),y=b.toBytes();for(let i=0;i<32;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;});
 const pool=pda('pool',CONFIG,...ordered),authority=pda('vault_and_lp_mint_auth_seed'),child=PublicKey.findProgramAddressSync([owner.toBytes(),TOKEN.toBytes(),mint.toBytes()],ATA)[0];
 if(pool.toBase58()!==q.pool)throw Error('Unexpected pool');
 const ix=TransactionMessage.decompile(m).instructions;
 const check=(n,program,keys)=>{const v=ix[n];if(!v||!v.programId.equals(program)||v.keys.length!==keys.length||!keys.every((k,i)=>v.keys[i].pubkey.equals(k)))throw Error('Unexpected trade instruction '+n);return v.data;};
 if(ix.length!==5)throw Error('Unexpected extra trade instructions');
 let d=check(0,ATA,[owner,child,owner,mint,SystemProgram.programId,TOKEN]);if(d.length!==1||d[0]!==1)throw Error('Unexpected ATA instruction');
 d=check(1,SystemProgram.programId,[owner,wrapped]);const funding=BigInt(q.rentLamports)+(q.side==='buy'?BigInt(q.inputRaw):0n);if(d.length!==52||new DataView(d.buffer,d.byteOffset).getUint32(0,true)!==0||u64(d,4)!==funding||u64(d,12)!==165n||!new PublicKey(d.slice(20)).equals(TOKEN)||BigInt(q.rentLamports)>10000000n)throw Error('Unexpected temporary account funding');
 d=check(2,TOKEN,[wrapped,NATIVE]);if(d.length!==33||d[0]!==18||!new PublicKey(d.slice(1)).equals(owner))throw Error('Unexpected temporary account owner');
 const input=q.side==='buy'?NATIVE:mint,output=q.side==='buy'?mint:NATIVE;
 d=check(3,CPMM,[owner,authority,CONFIG,pool,q.side==='buy'?wrapped:child,q.side==='buy'?child:wrapped,pda('pool_vault',pool,input),pda('pool_vault',pool,output),TOKEN,TOKEN,input,output,pda('observation',pool)]);
 if(d.length!==24||d.slice(0,8).join(',')!=='143,190,90,218,196,30,51,222'||u64(d,8)!==BigInt(q.inputRaw)||u64(d,16)!==BigInt(q.minOutputRaw))throw Error('Trade amounts changed');
 d=check(4,TOKEN,[wrapped,owner,owner]);if(d.length!==1||d[0]!==9)throw Error('Unexpected refund recipient');
 return tx;
}
