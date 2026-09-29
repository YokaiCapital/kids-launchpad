// A missing signature is not proof of failure after an RPC has pruned history.
// Finalized expiry plus two history lookups is sufficient only while the whole
// signing window remains retained. Unknown evidence stays pending.
export async function signedPacketOutcome(connection,packet){
 if(!packet.signature)throw Error('A signed packet is required');
 const lookup=async()=>{
  const reply=await connection.getSignatureStatuses([packet.signature],{searchTransactionHistory:true});
  if(!Array.isArray(reply?.value)||reply.value.length!==1)throw Error('Signature history unavailable');
  return reply.value[0];
 };
 const classify=result=>result?(['confirmed','finalized'].includes(result.confirmationStatus)?{status:result.err?'failed':result.confirmationStatus,error:result.err?'Transaction failed on chain':null}:{status:'submitted'}):null;
 const initial=await lookup();if(initial)return classify(initial);
 const height=await connection.getBlockHeight('finalized');
 if(!Number.isSafeInteger(height)||!Number.isSafeInteger(packet.prepared.lastValidBlockHeight)||height<=packet.prepared.lastValidBlockHeight)return null;
 const observed=packet.prepared.observedSlot;
 if(!Number.isSafeInteger(observed)||observed<1||typeof connection.getFirstAvailableBlock!=='function')return null;
 const retained=async()=>{const first=await connection.getFirstAvailableBlock();return Number.isSafeInteger(first)&&first>=0&&first<=observed;};
 if(!await retained())return null;
 const again=await lookup();if(again)return classify(again);
 if(!await retained())return null;
 return {status:'expired',error:'Transaction expired without confirmation'};
}
