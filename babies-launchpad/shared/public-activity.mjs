// Public Standard v3 activity transport. No signer, database or RPC dependencies.
export const ACTIVITY_KINDS=Object.freeze(['campaign-init','commit','finalize','refund','settle','ready','launch','claim-participant','claim-dev','fees-init','fees-collect','fees-operator','fees-distribute','burn-child','setup-return','authority-revoked','program-attempt']);
export const ACTIVITY_FILTERS=Object.freeze(['movements','all','failed']);
const address=s=>typeof s==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
export function validatePublicEvent(e){
 if(!e||!address(e.campaign)||!ACTIVITY_KINDS.includes(e.kind)||!['launch','token'].includes(e.program)||!Number.isSafeInteger(e.slot)||e.slot<1||!Number.isSafeInteger(e.blockTimeUnix)||e.blockTimeUnix<1||typeof e.signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(e.signature)||!/^\d{1,4}(\.\d{1,4})?$/.test(e.instructionPath)||e.decoderVersion!==3||typeof e.failed!=='boolean'||typeof e.nested!=='boolean'||e.actor!==null&&!address(e.actor))throw Error('Invalid finalized activity');
 if(e.amountsUnresolved!==undefined&&typeof e.amountsUnresolved!=='boolean'||e.detail!=null&&(typeof e.detail!=='string'||e.detail.length>200)||!Array.isArray(e.assets)||e.assets.length>64||e.failed&&e.assets.length)throw Error('Invalid activity detail');
 for(const a of e.assets)if(!a||a.mint!=='SOL'&&!address(a.mint)||typeof a.amountRaw!=='string'||!/^\d{1,20}$/.test(a.amountRaw)||BigInt(a.amountRaw)>18446744073709551615n||!Number.isInteger(a.decimals)||a.decimals<0||a.decimals>18||!['in','out','burn'].includes(a.direction)||a.role!=null&&!['pool','lock','treasury','dev','creator'].includes(a.role)||a.account!=null&&!address(a.account))throw Error('Invalid activity asset');
}
export const hasMovement=e=>e.amountsUnresolved===true||e.assets.some(a=>BigInt(a.amountRaw)>0n);
