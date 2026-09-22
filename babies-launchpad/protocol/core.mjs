import {DatabaseSync} from 'node:sqlite';
import {createHash,createPublicKey,randomBytes,verify,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
export const preset=JSON.parse(readFileSync(new URL('./preset.json',import.meta.url),'utf8'));
export const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
export const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
export const presetHash=hash(preset);
export function readiness(){return {launchesOpen:false,presetHash,missing:[...Object.entries(preset.deployment).filter(([,v])=>!v).map(([k])=>'deployment.'+k),...Object.entries(preset.qualification).filter(([,v])=>!v).map(([k])=>'qualification.'+k)],scope:preset.scope};}
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes){let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}let z=0;while(bytes[z]===0)z++;return '1'.repeat(z)+s;}
export function decode58(s){if(typeof s!=='string'||s.length<32||s.length>44)throw Error('Invalid owner or mint');let n=0n;for(const c of s){const i=alphabet.indexOf(c);if(i<0)throw Error('Invalid base58');n=n*58n+BigInt(i);}const hex=n.toString(16);const bytes=n?Buffer.from(hex.padStart(hex.length+(hex.length%2),'0'),'hex'):Buffer.alloc(0);const out=Buffer.concat([Buffer.alloc(s.match(/^1*/)[0].length),bytes]);if(out.length!==32)throw Error('Invalid public key length');return out;}
const keyFor=owner=>createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),decode58(owner)]),format:'der',type:'spki'});
const clone=x=>structuredClone(x);
const ensure=(condition,message)=>{if(!condition)throw Error(message);};
const unsignedRaw=x=>typeof x==='string'&&/^\d+$/.test(x)&&BigInt(x)<=18446744073709551615n;
export class Protocol {
 constructor({filename=':memory:',domain='http://localhost:4181',clock=Date.now,receiptKey,localnetGenesis=null}) {
  this.localnetGenesis=localnetGenesis;
  ensure(receiptKey,'Receipt signing key required');this.receiptKey=receiptKey;this.receiptPublicKey=createPublicKey(receiptKey).export({format:'pem',type:'spki'});this.domain=domain;this.clock=clock;
  this.db=new DatabaseSync(filename);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);');
  this.db.prepare('INSERT OR IGNORE INTO state VALUES(1,?)').run(JSON.stringify({proposals:[],rounds:[],challenges:[],votes:[],receipts:[],events:[]}));
 }
 close(){this.db.close();}
 read(){return JSON.parse(this.db.prepare('SELECT body FROM state WHERE id=1').get().body);}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const s=this.read(),result=fn(s);this.db.prepare('UPDATE state SET body=? WHERE id=1').run(JSON.stringify(s));this.db.exec('COMMIT');return clone(result);}catch(e){this.db.exec('ROLLBACK');throw e;}}
 event(s,type,data){const e={index:s.events.length+1,time:this.clock(),type,data,previous:s.events.at(-1)?.hash||null};e.hash=hash(e);s.events.push(e);return e;}
 terms(input){
  ensure(input&&typeof input==='object','Proposal terms required');
  const {name,ticker,description,parents,artSha256,rights}=input;
  ensure(typeof name==='string'&&name.trim().length>0&&name.length<=28,'Invalid name');ensure(typeof ticker==='string'&&/^[A-Z0-9]{2,10}$/.test(ticker),'Invalid ticker');ensure(typeof description==='string'&&description.trim().length>0&&description.length<=180,'Invalid description');
  ensure(Array.isArray(parents)&&parents.length===2&&parents[0]!==parents[1],'Two distinct parent mints required');parents.forEach(decode58);ensure(typeof artSha256==='string'&&/^[a-f0-9]{64}$/.test(artSha256)&&rights===true,'Artwork hash and rights required');
  return {name:name.trim(),ticker,description:description.trim(),parents:[...parents],artSha256,rights,presetHash,parentSnapshotPolicy:'finalized-at-ballot-close-v1'};
 }
 challenge({owner,action,payload}){
  decode58(owner);ensure(['submit','vote'].includes(action),'Unsupported action');
  return this.transaction(s=>{
   const now=this.clock();s.challenges=s.challenges.filter(c=>c.message.expiresAt>now||c.receipt);ensure(s.challenges.filter(c=>c.message.owner===owner&&!c.receipt).length<10,'Too many pending signatures');
   let body;
   if(action==='submit') {const terms=this.terms(payload.terms);const lineage=payload.proposalId||null;if(lineage)ensure(s.proposals.some(p=>p.id===lineage&&p.owner===owner),'Proposal not owned by this wallet');body={terms,proposalId:lineage};}
   else {const r=s.rounds.find(r=>r.id===payload.round);ensure(r&&now>=r.opensAt&&now<r.closesAt&&!r.result,'Round not open');ensure(r.snapshot.owners[owner]&&BigInt(r.snapshot.owners[owner])>0n,'No snapshot power');const c=r.candidates.find(c=>c.hash===payload.proposalHash);ensure(c,'Frozen candidate unavailable');body={round:r.id,proposalHash:c.hash,snapshotHash:r.snapshot.hash,sequence:(s.votes.find(v=>v.round===r.id&&v.owner===owner)?.sequence||0)+1};}
   const message={domain:this.domain,chain:this.localnetGenesis?'solana-localnet:'+this.localnetGenesis:'solana-local-rehearsal',action,owner,presetHash,...body,nonce:randomBytes(24).toString('hex'),issuedAt:now,expiresAt:now+300000};
   const challenge={id:message.nonce,message};s.challenges.push(challenge);return {id:challenge.id,message,signingText:canonical(message)};
  });
 }
 accept({id,signature}){
  return this.transaction(s=>{
   const c=s.challenges.find(c=>c.id===id);ensure(c,'Unknown signing challenge');
   ensure(typeof signature==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(signature),'Invalid signature encoding');const sig=Buffer.from(signature,'base64');ensure(sig.length===64&&verify(null,Buffer.from(canonical(c.message)),keyFor(c.message.owner),sig),'Signature verification failed');
   if(c.receipt)return s.receipts.find(r=>r.id===c.receipt);
   const m=c.message,now=this.clock();ensure(now<m.expiresAt,'Signing challenge expired');ensure(m.domain===this.domain&&m.presetHash===presetHash,'Signing scope changed');
   let outcome;
   if(m.action==='submit') {
    const lineage=s.proposals.filter(p=>p.id===m.proposalId);const id=m.proposalId||'P-'+randomBytes(12).toString('hex');
    ensure(!s.proposals.some(p=>p.owner===m.owner&&p.id!==id&&['awaiting-review','approved'].includes(p.status)&&!p.round),'Only one active queued proposal per owner');
    const duplicate=s.proposals.some(p=>p.id!==id&&p.terms.artSha256===m.terms.artSha256&&[...p.terms.parents].sort().join() === [...m.terms.parents].sort().join()&&['approved','awaiting-review','frozen'].includes(p.status));ensure(!duplicate,'Duplicate parent pair and artwork');
    const p={id,version:Math.max(0,...lineage.map(p=>p.version))+1,owner:m.owner,terms:m.terms,submittedAt:now,status:'awaiting-review',reviews:[]};p.hash=hash({id:p.id,version:p.version,owner:p.owner,terms:p.terms});
    for(const old of lineage)if(!['frozen','approved'].includes(old.status))old.status='superseded';s.proposals.push(p);outcome={proposalId:id,version:p.version,proposalHash:p.hash};
   }else {
    const r=s.rounds.find(r=>r.id===m.round);ensure(r&&now>=r.opensAt&&now<r.closesAt&&!r.result,'Round closed before acceptance');ensure(r.snapshot.hash===m.snapshotHash&&r.candidates.some(c=>c.hash===m.proposalHash),'Frozen ballot changed');
    const prior=s.votes.find(v=>v.round===r.id&&v.owner===m.owner);ensure(m.sequence===(prior?.sequence||0)+1,'Stale replacement sequence');
    const v={round:r.id,owner:m.owner,proposalHash:m.proposalHash,sequence:m.sequence,powerRaw:r.snapshot.owners[m.owner]};ensure(BigInt(v.powerRaw)>0n,'No snapshot power');s.votes=s.votes.filter(v=>v.round!==r.id||v.owner!==m.owner);s.votes.push(v);outcome=v;
   }
   const receipt={id:'R-'+randomBytes(16).toString('hex'),acceptedAt:now,action:m.action,owner:m.owner,requestHash:hash(m),signedMessage:m,walletSignature:signature,outcome};receipt.serverSignature=sign(null,Buffer.from(canonical(receipt)),this.receiptKey).toString('base64');
   c.receipt=receipt.id;s.receipts.push(receipt);this.event(s,'accepted',{receiptId:receipt.id,requestHash:receipt.requestHash});return receipt;
  });
 }
 moderate({proposalHash,decision,reason,actor='local-admin'}) {
  ensure(['approved','changes-requested','rejected'].includes(decision),'Invalid moderation decision');ensure(['VALID','ART_RIGHTS','MINT_UNSUPPORTED','DUPLICATE','DECEPTIVE_METADATA'].includes(reason),'Public reason code required');ensure((decision==='approved')===(reason==='VALID'),'Reason does not match decision');
  return this.transaction(s=>{const p=s.proposals.find(p=>p.hash===proposalHash);ensure(p&&p.status==='awaiting-review','Proposal is not reviewable');p.status=decision;p.reviewedAt=this.clock();p.reviews.push({decision,reason,actor,at:p.reviewedAt});this.event(s,'moderation',{proposalHash,decision,reason,actor});return p;});
 }
 openRound({id,opensAt,closesAt,freezeAt,snapshot}){
  return this.transaction(s=>{
   ensure(typeof id==='string'&&/^[A-Za-z0-9-]{1,40}$/.test(id)&&!s.rounds.some(r=>r.id===id),'Unique round ID required');
   ensure(Number.isSafeInteger(opensAt)&&Number.isSafeInteger(closesAt)&&Number.isSafeInteger(freezeAt)&&freezeAt<=opensAt&&closesAt>opensAt&&this.clock()>=freezeAt&&this.clock()<=opensAt,'Invalid round schedule');
   ensure((snapshot?.source==='synthetic-local-rehearsal'||(this.localnetGenesis&&snapshot?.source==='solana-localnet-rpc'&&snapshot.genesisHash===this.localnetGenesis))&&snapshot.commitment==='finalized'&&Number.isSafeInteger(snapshot.slot)&&snapshot.slot>=0,'Explicit synthetic snapshot provenance or configured localnet ledger required');
   ensure(Array.isArray(snapshot.accounts)&&snapshot.accounts.length>0&&snapshot.accounts.length<=10000,'Bounded snapshot accounts required');
   const owners={},seen=new Set();for(const a of snapshot.accounts){decode58(a.owner);ensure(typeof a.address==='string'&&!seen.has(a.address),'Duplicate snapshot token account');seen.add(a.address);ensure(unsignedRaw(a.amountRaw),'Invalid snapshot amount');owners[a.owner]=(BigInt(owners[a.owner]||0)+BigInt(a.amountRaw)).toString();}
   const denominator=Object.values(owners).reduce((sum,n)=>sum+BigInt(n),0n);ensure(denominator>0n,'Empty electorate');
   const eligible=s.proposals.filter(p=>p.status==='approved'&&!p.round&&p.reviewedAt<=freezeAt);ensure(eligible.length>0,'No approved candidates');
   // All eligible versions are included; no shortlist. At most one version per lineage enters a round.
   const latest=new Map();for(const p of eligible)if(!latest.has(p.id)||latest.get(p.id).version<p.version)latest.set(p.id,p);
   const candidates=[...latest.values()].sort((a,b)=>a.submittedAt-b.submittedAt||a.hash.localeCompare(b.hash)).map(p=>{p.round=id;p.status='frozen';return clone(p);});
   for(const p of eligible)if(!p.round)p.status='superseded';
   const snap={...(snapshot.source==='solana-localnet-rpc'?{genesisHash:snapshot.genesisHash,mint:snapshot.mint}:{}),source:snapshot.source,commitment:snapshot.commitment,slot:snapshot.slot,owners,denominatorRaw:denominator.toString(),accountsHash:hash([...snapshot.accounts].sort((a,b)=>a.address.localeCompare(b.address)))};snap.hash=hash(snap);
   const round={id,opensAt,closesAt,freezeAt,presetHash,candidates,snapshot:snap,result:null};s.rounds.push(round);this.event(s,'round-frozen',{id,snapshotHash:snap.hash,candidates:candidates.map(c=>c.hash)});return round;
  });
 }
 tally(id,state=this.read()){
  const r=state.rounds.find(r=>r.id===id);ensure(r,'Round not found');const votes=state.votes.filter(v=>v.round===id);const totals=r.candidates.map(c=>({proposalHash:c.hash,powerRaw:votes.filter(v=>v.proposalHash===c.hash).reduce((n,v)=>n+BigInt(v.powerRaw),0n).toString()}));totals.sort((a,b)=>BigInt(a.powerRaw)>BigInt(b.powerRaw)?-1:BigInt(a.powerRaw)<BigInt(b.powerRaw)?1:a.proposalHash.localeCompare(b.proposalHash));const turnout=votes.reduce((n,v)=>n+BigInt(v.powerRaw),0n);return {round:id,snapshotHash:r.snapshot.hash,denominatorRaw:r.snapshot.denominatorRaw,turnoutRaw:turnout.toString(),quorum:turnout*10000n>=BigInt(r.snapshot.denominatorRaw)*BigInt(preset.voting.quorumBps),totals};
 }
 closeRound(id){return this.transaction(s=>{const r=s.rounds.find(r=>r.id===id);ensure(r&&this.clock()>=r.closesAt,'Round still open');if(r.result)return r.result;const tally=this.tally(id,s);const leaders=tally.totals.filter(c=>c.powerRaw===tally.totals[0].powerRaw);r.result={...tally,status:!tally.quorum?'skipped-no-quorum':leaders.length>1?'skipped-tie':'elected-pending-launch-checks',winner:tally.quorum&&leaders.length===1?leaders[0].proposalHash:null,runoff:tally.quorum&&leaders.length>1?leaders.map(c=>c.proposalHash):[],launchesOpen:false};this.event(s,'round-closed',r.result);return r.result;});}
}
