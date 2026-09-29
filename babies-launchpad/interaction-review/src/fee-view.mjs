// Fee routing copy for the coin page, keyed on the live program's feature list served by the API (`programFeatures`).
// Build 6 ('child-buyback') folds the two parent buyback budgets into one bucket that buys and burns Shartcoin; earlier
// builds keep the parent wording. Nothing here is decided by a date. Unknown numbers stay "—", never 0.
import {formatUnits,compactUnits} from './flywheel-format.mjs';
export const feeMode=features=>Array.isArray(features)&&features.includes('child-buyback')?'child':'parents';
/** The fee sentence under the flywheel heading. */
export function feeSentence(bps,mode='parents'){
 const fee=Number(bps)>0?(bps/100).toLocaleString('en-GB')+' %':null;
 const head=(fee?'Every trade pays the pool fee of '+fee+'.':'Every trade pays the pool fee.')+' The program harvests the LP share of that fee. The rest of the pool fee is Raydium’s protocol and fund share.';
 if(mode==='child')return head+' The SOL side is split: KIDS treasury, the dev, and a Shartcoin buyback that is burned. The coin side is burned outright, never sold.';
 return head+' The SOL side is split: KIDS treasury, the dev, and buybacks of both parents that are burned. The coin side is burned outright, never sold.';
}
/** Help text behind "SOL collected". */
export const collectedHelp=mode=>mode==='child'?'All the SOL the pool fee has brought in since launch. It is split between the KIDS treasury, the dev and a Shartcoin buyback that is burned.':'All the SOL the pool fee has brought in since launch. It is split between the KIDS treasury, the dev and buybacks of both parents.';
/** The coin buyback bucket (build 6) from the served fee block: spent SOL, coins burned, SOL queued, plus what the old
 * parent buckets bought before the upgrade so nothing already burned disappears from the page. */
export function childBuybackBucket(fees,{coinDecimals=6,parentDecimals=6,parents=['Fartcoin','Buttcoin']}={}){
 if(!fees)return null;
 const big=v=>{if(v==null)return null;try{const n=BigInt(v);return n<0n?null:n;}catch{return null;}};
 const spent=big(fees.childBuybackSpent),burned=big(fees.childBoughtAndBurned),pending=big(fees.childBuybackPending);
 const earlier=parents.map((name,i)=>({name,burnedRaw:big(i?fees.parentBBurned:fees.parentABurned),burnedText:formatUnits(i?fees.parentBBurned:fees.parentABurned,parentDecimals,0)})).filter(p=>p.burnedRaw!=null&&p.burnedRaw>0n);
 return {spentLamports:spent==null?null:spent.toString(),spentText:formatUnits(spent==null?null:spent.toString(),9,4),burnedRaw:burned==null?null:burned.toString(),burned:compactUnits(burned==null?null:burned.toString(),coinDecimals,'$Shartcoin'),pendingLamports:pending==null?null:pending.toString(),pendingText:pending!=null&&pending>0n?formatUnits(pending.toString(),9,4)+' SOL queued, not yet bought':null,earlier,earlierText:earlier.length?'Earlier parent buybacks: '+earlier.map(p=>p.burnedText+' '+p.name).join(' · ')+' burned':null};
}
/** Token-details rows: fee routing and the buyback bucket, in the wording of the live build. */
export function feeRoutingFacts(fees,mode='parents'){
 if(!fees)return [['Fee routing','Not initialized for this pool']];
 const rows=[['Fee routing',formatUnits(fees.treasuryPaid,9,4)+' SOL to KIDS · '+formatUnits(fees.devPaid,9,4)+' SOL to dev']];
 if(mode==='child'){const b=childBuybackBucket(fees);rows.push(['Shartcoin buyback and burn',(b.spentLamports!=null?b.spentText+' SOL spent':'SOL spent not served')+' · '+(b.burnedRaw!=null?formatUnits(b.burnedRaw,6,0)+' $Shartcoin burned':'burned amount not served')+(b.pendingText?' · '+b.pendingText:'')]);}
 else rows.push(['Parent buybacks',formatUnits(fees.parentASpent,9,4)+' SOL / '+formatUnits(fees.parentBSpent,9,4)+' SOL spent']);
 return rows;
}
