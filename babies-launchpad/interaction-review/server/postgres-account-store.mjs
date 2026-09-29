// Uses the registry pool and serializable transaction context; never opens a second pool per origin.
// Old account records can be imported before cutover; legacy SQLite files remain untouched.
import {createHash,createPublicKey,randomBytes,randomUUID,verify} from 'node:crypto';
import {decode58} from '../../protocol/core.mjs';
import {normalizeDraft,draftError,submitVersion,reviewVersion} from '../src/model.js';
const digest=value=>createHash('sha256').update(value).digest('hex');
export class PostgresAccountStore {
 constructor({registry,origin,clock=Date.now,admins=[]}){
  const url=new URL(origin);if(url.origin!==origin)throw Error('Exact application origin required');
  if(registry?.driver!=='postgres')throw Error('Shared accounts require PostgreSQL');
  this.registry=registry;this.origin=origin;this.clock=clock;this.admins=new Set(admins);for(const wallet of admins)decode58(wallet);
 }
 close(){} // Pool ownership belongs to registry startup.
 async challenge(owner){
  decode58(owner);
  return this.registry.transaction(async()=>{
   const now=this.clock();
   // Expired rows are excluded, with bulk expiry cleanup performed separately from sign-in.
   // At most five pending challenges per wallet: the oldest give way, so nobody can lock a wallet out by requesting challenges for it.
   await this.registry.query('DELETE FROM wallet_auth_challenges WHERE origin=? AND owner=? AND id NOT IN (SELECT id FROM wallet_auth_challenges WHERE origin=? AND owner=? AND expires>? ORDER BY expires DESC LIMIT 4)',[this.origin,owner,this.origin,owner,now]);
   const id=randomBytes(24).toString('hex'),expires=now+300000;
   const message=`${new URL(this.origin).host} wants you to sign in with your Solana account:\n${owner}\n\nSign in to KIDS. This does not authorize transactions or move funds.\n\nURI: ${this.origin}\nVersion: 1\nNonce: ${id}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(expires).toISOString()}`;
   await this.registry.query('INSERT INTO wallet_auth_challenges(id,origin,owner,message,expires) VALUES(?,?,?,?,?)',[id,this.origin,owner,message,expires]);
   return {id,owner,message,expires};
  });
 }
 async verify({id,signature}){
  return this.registry.transaction(async()=>{
   const {rows}=await this.registry.query('SELECT * FROM wallet_auth_challenges WHERE id=? AND origin=?',[typeof id==='string'?id:'',this.origin]);
   const challenge=rows[0];
   if(!challenge||!challenge.message.includes('\nURI: '+this.origin+'\n')||Number(challenge.expires)<=this.clock())throw Error('Sign-in request expired or already used');
   if(typeof signature!=='string'||! /^[A-Za-z0-9+/]{86}==$/.test(signature))throw Error('Invalid wallet signature');
   const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),decode58(challenge.owner)]),format:'der',type:'spki'});
   if(!verify(null,Buffer.from(challenge.message),key,Buffer.from(signature,'base64')))throw Error('Wallet signature did not match');
   await this.registry.query('DELETE FROM wallet_auth_challenges WHERE id=? AND origin=?',[id,this.origin]);
   const token=randomBytes(32).toString('hex'),expires=this.clock()+86400000;
   await this.registry.query('INSERT INTO wallet_sessions(token_hash,origin,owner,expires) VALUES(?,?,?,?)',[digest(token),this.origin,challenge.owner,expires]);
   return {token,owner:challenge.owner,expires};
  });
 }
 async session(token){
  if(typeof token!=='string'||! /^[a-f0-9]{64}$/.test(token))return null;
  const {rows}=await this.registry.query('SELECT owner,expires FROM wallet_sessions WHERE token_hash=? AND origin=? AND expires>?',[digest(token),this.origin,this.clock()]);
  return rows[0]?{owner:rows[0].owner,expires:Number(rows[0].expires)}:null;
 }
 async logout(token){if(typeof token==='string')await this.registry.query('DELETE FROM wallet_sessions WHERE token_hash=? AND origin=?',[digest(token),this.origin]);}
 async state(owner){const {rows}=await this.registry.query('SELECT body FROM wallet_accounts WHERE owner=?',[owner]);return rows[0]?JSON.parse(rows[0].body):{revision:0,history:[],accepted:null};}
 async publicProposals(){const {rows}=await this.registry.query('SELECT owner,body FROM wallet_accounts');return rows.flatMap(row=>JSON.parse(row.body).history.filter(p=>p.status==='Approved for next round').map(p=>({...p,owner:row.owner})));}
 async apply(owner,input,verifiedPayload=input.payload){
  decode58(owner);const {requestId,revision,action}=input;
  if(typeof requestId!=='string'||! /^[A-Za-z0-9-]{8,80}$/.test(requestId))throw Error('Request ID required');
  const hash=digest(JSON.stringify(input));return this.registry.transaction(async()=>{
   const {rows}=await this.registry.query('SELECT hash,response FROM wallet_account_requests WHERE owner=? AND id=?',[owner,requestId]);
   if(rows[0]){if(rows[0].hash!==hash)throw Error('Request ID reused with different content');return JSON.parse(rows[0].response);}
   const state=await this.state(owner);if(revision!==state.revision)throw Error('Account changed in another tab. Refresh and retry.');let proposal=null;
   if(action==='submit'){
    const draft=normalizeDraft(verifiedPayload.draft),problem=draftError(draft);if(problem)throw Error(problem);
    for(const key of ['a','b']){decode58(draft[key]);if(!draft.parentData?.[key]?.supported||draft.parentData[key].mint!==draft[key])throw Error('Verified parent mints required');}
    if(draft.proposalId&&!state.history.some(p=>p.id===draft.proposalId))throw Error('Proposal does not belong to this wallet');
    const result=submitVersion(state.history,draft,this.clock());state.history=result.records;proposal=result.proposal;
   }else throw Error('This action is not enabled for real wallets. Launches and real voting remain closed.');
   state.revision++;
   await this.registry.query('INSERT INTO wallet_accounts(owner,body) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET body=excluded.body',[owner,JSON.stringify(state)]);
   const result={...state,proposal};
   await this.registry.query('INSERT INTO wallet_account_requests(owner,id,hash,response) VALUES(?,?,?,?)',[owner,requestId,hash,JSON.stringify(result)]);
   await this.registry.query('INSERT INTO wallet_account_audit(id,time,owner,action,resource) VALUES(?,?,?,?,?)',[randomUUID(),this.clock(),owner,action,proposal?.id||'']);return result;
  });
 }
 async moderate(actor,{owner,id,version,status}){
  if(!this.admins.has(actor))throw Error('Moderator access required');return this.registry.transaction(async()=>{
   const state=await this.state(owner);if(!state.history.some(p=>p.id===id&&p.version===version&&p.status==='Awaiting review'))throw Error('Proposal is not awaiting review');
   state.history=reviewVersion(state.history,id,version,status);state.revision++;
   await this.registry.query('UPDATE wallet_accounts SET body=? WHERE owner=?',[JSON.stringify(state),owner]);
   await this.registry.query('INSERT INTO wallet_account_audit(id,time,owner,action,resource) VALUES(?,?,?,?,?)',[randomUUID(),this.clock(),actor,'moderate:'+status,id+':'+version]);
   return state.history.find(p=>p.id===id&&p.version===version);
  });
 }
 async pruneExpired({limit=500}={}){
  if(!Number.isInteger(limit)||limit<1||limit>1000)throw Error('Invalid cleanup limit');
  // Short bounded deletes let a maintenance worker clean expired auth records without blocking sign-in.
  for(const [table,key] of [['wallet_auth_challenges','id'],['wallet_sessions','token_hash']])await this.registry.query(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE expires<=? ORDER BY expires LIMIT ?)`,[this.clock(),limit]);
 }
}
