// Acceptance is an off-chain review checkpoint, NOT a wallet signature or funding
// confirmation. Nothing here leases a mint, grants signer rights or moves money.
import {randomUUID} from 'node:crypto';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {isAddress} from '../registry/registry.mjs';
const key=/^[A-Za-z0-9_.:-]{1,128}$/,hash=/^[a-f0-9]{64}$/;
const error=(code,message)=>Object.assign(Error(message),{code});
const quoteRow=r=>r?{id:r.quote_id,owner:r.owner,draftId:r.draft_id,draftRevision:Number(r.draft_revision),draftHash:r.draft_hash,descriptorHash:r.descriptor_hash,body:JSON.parse(r.body),createdAt:Number(r.created_at),expiresAt:Number(r.expires_at)}:null;
const requestRow=r=>r?{id:r.request_id,owner:r.owner,draftId:r.draft_id,quoteId:r.quote_id,state:r.state,body:JSON.parse(r.body),createdAt:Number(r.created_at),updatedAt:Number(r.updated_at)}:null;
export function createCreationStore(registry){
 if(registry?.driver!=='postgres')throw Error('Creation needs shared PostgreSQL');
 const query=(s,p=[])=>registry.query(s,p);
 const now=async()=>Number((await query('SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms')).rows[0].ms);
 const valid=(owner,id)=>{if(!isAddress(owner)||!key.test(id||''))throw Error('Invalid creation identity');};
 const get=async(owner,id)=>{valid(owner,id);return quoteRow((await query('SELECT * FROM creation_quotes WHERE owner=? AND quote_id=?',[owner,id])).rows[0]);};
 const find=async(owner,requestKey)=>{valid(owner,requestKey);return quoteRow((await query('SELECT * FROM creation_quotes WHERE owner=? AND request_key=?',[owner,requestKey])).rows[0]);};
 const status=async(owner,draftId)=>{valid(owner,draftId);return requestRow((await query('SELECT * FROM creation_requests WHERE owner=? AND draft_id=?',[owner,draftId])).rows[0]);};
 async function issue({owner,draftId,revision,draftHash,requestKey,descriptorHash,body,validForMs=120000}){
  valid(owner,draftId);valid(owner,requestKey);
  if(!Number.isSafeInteger(revision)||revision<1||!hash.test(draftHash)||!hash.test(descriptorHash)||!Number.isInteger(validForMs)||validForMs<1000||validForMs>120000)throw Error('Invalid creation quote');
  const json=canonicalJson(body);if(Buffer.byteLength(json)>40000)throw Error('Creation quote too large');
  return registry.transaction(async()=>{
   const prior=await find(owner,requestKey);
   if(prior){if(prior.descriptorHash!==descriptorHash||prior.draftHash!==draftHash||prior.draftId!==draftId||prior.draftRevision!==revision)throw error('IDEMPOTENCY_CONFLICT','Quote request already has different terms');return prior;}
   const draft=(await query('SELECT * FROM creator_drafts WHERE creator=? AND draft_id=? FOR UPDATE',[owner,draftId])).rows[0];
   if(!draft||Number(draft.revision)!==revision||canonicalHash(JSON.parse(draft.body_json))!==draftHash)throw error('REVISION_CONFLICT','Draft changed before quote');
   if(draft.status!=='draft')throw error('CREATION_STARTED','Creation already started');
   const at=await now(),id=randomUUID();
   await query('INSERT INTO creation_quotes(quote_id,owner,request_key,draft_id,draft_revision,draft_hash,descriptor_hash,body,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[id,owner,requestKey,draftId,revision,draftHash,descriptorHash,json,at,at+validForMs]);
   return get(owner,id);
  },{lockKey:'creation:'+owner+':'+draftId});
 }
 async function accept({owner,quoteId}){
  valid(owner,quoteId);const quote=await get(owner,quoteId);if(!quote)throw error('QUOTE_UNAVAILABLE','Quote unavailable');
  return registry.transaction(async()=>{
   const prior=await status(owner,quote.draftId);
   if(prior){if(prior.quoteId!==quoteId)throw error('CREATION_STARTED','Draft already bound to another quote');return prior;}
   const draft=(await query('SELECT * FROM creator_drafts WHERE creator=? AND draft_id=? FOR UPDATE',[owner,quote.draftId])).rows[0];
   if(!draft||Number(draft.revision)!==quote.draftRevision||canonicalHash(JSON.parse(draft.body_json))!==quote.draftHash)throw error('REVISION_CONFLICT','Draft changed before acceptance');
   if(draft.status!=='draft')throw error('CREATION_STARTED','Creation already started');
   const at=await now();if(at>=quote.expiresAt)throw error('QUOTE_EXPIRED','Refresh the setup quote');
   const id=randomUUID(),body=canonicalJson({draft:JSON.parse(draft.body_json),quote:quote.body,draftHash:quote.draftHash,descriptorHash:quote.descriptorHash});
   await query("INSERT INTO creation_requests(request_id,owner,draft_id,quote_id,state,body,created_at,updated_at) VALUES(?,?,?,?,'accepted',?,?,?)",[id,owner,quote.draftId,quoteId,body,at,at]);
   await query('INSERT INTO creation_work(request_id,updated_at) VALUES(?,?)',[id,at]);
   await query("UPDATE creator_drafts SET status='creating',updated_at=? WHERE creator=? AND draft_id=?",[new Date(at).toISOString(),owner,quote.draftId]);
   return status(owner,quote.draftId);
  },{lockKey:'creation:'+owner+':'+quote.draftId});
 }
 return {get,find,issue,accept,status};
}
