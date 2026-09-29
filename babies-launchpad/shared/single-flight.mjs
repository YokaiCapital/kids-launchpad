// Coalesce concurrent read requests and briefly cache successful results only.
export function singleFlight(read,{ttlMs=2000,now=Date.now}={}){
 let inFlight=null,cached,expires=0;
 return async function(){
  if(cached!==undefined&&now()<expires)return cached;
  if(inFlight)return inFlight;
  inFlight=Promise.resolve().then(read).then(value=>{cached=value;expires=now()+ttlMs;return value;}).finally(()=>{inFlight=null;});
  return inFlight;
 };
}
