// User swap slippage (owner, 23 September 2026): default 10 %, editable, remembered per browser. Basis points end to end:
// the quote request, the server's minimum output and the browser's check of the transaction all use the same number.
export const DEFAULT_SLIPPAGE_BPS=1000,MIN_SLIPPAGE_BPS=1,MAX_SLIPPAGE_BPS=5000,HIGH_SLIPPAGE_BPS=1000;
export const SLIPPAGE_PRESETS=Object.freeze([{bps:100,label:'1%'},{bps:500,label:'5%'},{bps:1000,label:'10%'}]);
export const STORAGE_KEY='kids.swap.slippageBps';
/** Percentage text ("10", "2.5", "0.05") to basis points; null when not a finite value inside the bounds or finer than 0.01 %. */
export function parseSlippagePercent(text){
 if(typeof text!=='string')return null;const t=text.trim().replace(',','.');if(!/^\d{1,2}(\.\d{1,2})?$/.test(t))return null;
 const bps=Math.round(Number(t)*100);if(!Number.isFinite(bps)||bps<MIN_SLIPPAGE_BPS||bps>MAX_SLIPPAGE_BPS)return null;return bps;
}
export function formatSlippage(bps){return (bps/100).toLocaleString('en-GB',{maximumFractionDigits:2})+'%';}
export function validSlippageBps(bps){return Number.isInteger(bps)&&bps>=MIN_SLIPPAGE_BPS&&bps<=MAX_SLIPPAGE_BPS;}
/** Stored preference, else the default. Storage may be missing or throw (private windows); the default then applies. */
export function loadSlippageBps(storage){try{const raw=storage?.getItem(STORAGE_KEY);const n=raw==null?NaN:Number(raw);return validSlippageBps(n)?n:DEFAULT_SLIPPAGE_BPS;}catch{return DEFAULT_SLIPPAGE_BPS;}}
export function saveSlippageBps(storage,bps){if(!validSlippageBps(bps))return false;try{storage?.setItem(STORAGE_KEY,String(bps));return true;}catch{return false;}}
/** Minimum received for a quoted output at the chosen slippage (integer maths, same rounding as the server). */
export function minimumOut(outputRaw,bps){return BigInt(outputRaw)*BigInt(10000-bps)/10000n;}
