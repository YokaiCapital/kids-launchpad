import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,verify,createPublicKey} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Protocol,base58,canonical,presetHash,hash,readiness} from '../core.mjs';
import {createProtocolServer} from '../server.mjs';
const wallet=()=>{const k=generateKeyPairSync('ed25519');return {...k,owner:base58(k.publicKey.export({format:'der',type:'spki'}).subarray(-32))};};
const terms=(i=0)=>({name:'Kid '+i,ticker:'KID'+i,description:'Two communities, one kid.',parents:[wallet().owner,wallet().owner],artSha256:hash('art'+i),rights:true});
function setup(filename=':memory:'){let now=1000;const receiptKey=generateKeyPairSync('ed25519').privateKey;const p=new Protocol({filename,clock:()=>now,receiptKey});return {p,receiptKey,setTime:n=>now=n};}
const accept=(p,w,c)=>p.accept({id:c.id,signature:sign(null,Buffer.from(c.signingText),w.privateKey).toString('base64')});
function submit(p,w,i){return accept(p,w,p.challenge({owner:w.owner,action:'submit',payload:{terms:terms(i)}}));}
function round(p,owners,id='009',closesAt=3000){return p.openRound({id,freezeAt:1000,opensAt:1000,closesAt,snapshot:{source:'synthetic-local-rehearsal',commitment:'finalized',slot:1,accounts:owners.map(([w,power],i)=>({address:'token-'+i,owner:w.owner,amountRaw:String(power)}))}});}
function prepared(){const ctx=setup(),a=wallet(),b=wallet(),v=wallet();const pa=submit(ctx.p,a,1),pb=submit(ctx.p,b,2);for(const r of [pa,pb])ctx.p.moderate({proposalHash:r.outcome.proposalHash,decision:'approved',reason:'VALID'});const r=round(ctx.p,[[v,100],[a,900]]);return {...ctx,a,b,v,pa,pb,r};}
const vote=(p,v,r,proposalHash)=>p.challenge({owner:v.owner,action:'vote',payload:{round:r,proposalHash}});
test('signed submit persists across restart and receipts independently verify',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kid-protocol-'));const ctx=setup(join(dir,'db'));const w=wallet(),c=ctx.p.challenge({owner:w.owner,action:'submit',payload:{terms:terms()}});const r=accept(ctx.p,w,c);
 assert.deepEqual(accept(ctx.p,w,c),r);const {serverSignature,...body}=r;assert(verify(null,Buffer.from(canonical(body)),createPublicKey(ctx.receiptKey),Buffer.from(serverSignature,'base64')));
 ctx.p.close();const reopened=new Protocol({filename:join(dir,'db'),clock:()=>1000,receiptKey:ctx.receiptKey});assert.equal(reopened.read().proposals.length,1);assert.equal(reopened.read().receipts[0].id,r.id);reopened.close();rmSync(dir,{recursive:true});
});
test('wrong wallet, tampered signed payload and expired nonce are rejected',()=>{
 const {p,setTime}=setup(),a=wallet(),b=wallet();const c=p.challenge({owner:a.owner,action:'submit',payload:{terms:terms()}});
 assert.throws(()=>accept(p,b,c),/Signature/);assert.throws(()=>accept(p,a,{...c,signingText:c.signingText.replace('localhost','evilhost')}),/Signature/);
 setTime(302000);assert.throws(()=>accept(p,a,c),/expired/);assert.equal(p.read().proposals.length,0);p.close();
});
test('all approved candidates freeze; revisions cannot mutate frozen terms',()=>{
 const {p,a,pa,r}=prepared();const before=canonical(r.candidates);const newTerms=terms(3);const c=p.challenge({owner:a.owner,action:'submit',payload:{terms:newTerms,proposalId:pa.outcome.proposalId}});const receipt=accept(p,a,c);
 assert.equal(receipt.outcome.version,2);assert.equal(canonical(p.read().rounds[0].candidates),before);assert.equal(p.read().rounds[0].candidates.length,2);
 assert.throws(()=>p.moderate({proposalHash:pa.outcome.proposalHash,decision:'rejected',reason:'ART_RIGHTS'}),/not reviewable/);p.close();
});
test('atomic replacement, idempotent receipt, stale sequence and late signature preserve prior vote',()=>{
 const {p,v,pa,pb,setTime}=prepared();const first=accept(p,v,vote(p,v,'009',pa.outcome.proposalHash));
 const c1=vote(p,v,'009',pb.outcome.proposalHash),c2=vote(p,v,'009',pa.outcome.proposalHash);const replacement=accept(p,v,c1);assert.deepEqual(accept(p,v,c1),replacement);assert.throws(()=>accept(p,v,c2),/Stale/);
 const late=vote(p,v,'009',pa.outcome.proposalHash);setTime(3000);assert.throws(()=>accept(p,v,late),/closed/);assert.equal(p.read().votes.length,1);assert.equal(p.read().votes[0].proposalHash,pb.outcome.proposalHash);assert.notEqual(first.id,replacement.id);
 const result=p.closeRound('009');assert.equal(result.winner,pb.outcome.proposalHash);assert.equal(result.turnoutRaw,'100');assert.equal(result.launchesOpen,false);p.close();
});
test('snapshot aggregates accounts, rejects missing power and cannot be replaced',()=>{
 const {p}=setup(),a=wallet(),v=wallet(),other=wallet();const pa=submit(p,a,1);p.moderate({proposalHash:pa.outcome.proposalHash,decision:'approved',reason:'VALID'});const r=round(p,[[v,25],[v,75]]);assert.equal(r.snapshot.owners[v.owner],'100');assert.equal(r.snapshot.denominatorRaw,'100');
 assert.throws(()=>vote(p,other,'009',pa.outcome.proposalHash),/No snapshot power/);assert.throws(()=>round(p,[[v,100]]),/Unique/);p.close();
});
test('quorum failure and tie both skip; tied hashes published for runoff',()=>{
 const a=prepared();a.setTime(3000);assert.equal(a.p.closeRound('009').status,'skipped-no-quorum');a.p.close();
 const {p,setTime}=setup(),w1=wallet(),w2=wallet();const c1=submit(p,w1,1),c2=submit(p,w2,2);for(const c of [c1,c2])p.moderate({proposalHash:c.outcome.proposalHash,decision:'approved',reason:'VALID'});round(p,[[w1,100],[w2,100]]);accept(p,w1,vote(p,w1,'009',c1.outcome.proposalHash));accept(p,w2,vote(p,w2,'009',c2.outcome.proposalHash));setTime(3000);const result=p.closeRound('009');assert.equal(result.status,'skipped-tie');assert.equal(result.runoff.length,2);assert.equal(result.winner,null);p.close();
});
test('one active queued proposal, moderation reason and duplicate-account guards',()=>{
 const {p}=setup(),w=wallet();submit(p,w,1);assert.throws(()=>submit(p,w,2),/one active/i);
 assert.throws(()=>p.moderate({decision:'approved',reason:'ART_RIGHTS'}),/does not match/);p.close();
});
test('HTTP admin auth, origin boundary, signed acceptance and launch gate',async()=>{
 const {p}=setup(),token='x'.repeat(64),server=createProtocolServer({protocol:p,adminToken:token});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 try{let res=await fetch(url+'/admin/launch',{method:'POST'});assert.equal(res.status,401);res=await fetch(url+'/admin/launch',{method:'POST',headers:{Authorization:'Bearer '+token}});assert.equal(res.status,409);assert.equal((await res.json()).launchesOpen,false);res=await fetch(url+'/challenge',{method:'POST',headers:{Origin:'https://evil.example'}});assert.equal(res.status,403);
 const w=wallet();res=await fetch(url+'/challenge',{method:'POST',body:JSON.stringify({owner:w.owner,action:'submit',payload:{terms:terms()}})});const c=await res.json();res=await fetch(url+'/accept',{method:'POST',body:JSON.stringify({id:c.id,signature:sign(null,Buffer.from(c.signingText),w.privateKey).toString('base64')})});assert.equal(res.status,200);assert.equal((await res.json()).action,'submit');assert.equal(readiness().launchesOpen,false);assert.equal(presetHash.length,64);
 }finally{await new Promise(r=>server.close(r));p.close();}
});
