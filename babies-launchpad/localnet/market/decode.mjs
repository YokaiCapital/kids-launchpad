// Pure decoder: one parsed transaction (getTransaction, jsonParsed, maxSupportedTransactionVersion 0) to the
// swap records that happened on ONE canonical Raydium CPMM pool. No RPC, no clock, no state.
//
// Rules (KIDS market plan, section 3):
// - Only successful transactions. A failed transaction has no fills.
// - Only CPMM `swap_base_input` / `swap_base_output` instructions whose pool account is our pool. Deposits,
//   withdrawals (the keeper's CollectCpFees goes through `withdraw`), fee collections and initialisation are
//   never trades.
// - Every swap instruction is its own record, whether it is a top-level instruction or nested under another
//   program (an aggregator route, a bundler). Two swaps in one transaction are two records.
// - Amounts come from the token transfers the swap instruction itself issued (its direct children, by stack
//   height): one transfer INTO a pool vault (the input, signed by the trader) and one transfer OUT of a pool
//   vault (the output, signed by the pool authority). Anything else is ambiguous and is reported, never guessed.
// - Price is exact: SOL per whole coin, scaled by 1e18 in integer maths (`priceScaled`). Floats exist only for
//   display (`priceSol`).
// - Fee convention: amounts are what moved between the trader and the vaults. The pool's trade fee stays inside
//   the input vault, so the input amount is gross of it; nothing is deducted or added here.
import {decodeBase58} from "../../shared/solana.mjs";
export const CPMM_PROGRAM='CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
export const WSOL_MINT='So11111111111111111111111111111111111111112';
export const DECODER_VERSION=1;
/** Transaction versions whose jsonParsed shape this decoder has been verified against (fixtures: legacy, v0 with lookup table, v1). */
export const SUPPORTED_VERSIONS=Object.freeze(['legacy',0,1]);
export const PRICE_SCALE=10n**18n;
const TOKEN_PROGRAMS=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const DISCRIMINATORS={'143,190,90,218,196,30,51,222':'swap_base_input','55,217,98,86,163,74,180,173':'swap_base_output'};
const SWAP_POOL_ACCOUNT=3;// [payer, authority, ammConfig, poolState, inputAccount, outputAccount, inputVault, outputVault, ...]
const U64=/^\d{1,20}$/;
/** SOL per whole coin, scaled by PRICE_SCALE. lamports/1e9 divided by coinRaw/10^decimals. */
export function priceScaled(lamports,coinRaw,coinDecimals){
 const l=BigInt(lamports),c=BigInt(coinRaw);if(c<=0n||l<0n)return null;
 return (l*10n**BigInt(coinDecimals)*PRICE_SCALE/(c*1000000000n)).toString();
}
/** Decimal string of a scaled integer (no floats, no exponent). */
export function formatScaled(scaled,scaleDigits=18){
 const s=BigInt(scaled).toString().padStart(scaleDigits+1,'0');
 const whole=s.slice(0,s.length-scaleDigits),frac=s.slice(s.length-scaleDigits).replace(/0+$/,'');
 return frac?whole+'.'+frac:whole;
}
export const scaledToNumber=scaled=>Number(BigInt(scaled))/1e18;
function swapKind(data){
 let bytes;try{bytes=decodeBase58(data);}catch{return null;}
 if(bytes.length<8)return null;
 return DISCRIMINATORS[Array.from(bytes.subarray(0,8)).join(',')]||null;
}
function transfer(ix){
 if(!TOKEN_PROGRAMS.has(ix.programId)||!ix.parsed||!['transfer','transferChecked'].includes(ix.parsed.type))return null;
 const info=ix.parsed.info||{};const amount=ix.parsed.type==='transfer'?info.amount:info.tokenAmount?.amount;
 if(typeof amount!=='string'||!U64.test(amount))return null;
 return {source:info.source,destination:info.destination,authority:info.authority||info.multisigAuthority||null,mint:info.mint||null,decimals:ix.parsed.type==='transferChecked'?info.tokenAmount?.decimals:null,amount};
}
/** Direct children of the swap instruction, by stack height. Returns null when heights are missing for a nested swap. */
function childrenOf(list,position,height){
 const out=[];
 for(let j=position+1;j<list.length;j++){
  const h=list[j].stackHeight;
  if(h==null)return height===1?list.slice(position+1).filter(ix=>ix.stackHeight==null):null;
  if(h<=height)break;
  if(h===height+1)out.push(list[j]);
 }
 return out;
}
function decodeOne({ix,path,nested,outerProgram,children,pool}){
 const vaults={[pool.vault0]:{mint:pool.mint0,decimals:pool.decimals0},[pool.vault1]:{mint:pool.mint1,decimals:pool.decimals1}};
 if(children===null)return {skip:'nested swap without stack heights (unsupported RPC response)'};
 const transfers=children.map(transfer).filter(Boolean);
 const inputs=transfers.filter(t=>vaults[t.destination]&&t.authority!==pool.authority),outputs=transfers.filter(t=>vaults[t.source]&&t.authority===pool.authority);
 if(inputs.length!==1||outputs.length!==1)return {skip:'ambiguous transfers: '+inputs.length+' in, '+outputs.length+' out'};
 const [input,output]=[inputs[0],outputs[0]];
 const inVault=vaults[input.destination],outVault=vaults[output.source];
 if(input.destination===output.source)return {skip:'input and output vault are the same'};
 if((input.mint&&input.mint!==inVault.mint)||(output.mint&&output.mint!==outVault.mint))return {skip:'transfer mint does not match the vault mint'};
 if((input.decimals!=null&&input.decimals!==inVault.decimals)||(output.decimals!=null&&output.decimals!==outVault.decimals))return {skip:'transfer decimals do not match the pool'};
 let side,solLamports,coinRaw,coinDecimals;
 if(inVault.mint===WSOL_MINT){side='buy';solLamports=input.amount;coinRaw=output.amount;coinDecimals=outVault.decimals;}
 else if(outVault.mint===WSOL_MINT){side='sell';solLamports=output.amount;coinRaw=input.amount;coinDecimals=inVault.decimals;}
 else return {skip:'pool is not quoted in SOL'};
 const price=priceScaled(solLamports,coinRaw,coinDecimals);
 if(price===null)return {skip:'zero coin amount'};
 return {swap:{instructionPath:path,kind:swapKind(ix.data),nested,outerProgram,trader:ix.accounts?.[0]||null,side,inputMint:inVault.mint,inputAmount:input.amount,outputMint:outVault.mint,outputAmount:output.amount,solLamports,coinRaw,coinDecimals,priceScaled:price,priceSol:scaledToNumber(price)}};
}
/**
 * @param tx a jsonParsed transaction (result of getTransaction) or null
 * @param pool {pool, authority, vault0, vault1, mint0, mint1, decimals0, decimals1} base58 strings and integers
 * @returns {failed:boolean, swaps:[...], skipped:[{path,reason}], version}
 */
export function decodeSwaps(tx,pool){
 for(const k of ['pool','authority','vault0','vault1','mint0','mint1'])if(typeof pool?.[k]!=='string')throw Error('Pool identity is incomplete: '+k);
 for(const k of ['decimals0','decimals1'])if(!Number.isInteger(pool[k])||pool[k]<0||pool[k]>18)throw Error('Pool identity is incomplete: '+k);
 const out={failed:false,unsupported:false,swaps:[],skipped:[],version:tx?.version??null};
 if(!tx||!tx.transaction?.message||!tx.meta)return {...out,skipped:[{path:null,reason:'no transaction'}]};
 if(!SUPPORTED_VERSIONS.includes(tx.version))return {...out,unsupported:true,skipped:[{path:null,reason:'unsupported transaction version '+String(tx.version)}]};
 if(tx.meta.err)return {...out,failed:true};
 const top=tx.transaction.message.instructions||[],innerByIndex=new Map();
 for(const inner of tx.meta.innerInstructions||[])innerByIndex.set(inner.index,inner.instructions||[]);
 const base={signature:tx.transaction.signatures?.[0]||null,slot:tx.slot,blockTime:Number.isInteger(tx.blockTime)?tx.blockTime:null,decoderVersion:DECODER_VERSION};
 const push=(candidate,path)=>{if(candidate.skip)out.skipped.push({path,reason:candidate.skip});else out.swaps.push({...base,...candidate.swap});};
 top.forEach((ix,i)=>{
  const inner=innerByIndex.get(i)||[];
  if(ix.programId===CPMM_PROGRAM){
   const kind=ix.data&&swapKind(ix.data);
   if(kind&&ix.accounts?.[SWAP_POOL_ACCOUNT]===pool.pool){
    const children=inner.filter(x=>x.stackHeight==null||x.stackHeight===2);
    push(decodeOne({ix,path:String(i),nested:false,outerProgram:null,children,pool}),String(i));
   }
  }
  inner.forEach((ix2,j)=>{
   if(ix2.programId!==CPMM_PROGRAM)return;
   const kind=ix2.data&&swapKind(ix2.data);if(!kind||ix2.accounts?.[SWAP_POOL_ACCOUNT]!==pool.pool)return;
   const height=ix2.stackHeight==null?null:ix2.stackHeight;
   const children=height==null?null:childrenOf(inner,j,height);
   push(decodeOne({ix:ix2,path:i+'.'+j,nested:true,outerProgram:ix.programId,children,pool}),i+'.'+j);
  });
 });
 return out;
}
