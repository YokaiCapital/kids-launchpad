// Server-only, authenticated context for the private staging reverse proxy.
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
const loopback=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const origin='https://kids.fun',cache=new WeakMap(),seen=new Map();
const mac=(secret,method,path,stamp,nonce,role)=>createHmac('sha256',secret).update(JSON.stringify([method,path,origin,stamp,nonce,role])).digest('hex');
export function gatewayHeaders(method,path,role,secret,now=Date.now()){
 if(typeof secret!=='string'||secret.length<32||!['viewer','operator','community'].includes(role))throw Error('Gateway signing is not configured');
 const stamp=String(now),nonce=randomBytes(24).toString('hex');return {'x-kids-gateway-time':stamp,'x-kids-gateway-nonce':nonce,'x-kids-gateway-role':role,'x-kids-gateway-signature':mac(secret,method,path,stamp,nonce,role)};
}
export function trustedGatewayContext(req,{port=4175,secret=process.env.KIDS_GATEWAY_INTERNAL_TOKEN,now=Date.now()}={}){
 if(cache.has(req))return cache.get(req);
 if(!loopback.has(req.socket?.remoteAddress)||!['127.0.0.1:'+port,'localhost:'+port,'[::1]:'+port].includes(req.headers?.host)||typeof secret!=='string'||secret.length<32)return null;
 const h=req.headers,stamp=h['x-kids-gateway-time'],nonce=h['x-kids-gateway-nonce'],role=h['x-kids-gateway-role'],signature=h['x-kids-gateway-signature'];
 if(typeof stamp!=='string'||!/^\d{13}$/.test(stamp)||Math.abs(now-Number(stamp))>15000||typeof nonce!=='string'||!/^[a-f0-9]{48}$/.test(nonce)||!['viewer','operator','community'].includes(role)||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||h.origin!==origin)return null;
 if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(mac(secret,req.method,req.url,stamp,nonce,role),'hex')))return null;
 for(const [key,time] of seen)if(now-time>30000)seen.delete(key);
 if(seen.has(nonce)||seen.size>=4096)return null;seen.set(nonce,now);
 const context=Object.freeze({origin,operator:role==='operator',community:role==='community'});cache.set(req,context);return context;
}

const localOnlyFinancial=new Set(['/api/account/postlaunch/claim','/api/account/postlaunch/trade/execute','/api/account/dev-vesting/claim']);
export function gatewayFinancialDenied(context,path,owner,wallets={}){
 if(!context||context.operator)return false;
 if(localOnlyFinancial.has(path))return true;
 const financial=/^\/api\/account\/(?:prelaunch(?:-legacy)?\/(?:prepare|submit)|postlaunch\/trade\/quote)$/.test(path);
 return financial&&[wallets?.alice,wallets?.bob].some(value=>typeof value==='string'&&value===owner);
}
