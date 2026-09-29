// In-memory emulation of one kids-launch-v2 campaign for the job handlers and the recovery drill: the same integer
// rules as policy.mjs (accepted, refundable), the same once-per-receipt settle and cumulative idempotent refund the
// program enforces, plus crash and ambiguity injection. No network, no keys, no real program. Every mutation is
// recorded as a "transaction" with a signature so a job can be reconciled by signature after a crash.
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {accepted,refundable,launchFailed,launchReady,PHASE_FUNDING,PHASE_CLOSED,PHASE_REFUND_ONLY,PHASE_LIVE} from './policy.mjs';
const sig=(...parts)=>{const h=createHash('sha256').update(parts.join('|')).digest();return new PublicKey(h).toBase58()+new PublicKey(createHash('sha256').update(h).digest()).toBase58();};
export const address=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
/**
 * terms: {soft, hard, deadline, launchDeadline} (BigInt-compatible). commitments: [{owner, committed}].
 * hooks (optional, set later): crashAfterSettle / crashAfterRefund = n makes the process "die" once n operations landed:
 * the call never returns (a dead process sends no reply and renews no lease); ambiguous.add(receipt) makes the next send
 * for that receipt land but answer unknown; truncateList drops the last receipt from the page (complete:false).
 */
export function createChainEmulation({identity,terms,commitments=[],now}){
 const state={phase:PHASE_FUNDING,total:0n,refunded:0n,receiptCount:0n,settledCount:0n,settledAccepted:0n,slot:1000};
 const receipts=new Map(),transactions=new Map(),calls={settle:0,refund:0,list:0,read:0,landedSettle:0,landedRefund:0};
 const hooks={crashAfterSettle:null,crashAfterRefund:null,ambiguous:new Set(),truncateList:false,failRead:false,ambiguousLaunch:false,failVerify:false};
 for(const [i,c] of commitments.entries()){const addr=address(i+1);receipts.set(addr,{address:addr,owner:c.owner||address(100+i),committed:BigInt(c.committed),accepted:0n,refunded:0n,settled:false});state.total+=BigInt(c.committed);state.receiptCount+=1n;}
 const tick=()=>{state.slot+=1;return state.slot;};
 const land=(kind,receipt,fn)=>{
  const slot=tick(),signature=sig(kind,receipt.address,slot);
  const outcome=fn();
  transactions.set(signature,{kind,receipt:receipt.address,slot,status:outcome.error?'failed':'confirmed',error:outcome.error||null});
  if(outcome.error)return {status:'failed',signature,error:outcome.error};
  if(hooks.ambiguous.has(receipt.address)){hooks.ambiguous.delete(receipt.address);return {status:'unknown',signature};}
  return {status:'confirmed',signature};
 };
 const snapshot=()=>({address:identity.campaign,pool:state.pool??null,feeNft:state.feeNft??null,launchTime:state.launchTime??0n,phase:state.phase,deadline:terms.deadline,launchDeadline:terms.launchDeadline,soft:terms.soft,hard:terms.hard,total:state.total,refunded:state.refunded,receiptCount:state.receiptCount,settledCount:state.settledCount,settledAccepted:state.settledAccepted,slot:state.slot});
 const chain={
  identity,state,receipts,transactions,calls,hooks,
  async readCampaign(){calls.read++;if(hooks.failRead)throw Object.assign(Error('fetch failed'),{code:'ECONNRESET'});return snapshot();},
  async listReceipts(){calls.list++;const all=[...receipts.values()].map(r=>({...r}));if(hooks.truncateList)return {receipts:all.slice(0,Math.max(0,all.length-1)),complete:false,slot:state.slot};return {receipts:all,complete:true,slot:state.slot};},
  async settle(id,r){
   calls.settle++;const receipt=receipts.get(r.address);if(!receipt)throw Error('Invalid receipt');
   const out=land('settle',receipt,()=>{
    const t=BigInt(Math.floor(now()/1000));if(t<BigInt(terms.deadline))return {error:'custom program error: 0x5 funding open'};
    if(receipt.settled)return {error:'custom program error: 0x12 AlreadySettled'};
    const failed=launchFailed(state.phase,state.total,terms.soft,terms.launchDeadline,t);
    receipt.accepted=failed?0n:accepted(receipt.committed,state.total,terms.hard);receipt.settled=true;state.settledCount+=1n;state.settledAccepted+=receipt.accepted;calls.landedSettle++;
    if(state.phase===PHASE_FUNDING)state.phase=failed?PHASE_REFUND_ONLY:PHASE_CLOSED;
    return {};
   });
   if(hooks.crashAfterSettle!==null&&calls.landedSettle>=hooks.crashAfterSettle){hooks.crashAfterSettle=null;calls.crashes=(calls.crashes||0)+1;return new Promise(()=>{});}
   return out;
  },
  async refund(id,r){
   calls.refund++;const receipt=receipts.get(r.address);if(!receipt)throw Error('Invalid receipt');
   const out=land('refund',receipt,()=>{
    const t=BigInt(Math.floor(now()/1000));if(t<BigInt(terms.deadline))return {error:'custom program error: 0x5 funding open'};
    const failed=launchFailed(state.phase,state.total,terms.soft,terms.launchDeadline,t);
    if(!failed&&!receipt.settled)return {error:'custom program error: 0x13 NotSettled'};
    const due=refundable(receipt.committed,state.total,terms.hard,failed)-receipt.refunded;
    if(due<=0n)return {error:'custom program error: 0x14 NothingToRefund'};
    receipt.refunded+=due;state.refunded+=due;calls.landedRefund++;return {};
   });
   if(hooks.crashAfterRefund!==null&&calls.landedRefund>=hooks.crashAfterRefund){hooks.crashAfterRefund=null;calls.crashes=(calls.crashes||0)+1;return new Promise(()=>{});}
   return out;
  },
  async signatureStatus(signature){const t=transactions.get(signature);if(!t)return {status:'expired'};return {status:t.status};},
  async assertReady(){const t=BigInt(Math.floor(now()/1000));const ready=launchReady({...snapshot()},t);return {ready,reason:ready?'ready':'not ready: settled '+state.settledCount+' of '+state.receiptCount+', accepted '+state.settledAccepted+' vs soft '+String(terms.soft)+', phase '+state.phase,live:state.phase===PHASE_LIVE,failed:launchFailed(state.phase,state.total,terms.soft,terms.launchDeadline,t)};},
  /** Tag 6 emulated: refused unless ready (as the program refuses before any CPI); lands as one transaction. */
  async launch(){
   calls.launch=(calls.launch||0)+1;const t=BigInt(Math.floor(now()/1000));
   const slot=tick(),signature=sig('launch',identity.campaign,slot);
   if(!launchReady({...snapshot()},t)){transactions.set(signature,{kind:'launch',slot,status:'failed',error:'custom program error: 0xc not ready'});return {status:'failed',signature,error:'custom program error: 0xc not ready'};}
   state.phase=PHASE_LIVE;state.launchTime=t;state.pool=address(240);state.feeNft=address(241);calls.landedLaunch=(calls.landedLaunch||0)+1;
   transactions.set(signature,{kind:'launch',slot,status:'confirmed',error:null});
   if(hooks.ambiguousLaunch){hooks.ambiguousLaunch=false;return {status:'unknown',signature};}
   return {status:'confirmed',signature,pool:state.pool,feeNft:state.feeNft};
  },
  async verifyLaunch(){const ok=state.phase===PHASE_LIVE&&!hooks.failVerify;return {ok,failures:ok?[]:['phase '+state.phase+(hooks.failVerify?' verification injected failure':'')],checks:{}};},
 };
 return chain;
}
