// Validate signed message semantics without relying on legacy account sorting.
// Wallet priority fees are bounded to 100,000 lamports (0.0001 SOL).
const COMPUTE='ComputeBudget111111111111111111111111111111';
const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
function describe(m){
 if(m.addressTableLookups?.length)throw Error('Address lookup tables are not approved.');
 const keys=m.staticAccountKeys.map(k=>k.toBase58());
 return {payer:keys[0],signers:keys.slice(0,m.header.numRequiredSignatures),instructions:m.compiledInstructions.map(ix=>({program:keys[ix.programIdIndex],data:Array.from(ix.data),accounts:Array.from(ix.accountKeyIndexes).map(i=>({key:keys[i],signer:m.isAccountSigner(i),writable:m.isAccountWritable(i)}))}))};
}
export function validateApprovedMessage(received,approved){
 const a=describe(approved),b=describe(received);
 if(a.payer!==b.payer||!equal(a.signers,b.signers))throw Error('Wallet changed the transaction payer or signers.');
 if(received.recentBlockhash!==approved.recentBlockhash)throw Error('Wallet changed the approved blockhash.');
 // Without an explicit limit, multi-instruction transactions can receive more
 // than 200k units. Bound fees using the runtime maximum, not a one-instruction default.
 let limit=1400000,price=0n;const seen=new Set();
 const core=b.instructions.filter(ix=>{
  if(ix.program!==COMPUTE)return true;
  const d=Uint8Array.from(ix.data),v=new DataView(d.buffer),tag=d[0];
  if(ix.accounts.length||seen.has(tag))throw Error('Unapproved compute budget instruction.');
  seen.add(tag);
  if(tag===2&&d.length===5){limit=v.getUint32(1,true);if(!limit||limit>1400000)throw Error('Invalid compute limit.');}
  else if(tag===3&&d.length===9)price=v.getBigUint64(1,true);
  else throw Error('Unapproved compute budget instruction.');
  return false;
 });
 if((BigInt(limit)*price+999999n)/1000000n>100000n)throw Error('Wallet priority fee exceeds 0.0001 SOL.');
 if(JSON.stringify(core)!==JSON.stringify(a.instructions))throw Error('Wallet changed the approved escrow instruction or added an unapproved instruction.');
 return true;
}
