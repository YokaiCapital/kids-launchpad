import {SITE_NETWORK} from './network-label.mjs';
const raw=value=>{if(typeof value!=='string'||!/^\d+$/.test(value))throw Error('Incomplete escrow balances. Refresh to retry.');return BigInt(value);};
export function validatePrelaunchState(value){
 if(value?.configured===false)return value;
 if(value?.configured!==true||value.network!==SITE_NETWORK||!value.genesisHash||!['open','awaiting-launch','failed','launched'].includes(value.phase))throw Error('Localnet escrow state is unavailable.');
 for(const field of ['totalLamports','softCapLamports','hardCapLamports'])raw(value[field]);
 if(raw(value.softCapLamports)<=0n||raw(value.hardCapLamports)<raw(value.softCapLamports))throw Error('Invalid escrow caps.');
 if(!Number.isSafeInteger(value.deadlineUnix)||!Number.isFinite(value.poolSoftUsd)||!Number.isFinite(value.poolHardUsd))throw Error('Incomplete escrow launch terms.');
 if(value.user)for(const field of ['committedLamports','acceptedLamports','refundableLamports','refundedLamports'])raw(value.user[field]);
 return value;
}
export function chainAllocation(state,added=0n){
 const committed=BigInt(state.user?.committedLamports||'0')+added,total=BigInt(state.totalLamports)+added,cap=BigInt(state.hardCapLamports);
 const retained=state.phase==='failed'?0n:total>cap?committed*cap/total:committed;
 return {total,retained,refund:committed-retained,committed};
}
export function parseCommitment(value){
 if(typeof value!=='string'||!/^\d{1,10}(\.\d{1,9})?$/.test(value))throw Error('Enter a positive SOL amount with up to 9 decimals.');
 const [whole,fraction='']=value.split('.'),lamports=BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'));
 if(lamports<=0n||lamports>18446744073709551615n)throw Error('Enter a valid positive SOL amount.');return lamports;
}
