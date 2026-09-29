// The keeper worker's client of the private custody endpoint: `coSign(tx, ref)` exactly as the durable sender expects (the
// `custody` option of jobs/service.mjs). It sends only what the adapter needs (the packet with empty custody slots, the pinned
// lookups, the journal reference, the job's operation key and fencing token) and checks the answer before it is used: the
// same message bytes, the custody slots signed by the mint and fee NFT the reference names, the keeper slot untouched.
// A 503 or 429 answer is a dependency failure (transient; the runner retries); a 409 answer is a typed refusal: STALE_LEASE
// for a lease that is not current, CUSTODY_REFUSED otherwise (deterministic: nothing is resent blind).
import {VersionedTransaction} from '@solana/web3.js';import {verify,createPublicKey} from 'node:crypto';
const spki=k=>createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(k.toBytes())]),format:'der',type:'spki'});
export function createCustodyClient({url,token,fetchImpl=globalThis.fetch,timeoutMs=15000,admit=null}){
 if(typeof url!=='string'||!/^https?:\/\//.test(url))throw Error('Custody URL required');
 if(typeof token!=='string'||token.length<32)throw Error('Custody token must be at least 32 characters');
 if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw Error('Custody timeout must be 100..60000 ms');
 const endpoint=url.replace(/\/$/,'')+'/custody/launch';
 return {kind:'remote',async coSign(tx,ref){
  for(const k of ['mint','feeNft','campaign','keeper','operationId','operationKey'])if(typeof ref?.[k]!=='string'||!ref[k])throw Error('Custody reference needs '+k);
  if(!Number.isSafeInteger(ref.attempt)||ref.attempt<1||!Number.isSafeInteger(ref.fencingToken))throw Error('Custody reference needs the attempt and the fencing token');
  // Structural check (a class identity check breaks across two installed copies of web3.js): a prepared v0 transaction.
  if(typeof tx?.serialize!=='function'||typeof tx?.message?.serialize!=='function'||!Array.isArray(tx.signatures))throw Error('Custody co-signing needs the prepared transaction');
  const message=Buffer.from(tx.message.serialize());
  if(admit)await admit({cost:1});
  const r=await fetchImpl(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({mint:ref.mint,campaign:ref.campaign,keeper:ref.keeper,packet:Buffer.from(tx.serialize()).toString('base64'),lookups:ref.lookups??null,packetRef:{operationId:ref.operationId,attempt:ref.attempt},operationKey:ref.operationKey,fencingToken:ref.fencingToken}),signal:AbortSignal.timeout(timeoutMs)});
  if(!r.ok){
   const body=await r.json().catch(()=>null),e=Error('Custody refused the request ('+r.status+')'+(body?.error?': '+body.error:''));
   e.status=r.status;e.category=body?.category??null;
   if(r.status===503||r.status===429||r.status>=500)e.dependency='failure';
   else if(r.status===409&&body?.category==='stale-fencing-token')e.code='STALE_LEASE';
   else if(r.status===409)e.code='CUSTODY_REFUSED';
   else if(r.status===401||r.status===403)e.code='CUSTODY_UNAUTHORIZED';
   throw e;
  }
  const body=await r.json().catch(()=>null);
  let signed;try{signed=VersionedTransaction.deserialize(Buffer.from(String(body?.transactionBase64??''),'base64'));}catch{throw Error('Custody returned an unreadable packet');}
  const keys=signed.message.staticAccountKeys;
  if(!Buffer.from(signed.message.serialize()).equals(message)||keys.length<3||String(keys[0])!==ref.keeper||String(keys[1])!==ref.mint||String(keys[2])!==ref.feeNft||signed.signatures.length<3)throw Error('Custody returned another message');
  for(const i of [1,2])if(!verify(null,message,spki(keys[i]),Buffer.from(signed.signatures[i])))throw Error('Custody returned an invalid signature');
  if(!signed.signatures[0].every(b=>b===0))throw Error('Custody must not sign for the keeper');
  return signed;
 }};
}
