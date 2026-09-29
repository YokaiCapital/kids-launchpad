// Hard partitions intentionally do not borrow another lane's unused capacity. The
// sum of lane rates/bursts is bounded by the upstream contract. Adding replicas
// never multiplies their quota. Configuration belongs to trusted service roles.
import {canonicalJson} from './canonical.mjs';
const name=/^[a-z][a-z0-9-]{0,63}$/,MICRO=1000000n;
// Millirequests/second support small reserved shares under the existing 60/min
// signer limit. Convert to integer microtokens/ms before any refill arithmetic.
const rateUnits=rate=>Math.round(rate*1000);
function limits(value){if(!value||typeof value.ratePerSecond!=='number'||!/^\d+(\.\d{1,3})?$/.test(String(value.ratePerSecond))||value.ratePerSecond<0.001||value.ratePerSecond>1000000||!Number.isInteger(value.burst)||value.burst<1||value.burst>1000000)throw Error('Admission needs positive bounded rate (up to three decimals) and burst');return {ratePerSecond:value.ratePerSecond,burst:value.burst};}
export function validateAdmissionPolicy(policy){
 const global=limits(policy),lanes={};let rates=0,bursts=0;
 if(!policy.lanes||typeof policy.lanes!=='object'||Array.isArray(policy.lanes)||Object.keys(policy.lanes).length>32)throw Error('Admission needs explicit lane partitions');
 for(const [lane,value] of Object.entries(policy.lanes)){
  if(!name.test(lane))throw Error('Invalid admission lane');
  lanes[lane]=limits(value);rates+=rateUnits(value.ratePerSecond);bursts+=value.burst;
 }
 if(!Object.keys(lanes).length||rates>rateUnits(global.ratePerSecond)||bursts>global.burst)throw Error('Lane allocations exceed global upstream capacity');
 return {...global,lanes};
}
export function admissionDecision({bucket=null,limit,cost=1,now}){
 limits(limit);
 if(!Number.isSafeInteger(now)||now<0)throw Error('Admission clock unavailable');
 if(!Number.isInteger(cost)||cost<1||cost>limit.burst)throw Error('Admission cost exceeds lane burst');
 const capacity=BigInt(limit.burst)*MICRO,rate=BigInt(rateUnits(limit.ratePerSecond));
 const previous=bucket?Number(bucket.updated_ms):now;
 if(!Number.isSafeInteger(previous)||previous<0)throw Error('Invalid admission bucket clock');
 const at=Math.max(now,previous),elapsed=BigInt(at-previous);
 const old=bucket?BigInt(bucket.tokens_micro):capacity;
 if(old<0n||old>capacity)throw Error('Invalid admission token balance');
 const added=old+elapsed*rate,tokens=added>capacity?capacity:added,needed=BigInt(cost)*MICRO;
 const allowed=tokens>=needed,remaining=allowed?tokens-needed:tokens;
 return {tokensMicro:remaining.toString(),updatedMs:at,result:{allowed,remaining: Number(remaining/MICRO),retryAfterMs:allowed?0:Number((needed-tokens+rate-1n)/rate)+Math.max(0,previous-now)}};
}
const getPolicy='SELECT policy_json FROM admission_policies WHERE resource=?';
const addPolicy='INSERT INTO admission_policies(resource,policy_json) VALUES(?,?) ON CONFLICT(resource) DO NOTHING';
const getBucket='SELECT tokens_micro,updated_ms FROM admission_buckets WHERE resource=? AND lane=?';
const putBucket='INSERT INTO admission_buckets(resource,lane,tokens_micro,updated_ms) VALUES(?,?,?,?) ON CONFLICT(resource,lane) DO UPDATE SET tokens_micro=excluded.tokens_micro,updated_ms=excluded.updated_ms';
function inputOf({resource,lane,policy,cost=1}){
 if(!name.test(resource||'')||!name.test(lane||''))throw Error('Invalid admission resource or lane');
 const normalized=validateAdmissionPolicy(policy);if(!Object.hasOwn(normalized.lanes,lane))throw Error('Lane has no reserved upstream capacity');const limit=normalized.lanes[lane];
 if(!Number.isInteger(cost)||cost<1||cost>limit.burst)throw Error('Admission cost exceeds lane burst');
 return {resource,lane,limit,cost,policyJson:canonicalJson(normalized)};
}
const assertPolicy=(row,x)=>{if(row?.policy_json!==x.policyJson)throw Object.assign(Error('Upstream admission policy differs across services'),{code:'ADMISSION_POLICY_CONFLICT'});};
export function admissionApi(driver,{async=false,now=Date.now}={}){
 if(async)return {async consume(input){
  const x=inputOf(input);
  return driver.transaction(async()=>{
   await driver.run(addPolicy,[x.resource,x.policyJson]);assertPolicy(await driver.get(getPolicy,[x.resource]),x);
   const bucket=await driver.get(getBucket,[x.resource,x.lane]);
   // All PostgreSQL replicas use the DATABASE clock, never their host clocks.
   const at=Number((await driver.get('SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms',[])).ms);
   const d=admissionDecision({bucket,limit:x.limit,cost:x.cost,now:at});
   await driver.run(putBucket,[x.resource,x.lane,d.tokensMicro,d.updatedMs]);return d.result;
  },{lockKey:'admission:'+x.resource+':'+x.lane});
 }};
 return {consume(input){
  const x=inputOf(input);
  return driver.transaction(()=>{
   driver.run(addPolicy,[x.resource,x.policyJson]);assertPolicy(driver.get(getPolicy,[x.resource]),x);
   const d=admissionDecision({bucket:driver.get(getBucket,[x.resource,x.lane]),limit:x.limit,cost:x.cost,now:now()});
   driver.run(putBucket,[x.resource,x.lane,d.tokensMicro,d.updatedMs]);return d.result;
  });
 }};
}
