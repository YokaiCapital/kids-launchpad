// Alert delivery for the hosted observer: one plain message when the set of alerts (codes and lanes only) changes, a
// reminder every repeatMs while alerts persist, one message on recovery. A Telegram bot URL receives form-encoded
// text; any other https URL receives JSON {content,text} (Discord, Slack). Never a wallet, an endpoint or a credential;
// a failed delivery is logged by category and retried with backoff, and never throws into the caller.
export function alertKey(snapshot){return [...new Set((snapshot?.alerts||[]).map(a=>String(a.code)+'@'+String(a.lane)))].sort().join(',');}
export function formatAlertMessage(snapshot,{label='KIDS public launches',recovered=false}={}){
 const at=snapshot?.observedAt||new Date().toISOString();
 if(recovered)return label+': recovered, no alerts at '+at+'.';
 const groups=new Map();for(const a of snapshot?.alerts||[]){const lanes=groups.get(a.code)||[];lanes.push(String(a.lane));groups.set(String(a.code),lanes);}
 const parts=[...groups].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([code,lanes])=>code+' ('+[...new Set(lanes)].join(', ')+')');
 const total=alertKey(snapshot).split(',').filter(Boolean).length;
 const op=snapshot?.operating||{},extra=[];
 if(op.lowReserves)extra.push(op.lowReserves+' campaign'+(op.lowReserves===1?'':'s')+' with a low operating reserve');
 if(op.unscheduledFunded)extra.push(op.unscheduledFunded+' funded campaign'+(op.unscheduledFunded===1?'':'s')+' without a schedule');
 return label+': '+total+' alert'+(total===1?'':'s')+' at '+at+': '+parts.join('; ')+(extra.length?'. '+extra.join('; ')+'.':'.');
}
export function createAlertDelivery({webhookUrl,fetchImpl=globalThis.fetch,now=Date.now,repeatMs=6*3600000,timeoutMs=10000,label,log=()=>{}}){
 let u;try{u=new URL(webhookUrl);}catch{throw Error('Alert webhook must be a URL');}
 if(u.protocol!=='https:')throw Error('Alert webhook must use https');
 if(!Number.isInteger(repeatMs)||repeatMs<60000)throw Error('Alert repeat interval must be at least one minute');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000)throw Error('Alert delivery timeout must be 1 to 60 seconds');
 const telegram=u.hostname==='api.telegram.org';
 let last={key:'',sentAt:0,failures:0,nextRetryAt:0};
 async function post(text){
  const init=telegram
   ?{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({text}).toString()}
   :{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:text,text})};
  const r=await fetchImpl(webhookUrl,{...init,signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
  if(!r.ok)throw Error('HTTP '+r.status);
 }
 return {
  telegram,
  state(){return {...last};},
  async deliver(snapshot){
   const key=alertKey(snapshot),t=now();
   let reason=null;
   if(key!==last.key)reason=key?'changed':'recovered';
   else if(key&&t-last.sentAt>=repeatMs)reason='reminder';
   if(!reason)return {sent:false,reason:'unchanged'};
   if(last.failures&&t<last.nextRetryAt)return {sent:false,reason:'backoff'};
   const text=formatAlertMessage(snapshot,{label,recovered:!key});
   try{await post(text);last={key,sentAt:t,failures:0,nextRetryAt:0};log({event:'alert-delivered',reason,alerts:(snapshot?.alerts||[]).length});return {sent:true,reason};}
   catch(error){
    const failures=last.failures+1,wait=Math.min(repeatMs,60000*2**Math.min(failures-1,6));
    last={...last,failures,nextRetryAt:t+wait};
    log({event:'alert-delivery-failed',category:error?.name==='TimeoutError'?'timeout':/^HTTP \d+$/.test(String(error?.message))?String(error.message):'network',failures,retryInMs:wait});
    return {sent:false,reason:'failed'};
   }
  }
 };
}
