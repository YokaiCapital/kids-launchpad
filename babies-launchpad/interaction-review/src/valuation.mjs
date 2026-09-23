// Parent reward valuation (reviewed draft, integrated 23 September 2026). Every token quantity is a raw integer string
// of the same mint; unknown stays null and is never shown as zero. Integer maths for the FDV estimate.
import {exactUnits} from './flywheel-format.mjs';
const raw=value=>typeof value==='string'&&/^\d{1,40}$/.test(value);
// Both token quantities must be raw units of the same mint, from the same campaign.
export function claimValueCents(claimRaw, supplyRaw, fdvDollars) {
  if (!raw(claimRaw) || !raw(supplyRaw)) return null;
  const dollars = String(fdvDollars ?? '').trim();
  if (!/^\d{1,15}(?:\.\d{1,2})?$/.test(dollars)) return null;
  const [whole, fraction = ''] = dollars.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const claim = BigInt(claimRaw), supply = BigInt(supplyRaw);
  if (supply === 0n || claim > supply || cents === 0n) return null;
  return claim * cents / supply;
}

export function displayValue(cents, positiveClaim = false) {
  if (cents == null) return 'Unavailable';
  if (cents === 0n && positiveClaim) return '<$0.01';
  return '$' + (cents / 100n).toLocaleString('en-US') + '.' + (cents % 100n).toString().padStart(2, '0');
}

/** The served parentStats block is `{verifiedAt, parents:[…]}`; a bare array is accepted too. Unknown is an empty list. */
export function parentStatsList(data){
  const block=data?.parentStats;
  const list=Array.isArray(block)?block:Array.isArray(block?.parents)?block.parents:[];
  return list.filter(p=>p&&typeof p==='object');
}
/** The stats entry for one parent by its index, or null when it is not served. */
export function parentStatsFor(data,index){return parentStatsList(data).find(p=>p.index===index)||null;}

/**
 * Denominator for the FDV estimate: the supply at launch, never a burned-down figure. The API serves each parent's
 * allocation as exactly 5 % of the launch supply, so the launch supply is that allocation times twenty; a served
 * `launchSupplyRaw` wins when present. Falls back to the current supply, labelled as such, and to null.
 */
export function launchSupplyRaw(stats,data){
  if(raw(data?.launchSupplyRaw))return {raw:data.launchSupplyRaw,source:'launch'};
  if(raw(stats?.allocationRaw)&&BigInt(stats.allocationRaw)>0n)return {raw:(BigInt(stats.allocationRaw)*20n).toString(),source:'launch'};
  if(raw(data?.supplyRaw))return {raw:data.supplyRaw,source:'current'};
  return {raw:null,source:null};
}

/** SOL value of a token amount at the last trade price: a float estimate for display only, null when either is unknown. */
export function estimateSol(amountRaw,decimals,priceSol){
  const exact=exactUnits(amountRaw,decimals);
  const price=typeof priceSol==='number'?priceSol:typeof priceSol==='string'&&priceSol.trim()!==''?Number(priceSol):NaN;
  if(exact==null||!Number.isFinite(price)||price<=0)return null;
  const value=Number(exact)*price;
  return Number.isFinite(value)?value:null;
}

/** A whole-number count for the stats card: "unknown" when the API could not read it, never 0. */
export function countText(value){
  if(value==null)return 'unknown';
  const n=typeof value==='bigint'?Number(value):Number(value);
  return Number.isFinite(n)&&n>=0?Math.round(n).toLocaleString('en-GB'):'unknown';
}
