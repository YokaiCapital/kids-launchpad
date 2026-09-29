export const PRELAUNCH={poolUsd:200000,softPoolUsd:40000,softCap:100000000000n,solSideUsd:100000,exampleSolUsd:200,cap:500000000000n,otherCommitments:750000000000n};
export function parseSol(value){
  if(typeof value!=='string'||!/^\d{1,7}(\.\d{1,9})?$/.test(value))throw Error('Enter SOL with up to 9 decimal places.');
  const [whole,fraction='']=value.split('.');const amount=BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'));
  if(amount<=0n||amount>1000000000000n)throw Error('Demo commitment must be above 0 and no more than 1,000 SOL.');return amount;
}
export function sol(value){const n=BigInt(value);return `${n/1000000000n}.${String(n%1000000000n).padStart(9,'0')}`.replace(/\.?0+$/,'');}
export function allocation(committed,others=PRELAUNCH.otherCommitments,cap=PRELAUNCH.cap){
  const amount=BigInt(committed),total=amount+others;
  const retained=total>cap?amount*cap/total:amount;
  return {total,retained,refund:amount-retained,filled:total>=cap};
}
export const emptyPrelaunch={committed:'0',phase:'open',refundClaimed:false};
