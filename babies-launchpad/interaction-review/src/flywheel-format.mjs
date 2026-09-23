// Flywheel display helpers (owner, 23 September 2026). Counters arrive as raw integer strings: token amounts in the
// mint's base units (6 decimals for $Shartcoin and both parents), SOL in lamports (9 decimals). Unknown stays "—":
// a missing number is never shown as zero.
const SOL_DECIMALS=9,DUST_LAMPORTS=100000n;// 0.0001 SOL
function toBig(value){if(value==null)return null;try{const n=BigInt(value);return n<0n?null:n;}catch{return null;}}
/** Exact decimal string, trailing zeros trimmed. "763999619760" at 6 decimals → "763999.61976". */
export function exactUnits(raw,decimals){const n=toBig(raw);if(n==null)return null;const s=n.toString().padStart(decimals+1,'0');const whole=s.slice(0,s.length-decimals),frac=s.slice(s.length-decimals).replace(/0+$/,'');return whole+(frac?'.'+frac:'');}
const group=(text,maxFraction)=>{const [whole,frac='']=text.split('.');const w=BigInt(whole).toLocaleString('en-GB');const f=frac.slice(0,maxFraction);return f?w+'.'+f:w;};
/** Grouped decimal with at most `maxFraction` places, no rounding up past the exact value. */
export function formatUnits(raw,decimals,maxFraction=2){const exact=exactUnits(raw,decimals);return exact==null?'—':group(exact,maxFraction);}
/** Short tile figure ("764K", "18.82B", "0.4938") with the exact grouped value for a title attribute. */
export function compactUnits(raw,decimals,unit=''){
 const exact=exactUnits(raw,decimals);if(exact==null)return {text:'—',exact:null};
 const value=Number(exact);const text=Math.abs(value)>=1000?value.toLocaleString('en-US',{notation:'compact',maximumFractionDigits:2}):group(exact,decimals===SOL_DECIMALS?4:2);
 const full=group(exact,decimals);return {text,exact:unit?full+' '+unit:full};
}
/** SOL amounts for history rows: adaptive precision, tiny real amounts read "<0.0001 SOL", unknown is "—". */
export function formatSolAmount(lamports){
 const n=toBig(lamports);if(n==null)return {text:'—',exact:null};
 const exact=exactUnits(n,SOL_DECIMALS)+' SOL';
 if(n===0n)return {text:'0 SOL',exact};
 if(n<DUST_LAMPORTS)return {text:'<0.0001 SOL',exact};
 return {text:group(exactUnits(n,SOL_DECIMALS),4)+' SOL',exact};
}
/** Buyback log heading: the journal is a bounded window, so the count is "showing N", never a lifetime total. */
export function activityLabel(total,shown){if(!total)return 'None yet';return 'Recent activity · showing '+Math.min(total,shown);}
