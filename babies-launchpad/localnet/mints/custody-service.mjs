// Private custody endpoint on the inventory host: co-signs a funding-first launch packet with the reserved mint and fee NFT
// through the trusted adapter (funding-first-custody.mjs) for the keeper's worker, which runs on another service and never
// holds the inventory. Bearer token (32+ characters, compared in constant time), POST /custody/launch only, JSON body of at
// most 8 KiB, a per-minute rate limit; the caller decides the bind address (loopback for a rehearsal, the private network
// when hosted). Answers are typed: 400 malformed, 401 unauthorized, 404, 413, 429 rate limited, 409 refused (the adapter's
// own deterministic refusal, with category stale-fencing-token for a lease that is not current), 503 dependency (RPC or
// registry unavailable). Logs carry the event, stage and a cause class only: never the packet, the keys or the token.
import http from 'node:http';import {timingSafeEqual} from 'node:crypto';
const FIELDS=Object.freeze(['mint','campaign','keeper','packet','lookups','packetRef','operationKey','fencingToken']);
/** The cause class of a refusal (the adapter's and the inventory's own messages mapped to a fixed vocabulary); the raw message
 * never leaves the process, neither in the answer nor in the log. */
const CAUSES=Object.freeze([
 ['lease',/lease is not current|lease expired|Database lease time/i],
 ['custody-binding',/not bound to this campaign|Extension differs from the custody binding|not the reserved key|Mint is not bound|reservation differs|Unknown mint reservation|another wallet, draft/i],
 ['journal',/journaled prepared attempt|journaled for another|not the current one|Previous launch attempt|packet reference|needs the packet/i],
 ['packet-template',/independently rebuilt|planned table|compute limit \+ launch|not a funding-first launch|keeper's v0 packet|lookup table plan|payer of the campaign|signers are not|already carries custody signatures|differs from independently rebuilt|three signers|Invalid funding-first packet|authorized lookup table/i],
 ['display',/opening commitment/i],
 ['record',/not a funding-first record|does not seal this mint|extension unavailable|canonical/i],
 ['custody-journal',/already signed another message|before any signed opening|retain its exact preceding|Invalid bounded|identity mismatch|Stored funding-first signature/i],
 ['key-failure',/authentication failed|quarantined|Mint inventory is closed/i],
]);
const causeClass=error=>{if(error?.code==='STALE_LEASE')return 'lease';const m=String(error?.message||'');return CAUSES.find(([,re])=>re.test(m))?.[0]??'refused';};
export const custodyCauseClass=causeClass;
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
export function createCustodyService({custody,token,maxPerMinute=60,maxBodyBytes=8192,log=()=>{},now=Date.now}){
 if(typeof custody?.signLaunch!=='function')throw Error('Custody service needs the trusted launch custody adapter');
 if(typeof token!=='string'||token.length<32)throw Error('Custody token must be at least 32 characters');
 if(!Number.isInteger(maxPerMinute)||maxPerMinute<1||!Number.isInteger(maxBodyBytes)||maxBodyBytes<512)throw Error('Custody limits must be positive integers');
 const expected=Buffer.from(token),stamps=[];
 const authorized=header=>{const value=Buffer.from(String(header||'').replace(/^Bearer\s+/i,''));return value.length===expected.length&&timingSafeEqual(value,expected);};
 async function handle(req,res){
  if(req.method==='GET'&&req.url==='/healthz')return json(res,200,{status:'ok',custody:true});
  if(req.method==='GET'&&req.url==='/readyz')return json(res,200,{status:'ready'});
  if(req.method!=='POST'||req.url!=='/custody/launch')return json(res,404,{error:'not found'});
  if(!authorized(req.headers.authorization)){log({event:'custody-unauthorized'});return json(res,401,{error:'unauthorized'});}
  const t=now();while(stamps.length&&t-stamps[0]>60000)stamps.shift();
  if(stamps.length>=maxPerMinute){log({event:'custody-rate-limited'});return json(res,429,{error:'rate limited',category:'custody-capacity',retryAfterMs:Math.max(1000,60001-(t-stamps[0]))});}
  stamps.push(t);
  let body='';for await(const chunk of req){body+=chunk;if(body.length>maxBodyBytes)return json(res,413,{error:'too large'});}
  let input;try{input=JSON.parse(body);}catch{return json(res,400,{error:'malformed body'});}
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!FIELDS.includes(k)))return json(res,400,{error:'unexpected fields'});
  for(const k of ['mint','campaign','keeper','packet','operationKey'])if(typeof input[k]!=='string'||!input[k]||input[k].length>2048)return json(res,400,{error:'malformed '+k});
  if(!input.packetRef||typeof input.packetRef!=='object'||typeof input.packetRef.operationId!=='string'||!Number.isSafeInteger(input.packetRef.attempt)||!Number.isSafeInteger(input.fencingToken))return json(res,400,{error:'malformed packet reference'});
  if(input.lookups!==undefined&&input.lookups!==null&&!Array.isArray(input.lookups))return json(res,400,{error:'malformed lookups'});
  try{
   const signed=await custody.signLaunch({mint:input.mint,campaign:input.campaign,keeper:input.keeper,packet:input.packet,lookups:input.lookups??null,packetRef:{operationId:input.packetRef.operationId,attempt:input.packetRef.attempt},operationKey:input.operationKey,fencingToken:input.fencingToken});
   log({event:'custody-signed',step:signed.step,generation:signed.generation,attempt:input.packetRef.attempt});
   return json(res,200,{transactionBase64:signed.transactionBase64,generation:signed.generation,messageSha256:signed.messageSha256,step:signed.step});
  }catch(error){
   // Dependencies answer 503 with no detail: anything flagged as one, and any error that carries a code other than the
   // adapter's own STALE_LEASE (transport, database, capacity and driver codes); a refusal is a plain error from the adapter or
   // the inventory and answers 409 with a cause class only. Unknown coded failures retry rather than fail a launch for good.
   if(error?.dependency||(error?.code!==undefined&&error?.code!==null&&error.code!=='STALE_LEASE')){log({event:'custody-dependency',code:typeof error?.code==='string'||typeof error?.code==='number'?String(error.code).slice(0,32):null});return json(res,503,{error:'custody dependency unavailable',category:'custody-dependency'});}
   const cause=causeClass(error);
   log({event:'custody-refused',cause,attempt:input.packetRef.attempt});
   return json(res,409,{error:'custody refused ('+cause+')',category:error?.code==='STALE_LEASE'?'stale-fencing-token':'custody-refused',cause});
  }
 }
 const server=http.createServer((req,res)=>{handle(req,res).catch(()=>json(res,500,{error:'custody error'}));});
 server.headersTimeout=5000;server.requestTimeout=10000;
 return {server,listen:(port,host='127.0.0.1')=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve(server.address());});}),close:()=>new Promise(resolve=>server.close(()=>resolve()))};
}
