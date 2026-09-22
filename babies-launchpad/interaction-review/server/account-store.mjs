import {DatabaseSync} from 'node:sqlite';
import {createHash,createPublicKey,randomBytes,verify} from 'node:crypto';
import {decode58} from '../../protocol/core.mjs';
import {normalizeDraft,draftError,submitVersion,reviewVersion} from '../src/model.js';
const digest=value=>createHash('sha256').update(value).digest('hex');
export class AccountStore {
 constructor({filename=':memory:',origin,clock=Date.now,admins=[]}){
  const url=new URL(origin);if(url.origin!==origin)throw Error('Exact application origin required');
  this.origin=origin;this.clock=clock;this.admins=new Set(admins);for(const wallet of admins)decode58(wallet);
  this.db=new DatabaseSync(filename);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS auth_challenges(id TEXT PRIMARY KEY,owner TEXT NOT NULL,message TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS accounts(owner TEXT PRIMARY KEY,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS account_requests(owner TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(owner,id));
   CREATE TABLE IF NOT EXISTS account_audit(id INTEGER PRIMARY KEY,time INTEGER NOT NULL,owner TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL);`);
 }
 close(){this.db.close();}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 challenge(owner){decode58(owner);return this.transaction(()=>{
  const now=this.clock();this.db.prepare('DELETE FROM auth_challenges WHERE expires<=?').run(now);this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
  if(this.db.prepare('SELECT COUNT(*) AS n FROM auth_challenges WHERE owner=?').get(owner).n>=5)throw Error('Too many pending sign-in requests');
  const id=randomBytes(24).toString('hex'),expires=now+300000;
  const message=`${new URL(this.origin).host} wants you to sign in with your Solana account:\n${owner}\n\nSign in to KIDS. This does not authorize transactions or move funds.\n\nURI: ${this.origin}\nVersion: 1\nNonce: ${id}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(expires).toISOString()}`;
  this.db.prepare('INSERT INTO auth_challenges VALUES(?,?,?,?)').run(id,owner,message,expires);return {id,owner,message,expires};
 });}
 verify({id,signature}){return this.transaction(()=>{
  const challenge=this.db.prepare('SELECT * FROM auth_challenges WHERE id=?').get(typeof id==='string'?id:'');
  if(!challenge||!challenge.message.includes('\nURI: '+this.origin+'\n')||challenge.expires<=this.clock())throw Error('Sign-in request expired or already used');
  if(typeof signature!=='string'||! /^[A-Za-z0-9+/]{86}==$/.test(signature))throw Error('Invalid wallet signature');
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),decode58(challenge.owner)]),format:'der',type:'spki'});
  if(!verify(null,Buffer.from(challenge.message),key,Buffer.from(signature,'base64')))throw Error('Wallet signature did not match');
  this.db.prepare('DELETE FROM auth_challenges WHERE id=?').run(id);
  const token=randomBytes(32).toString('hex'),expires=this.clock()+86400000;
  this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),challenge.owner,expires);
  return {token,owner:challenge.owner,expires};
 });}
 session(token){if(typeof token!=='string'||! /^[a-f0-9]{64}$/.test(token))return null;return this.db.prepare('SELECT owner,expires FROM sessions WHERE token_hash=? AND expires>?').get(digest(token),this.clock())||null;}
 logout(token){if(typeof token==='string')this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));}
 state(owner){const row=this.db.prepare('SELECT body FROM accounts WHERE owner=?').get(owner);return row?JSON.parse(row.body):{revision:0,history:[],accepted:null};}
 publicProposals(){return this.db.prepare('SELECT owner,body FROM accounts').all().flatMap(row=>JSON.parse(row.body).history.filter(p=>p.status==='Approved for next round').map(p=>({...p,owner:row.owner})));}
 apply(owner,input,verifiedPayload=input.payload){decode58(owner);const {requestId,revision,action,payload={}}=input;
  if(typeof requestId!=='string'||! /^[A-Za-z0-9-]{8,80}$/.test(requestId))throw Error('Request ID required');
  const hash=digest(JSON.stringify(input));return this.transaction(()=>{
   const previous=this.db.prepare('SELECT hash,response FROM account_requests WHERE owner=? AND id=?').get(owner,requestId);
   if(previous){if(previous.hash!==hash)throw Error('Request ID reused with different content');return JSON.parse(previous.response);}
   const state=this.state(owner);if(revision!==state.revision)throw Error('Account changed in another tab. Refresh and retry.');let proposal=null;
   if(action==='submit'){
    const draft=normalizeDraft(verifiedPayload.draft),problem=draftError(draft);if(problem)throw Error(problem);
    for(const key of ['a','b']){decode58(draft[key]);if(!draft.parentData?.[key]?.supported||draft.parentData[key].mint!==draft[key])throw Error('Verified parent mints required');}
    if(draft.proposalId&&!state.history.some(p=>p.id===draft.proposalId))throw Error('Proposal does not belong to this wallet');
    const result=submitVersion(state.history,draft,this.clock());state.history=result.records;proposal=result.proposal;
   }else throw Error('This action is not enabled for real wallets. Launches and real voting remain closed.');
   state.revision++;this.db.prepare('INSERT INTO accounts VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET body=excluded.body').run(owner,JSON.stringify(state));
   const result={...state,proposal};this.db.prepare('INSERT INTO account_requests VALUES(?,?,?,?)').run(owner,requestId,hash,JSON.stringify(result));
   this.db.prepare('INSERT INTO account_audit(time,owner,action,resource) VALUES(?,?,?,?)').run(this.clock(),owner,action,proposal?.id||'');return result;
  });
 }
 moderate(actor,{owner,id,version,status}){if(!this.admins.has(actor))throw Error('Moderator access required');return this.transaction(()=>{
  const state=this.state(owner);if(!state.history.some(p=>p.id===id&&p.version===version&&p.status==='Awaiting review'))throw Error('Proposal is not awaiting review');
  state.history=reviewVersion(state.history,id,version,status);state.revision++;
  this.db.prepare('UPDATE accounts SET body=? WHERE owner=?').run(JSON.stringify(state),owner);
  this.db.prepare('INSERT INTO account_audit(time,owner,action,resource) VALUES(?,?,?,?)').run(this.clock(),actor,'moderate:'+status,id+':'+version);
  return state.history.find(p=>p.id===id&&p.version===version);
 });}
}
