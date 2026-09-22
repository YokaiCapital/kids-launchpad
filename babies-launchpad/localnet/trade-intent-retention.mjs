import {intentHistorySize} from '../shared/intent-retention.mjs';
// Only unissued, expired quotes are safe to forget: no transaction ever reached a wallet.
// Prepared messages can be submitted directly, so keep them until chain reconciliation.
export function pruneUnissuedTradeQuotes(intents,now,isPreparing=()=>false){
 let removed=0;
 for(const [id,intent] of Object.entries(intents)){
  if(!isPreparing(id)&&!intent.executionMode&&Number.isFinite(intent.expiresAt)&&now>intent.expiresAt&&!intent.unsignedTransactionBase64&&!intent.signed&&!intent.signature&&!intent.confirmed){delete intents[id];removed++;}
 }
 return removed;
}
export function reserveTradeIntentSlot(intents,inflight,owner,{perOwner=20,total=10000}={}){
 const rows=Object.values(intents),pending=rows.filter(i=>i.owner===owner&&!i.confirmed).length;
 if(pending+(inflight.get(owner)||0)>=perOwner)throw Error('Too many pending trade requests for this wallet. Finish or reconcile existing requests first.');
 if(intentHistorySize(intents)+[...inflight.values()].reduce((a,b)=>a+b,0)>=total)throw Error('Trade intent history is full');
 inflight.set(owner,(inflight.get(owner)||0)+1);let released=false;
 return()=>{if(released)return;released=true;const n=(inflight.get(owner)||0)-1;if(n)inflight.set(owner,n);else inflight.delete(owner);};
}
