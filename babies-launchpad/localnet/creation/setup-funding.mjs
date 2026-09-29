// Separate the program's pool-initialization reserve from costs already paid by
// the creator and from keeper/treasury operating costs. Never transfer the entire
// headline quote to a PDA that cannot pay the other signers' bills.
import {canonicalHash} from '../registry/canonical.mjs';
const number=x=>{if(typeof x!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(x))throw Error('Invalid quoted setup amount');return BigInt(x);};
/** Rent-exempt minimum of a zero-data system account: what may remain on the launch authority after the pool is paid, or exactly nothing. */
export const AUTHORITY_RENT_FLOOR_LAMPORTS=890880n;
export function quoteAuthorityFunding(costs){
 if(!Array.isArray(costs?.lines)||costs.lines.length!==10||new Set(costs.lines.map(l=>l.item)).size!==10||!Number.isInteger(costs.marginBps)||costs.marginBps<0||costs.marginBps>10000)throw Error('Complete itemized setup quote required');
 const names=['campaign account rent','receipt rent (each committing wallet pays its own)','mint account rent','metadata account rent','pool creation fee (AMM config)','pool accounts rent (pool, observation, LP mint)','lock (fee NFT mint, metadata, locked position)','associated token accounts','fee state accounts','transaction fees (base + priority cap)'];
 const lines=costs.lines;if(names.some((name,index)=>!lines.some(l=>l.item===name&&l.payer===(index===1?'committer':'creator'))))throw Error('Setup cost payer or line changed');
 const read=name=>{const line=lines.find(l=>l.item===name);if(!line||line.payer!=='creator')throw Error('Missing creator setup line');return number(line.lamports);};
 const fee=read('pool creation fee (AMM config)'),poolRent=read('pool accounts rent (pool, observation, LP mint)'),ataLine=lines.find(l=>l.item==='associated token accounts');
 if(!Number.isSafeInteger(ataLine?.count)||ataLine.count<3)throw Error('Pool vault and LP account costs missing');
 const ataTotal=read('associated token accounts');if(ataTotal%BigInt(ataLine.count)!==0n)throw Error('Token-account quote is inconsistent');
 const poolTokenRent=ataTotal/BigInt(ataLine.count)*3n;
 const subtotal=fee+poolRent+poolTokenRent,margin=(subtotal*BigInt(costs.marginBps)+9999n)/10000n,total=subtotal+margin;
 // The margin is what stays on the launch authority after the pool costs: below the rent floor the launch transaction
 // would leave a non-empty, non-rent-exempt account and fail (program audit, 28 September 2026, L3).
 if(margin<AUTHORITY_RENT_FLOOR_LAMPORTS)throw Error('Setup margin must cover the launch authority rent floor');
 const quotedSubtotal=lines.reduce((sum,line)=>sum+number(line.lamports),0n),quotedMargin=(quotedSubtotal*BigInt(costs.marginBps)+9999n)/10000n;
 if(quotedSubtotal!==number(costs.subtotalLamports)||quotedMargin!==number(costs.marginLamports)||quotedSubtotal+quotedMargin!==number(costs.totalLamports)||total<=0n||total>number(costs.totalLamports))throw Error('Setup quote totals differ');
 return {version:1,destination:'launch-authority',coverage:'pool-initialization-only',amountLamports:String(total),poolCreationFeeLamports:String(fee),poolAccountsRentLamports:String(poolRent),poolTokenAccountsRentLamports:String(poolTokenRent),marginLamports:String(margin),costsHash:canonicalHash(costs)};
}
