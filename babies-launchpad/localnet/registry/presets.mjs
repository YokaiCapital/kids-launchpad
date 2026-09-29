// Terms manifest for public launches (deployment/presets/public-presets-v1.json) and its canonical hash. The hash is
// sha256 over canonical JSON (sorted keys, no whitespace), so it does not move when someone reformats the file and it
// does move on any value change: an activation record names the exact hash it approves.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {canonicalJson,canonicalHash} from './canonical.mjs';
export {canonicalJson,canonicalHash};
export const PRESETS_PATH=fileURLToPath(new URL('../../deployment/presets/public-presets-v1.json',import.meta.url));
export const PRESET_STATUSES=Object.freeze(['proposed','active','retired','unresolved']);
const DECIMAL=/^\d{1,20}$/,BPS_TOTAL=10000;
export function readPresets(path=PRESETS_PATH){return JSON.parse(readFileSync(path,'utf8'));}
/** sha256 hex of the manifest's canonical JSON. */
export function presetsHash(manifest){return canonicalHash(manifest);}
const sum=o=>Object.values(o).reduce((a,b)=>a+b,0);
/** Returns the list of problems (empty when the manifest is consistent): splits and routings sum exactly, caps are decimal
 * strings with soft <= hard, statuses are known, nothing proposed carries an activation and nothing active lacks one. */
export function validatePresets(m){
 const problems=[];
 if(hasFutureLiquidityPolicy(m))problems.push('liquidityPolicy requires a new manifest and program version');
 if(m?.schemaVersion!==1)problems.push('schemaVersion must be 1');
 if(typeof m?.policyVersion!=='string'||!m.policyVersion)problems.push('policyVersion missing');
 const statusOf=(name,item)=>{if(!PRESET_STATUSES.includes(item?.status))problems.push(name+': unknown status');else if(item.status==='active'&&!item.activation)problems.push(name+': active without an activation record');else if(item.status!=='active'&&item.activation)problems.push(name+': activation record on a non-active item');};
 statusOf('manifest',m);
 for(const [name,mode] of Object.entries(m?.modes||{})){
  statusOf('mode '+name,mode);
  const split=mode?.supplySplitBps||{};if(Object.values(split).some(v=>!Number.isInteger(v)||v<0)||sum(split)!==BPS_TOTAL)problems.push('mode '+name+': supply split must sum to '+BPS_TOTAL+' bps');
  const r=mode?.solFeeRouting||{};const shares=Object.entries(r).filter(([k])=>k!=='denominator');if(!Number.isInteger(r.denominator)||r.denominator<1||shares.some(([,v])=>!Number.isInteger(v)||v<0)||shares.reduce((a,[,v])=>a+v,0)!==r.denominator)problems.push('mode '+name+': fee routing shares must sum to the denominator');
  if(name==='standard'&&(mode?.parents!==0||'parentA' in split))problems.push('standard mode must not carry parents');
 }
 if(!Array.isArray(m?.capPresets)||!m.capPresets.length)problems.push('capPresets missing');
 const ids=new Set();
 for(const p of m?.capPresets||[]){
  statusOf('cap preset '+p?.id,p);if(ids.has(p?.id))problems.push('cap preset id repeated: '+p.id);ids.add(p?.id);
  if(!DECIMAL.test(p?.softCapLamports||'')||!DECIMAL.test(p?.hardCapLamports||''))problems.push('cap preset '+p?.id+': caps must be decimal strings');
  else if(BigInt(p.softCapLamports)<=0n||BigInt(p.softCapLamports)>BigInt(p.hardCapLamports))problems.push('cap preset '+p.id+': soft cap must be positive and at most the hard cap');
  if(p?.pilotOnly!==undefined&&(p.pilotOnly!==true||p.advanced!==true))problems.push('cap preset '+p?.id+': pilotOnly must be true and advanced');
 }
 if(m?.schedule){statusOf('schedule',m.schedule);for(const k of ['fundingDurationSeconds','launchWindowSeconds'])if(!Number.isInteger(m.schedule[k])||m.schedule[k]<60)problems.push('schedule: '+k+' must be at least 60 seconds');}
 if(m?.platformCreationCharge){statusOf('platformCreationCharge',m.platformCreationCharge);if(!DECIMAL.test(m.platformCreationCharge.lamports||''))problems.push('platformCreationCharge: lamports must be a decimal string');}
 if(m?.agreed?.operating){
  const o=m.agreed.operating;statusOf('operating',o);
  if(!DECIMAL.test(o.reserveLamports||'')||!DECIMAL.test(o.floorLamports||''))problems.push('operating: reserveLamports and floorLamports must be decimal strings');
  else if(BigInt(o.reserveLamports)<=0n||BigInt(o.floorLamports)>BigInt(o.reserveLamports))problems.push('operating: the reserve must be positive and the floor at most the reserve');
  if(!Number.isInteger(o.refillBps)||o.refillBps<0||o.refillBps>BPS_TOTAL)problems.push('operating: refillBps must be an integer between 0 and '+BPS_TOTAL);
  if(typeof o.returnUnusedOnRefund!=='boolean')problems.push('operating: returnUnusedOnRefund must be true or false');
 }
 return problems;
}
/** Items a creator could actually use today: only those with status 'active' and an activation record (none in v1). */
export function activatedPresets(m){
 if(hasFutureLiquidityPolicy(m))return [];
 if(m?.status!=='active'||!m.activation)return [];
 return (m.capPresets||[]).filter(p=>p.status==='active'&&p.activation).map(p=>p.id);
}
/** The term set a campaign would seal from one mode and one cap preset, and its hash (what CampaignVNext's terms hash
 * would cover from the preset side; network, creator, nonce, dates and metadata are added at sealing time). */
function hasFutureLiquidityPolicy(m){return [m,m?.agreed,m?.agreed?.liquidity,...Object.values(m?.modes||{}),...(m?.capPresets||[])].some(v=>v&&Object.hasOwn(v,'liquidityPolicy'));}
export function presetTerms(m,selection){
 if(hasFutureLiquidityPolicy(m)||Object.hasOwn(selection,'liquidityPolicy'))throw Error('liquidityPolicy requires a new manifest and program version');
 const {mode,capPresetId,pilot=false}=selection;
 const modeSpec=m?.modes?.[mode];if(!modeSpec)throw Error('Unknown mode '+mode);
 const cap=(m.capPresets||[]).find(p=>p.id===capPresetId);if(!cap)throw Error('Unknown cap preset '+capPresetId);
 // A pilot-only preset (owner, 27 September 2026) exists for the wallet-restricted pilot and nowhere else.
 if(cap.pilotOnly&&pilot!==true)throw Error('Cap preset '+capPresetId+' is available only in the wallet-restricted pilot');
 const terms={policyVersion:m.policyVersion,mode,parents:modeSpec.parents,supplySplitBps:modeSpec.supplySplitBps,solFeeRouting:modeSpec.solFeeRouting,softCapLamports:cap.softCapLamports,hardCapLamports:cap.hardCapLamports,fundingDurationSeconds:m.schedule.fundingDurationSeconds,launchWindowSeconds:m.schedule.launchWindowSeconds,feePolicy:{ammProgram:m.agreed.feePolicy.ammProgram,ammConfig:m.agreed.feePolicy.ammConfig,ammConfigIndex:m.agreed.feePolicy.ammConfigIndex,tradeFeeBps:m.agreed.feePolicy.tradeFeeBps,creatorFeeEnabled:m.agreed.feePolicy.creatorFeeEnabled},devVesting:{immediateBps:m.agreed.devSupply.immediateBps,linearBps:m.agreed.devSupply.linearBps,vestingMonths:m.agreed.devSupply.vestingMonths},tokenSideFees:m.agreed.tokenSideFees,platformCreationChargeLamports:m.platformCreationCharge.lamports,operating:m.agreed.operating?{reserveLamports:m.agreed.operating.reserveLamports,floorLamports:m.agreed.operating.floorLamports,refillBps:m.agreed.operating.refillBps,returnUnusedOnRefund:m.agreed.operating.returnUnusedOnRefund}:null};
 return {terms,termsHash:canonicalHash(terms),status:[m.status,modeSpec.status,cap.status,m.schedule.status].every(s=>s==='active')?'active':'proposed'};
}
