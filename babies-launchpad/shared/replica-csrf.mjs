import {createHmac,timingSafeEqual} from 'node:crypto';
// Stateless CSRF for load-balanced API replicas. Requires the same server-only secret on each replica.
// Origin checks remain mandatory. Sign-in sessions are verified separately; this grants no wallet authority.
export function createReplicaCsrf({secret,clock=Date.now,ttlMs=7200000}){
 if(typeof secret!=='string'||! /^[a-f0-9]{64,128}$/i.test(secret))throw Error('KIDS_CSRF_SECRET must be 32..64 random bytes encoded as hex');
 const key=Buffer.from(secret,'hex');
 const mac=(origin,expires)=>createHmac('sha256',key).update('kids-csrf-v1\n'+origin+'\n'+expires).digest('hex');
 return {
  issue(origin){const expires=String(clock()+ttlMs);return expires+'.'+mac(origin,expires);},
  verify(token,origin){
   if(typeof token!=='string'||! /^\d{13}\.[a-f0-9]{64}$/.test(token))return false;
   const [expires,signature]=token.split('.'),n=Number(expires);
   if(n<=clock()||n>clock()+ttlMs)return false;
   return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(mac(origin,expires),'hex'));
  }
 };
}
