// One finalized bank contains both mint supply and every token account. This
// full-program read is intentionally LOCALNET ONLY, not a mainnet RPC strategy.
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackMint,unpackAccount} from '@solana/spl-token';
import {PublicKey} from '@solana/web3.js';
import {parentTree} from './atomic-claims.mjs';
export async function captureLocalParentSnapshot(ctx,campaign,mints){
 if(ctx.connection.rpcEndpoint!=='http://127.0.0.1:19099'||await ctx.connection.getGenesisHash()!==ctx.manifest.genesisHash)throw Error('Parent fixture snapshots require the verified isolated localnet');
 // Both token programs in one finalized bank: a parent may be Token-2022 (Buttcoin on mainnet).
 const [classic,token2022]=await Promise.all([ctx.connection.getProgramAccounts(TOKEN_PROGRAM_ID,{commitment:'finalized',withContext:true}),ctx.connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID,{commitment:'finalized',withContext:true})]);
 if(classic.context.slot!==token2022.context.slot)throw Error('Parent snapshot reads landed in different banks; retry');
 const snapshot={context:classic.context,value:[...classic.value.map(a=>({...a,program:TOKEN_PROGRAM_ID})),...token2022.value.map(a=>({...a,program:TOKEN_2022_PROGRAM_ID}))]};
 const accounts=new Map(snapshot.value.map(a=>[a.pubkey.toBase58(),a]));
 const parents=mints.map((mint,index)=>{
  mint=new PublicKey(mint);const row=accounts.get(mint.toBase58());if(!row)throw Error('Parent mint absent at finalized snapshot');
  const program=row.program,supply=unpackMint(mint,row.account,program).supply,holders=new Map();
  for(const a of snapshot.value){if(!a.program.equals(program)||a.account.data.length<165||(a.account.data.length>165&&a.account.data[165]!==2))continue;let t;try{t=unpackAccount(a.pubkey,a.account,program);}catch{continue;}if(!t.mint.equals(mint)||!t.isInitialized||t.isFrozen||t.amount===0n)continue;const owner=t.owner.toBase58();holders.set(owner,(holders.get(owner)||0n)+t.amount);}
  const balances=[...holders].sort(([a],[b])=>a.localeCompare(b)).map(([owner,balance])=>({owner,balance}));
  const tree=parentTree(campaign,index,supply,balances);return {mint:mint.toBase58(),tokenProgram:program.equals(TOKEN_2022_PROGRAM_ID)?'token-2022':'spl-token',supply,balances,...tree};
 });
 return {network:'localnet',genesisHash:ctx.manifest.genesisHash,campaign:new PublicKey(campaign).toBase58(),commitment:'finalized',slot:snapshot.context.slot,parents};
}
export function publicSnapshot(snapshot){return JSON.parse(JSON.stringify(snapshot,(_key,value)=>typeof value==='bigint'?value.toString():Buffer.isBuffer(value)?value.toString('hex'):value?.type==='Buffer'&&Array.isArray(value.data)?Buffer.from(value.data).toString('hex'):value));}
