// Capability gates: unknown campaign, tag outside the grant, expired grant, recipient or authority mutation, replay of an
// operation id with another message; the legacy path of the signer service is byte-for-byte unaffected.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Keypair,PublicKey,TransactionInstruction,TransactionMessage,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {createSetAuthorityInstruction,AuthorityType,createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {normalizeCapability,loadCapabilities,evaluateCapabilityRequest,createFenceRegistry,fenceKey,NEVER_GRANTABLE_TAGS,STALE_FENCING_TOKEN,KEEPER_TAGS_V2,MEMO_PROGRAM} from './capabilities.mjs';
import {createOperationRegistry,DEFAULT_LIMITS,launchAuthority,USER_TAGS,KEEPER_TAGS} from '../signer-policy.mjs';
import {createSignerService} from '../signer-service.mjs';
import {openRegistry} from '../registry/registry.mjs';
import {refundInstruction,settleInstruction} from '../protocol-v2/client.mjs';
const operator=Keypair.generate(),program=Keypair.generate().publicKey,campaign=Keypair.generate().publicKey,other=Keypair.generate().publicKey,stranger=Keypair.generate().publicKey,blockhash='EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k',token='t'.repeat(40);
const GENESIS=new PublicKey(Buffer.alloc(32,7)).toBase58();
const kids=(tag,c=campaign)=>new TransactionInstruction({programId:program,keys:[{pubkey:c,isSigner:false,isWritable:true},{pubkey:operator.publicKey,isSigner:true,isWritable:true}],data:Buffer.from([tag])});
const msg=(ixs,price=0)=>new TransactionMessage({payerKey:operator.publicKey,recentBlockhash:blockhash,instructions:[...(price?[ComputeBudgetProgram.setComputeUnitLimit({units:100_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:price})]:[]),...ixs]}).compileToV0Message();
const NOW=1790000000000;
const grant=(extra={})=>({campaign:campaign.toBase58(),programId:program.toBase58(),genesisHash:GENESIS,tags:[2,3,4,5,6],expiresAt:new Date(NOW+3600_000).toISOString(),...extra});
const ev=(message,extra={})=>evaluateCapabilityRequest({message,campaign:campaign.toBase58(),fencingToken:3,operationId:'settle:1',capabilities:new Map([[campaign.toBase58(),normalizeCapability(grant(),{now:()=>NOW})]]),operator:operator.publicKey,now:NOW,...extra});
test('eight-receipt v3 packets retain keeper limits and reject a foreign campaign',()=>{
 const caps=new Map([[campaign.toBase58(),normalizeCapability(grant({programVersion:3}),{now:()=>NOW})]]);
 for(const build of [settleInstruction,refundInstruction]){
  const instructions=Array.from({length:8},()=>build(program,campaign,Keypair.generate().publicKey));
  const message=new TransactionMessage({payerKey:operator.publicKey,recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:480000}),...instructions]}).compileToV0Message();
  assert.equal(ev(message,{capabilities:caps}).ok,true);
  instructions[7]=build(program,other,Keypair.generate().publicKey);
  const foreign=new TransactionMessage({payerKey:operator.publicKey,recentBlockhash:blockhash,instructions}).compileToV0Message();
  assert.equal(ev(foreign,{capabilities:caps}).ok,false);
 }
});
test('normalizeCapability refuses recipient and user tags, keeper recipients and raised limits',()=>{
 for(const tag of NEVER_GRANTABLE_TAGS)assert.throws(()=>normalizeCapability(grant({tags:[tag]}),{now:()=>NOW}),/never be granted/,'tag '+tag);
 assert.ok([0,9,1,7,8,10].every(t=>NEVER_GRANTABLE_TAGS.has(t)));for(const t of USER_TAGS)assert.ok(NEVER_GRANTABLE_TAGS.has(t));
 assert.throws(()=>normalizeCapability(grant({recipients:[stranger.toBase58()]}),{now:()=>NOW}),/no recipients/);
 const c=normalizeCapability(grant({limits:{maxPriorityFeeLamports:1_000_000_000,maxHourlyLamports:1000}}),{now:()=>NOW});
 assert.equal(c.limits.maxPriorityFeeLamports,DEFAULT_LIMITS.maxPriorityFeeLamports,'a grant never raises a default limit');assert.equal(c.limits.maxHourlyLamports,1000);
 assert.equal(normalizeCapability(grant({expiresAt:new Date(NOW-1).toISOString()}),{now:()=>NOW}).expired,true);
 assert.throws(()=>normalizeCapability(grant({limits:{maxSomething:1}}),{now:()=>NOW}),/Unknown limit/);
 assert.throws(()=>normalizeCapability(grant({tags:[]}),{now:()=>NOW}),/at least one tag/);
 // program version 2 (kids-launch-v2): only its keeper tags may be granted; tag 24 does not exist there, the legacy set keeps it
 assert.deepEqual([...KEEPER_TAGS_V2].sort((a,b)=>a-b),[2,3,4,5,6,20,21,22,23,25,26]);
 assert.equal(normalizeCapability(grant({programVersion:2,tags:[...KEEPER_TAGS_V2]}),{now:()=>NOW}).programVersion,2);
 assert.equal(normalizeCapability(grant({tags:[24]}),{now:()=>NOW}).programVersion,1,'a grant without a version is a legacy grant');
 assert.throws(()=>normalizeCapability(grant({programVersion:2,tags:[24]}),{now:()=>NOW}),/not a keeper tag of program version 2/);
 assert.throws(()=>normalizeCapability(grant({programVersion:2,tags:[9]}),{now:()=>NOW}),/never be granted/);
 assert.equal(normalizeCapability(grant({programVersion:3,tags:[4]}),{now:()=>NOW}).programVersion,3);
 for(const v of [2,3])assert.throws(()=>normalizeCapability(grant({programVersion:v,tags:[27]}),{now:()=>NOW}),/not a keeper tag/);
 assert.throws(()=>normalizeCapability(grant({programVersion:4,tags:[4]}),{now:()=>NOW}),/programVersion/);
});
test('loadCapabilities reads the registry grants or a JSON file; expired and revoked grants are skipped with a reason; no source refuses',async()=>{
 const r=openRegistry({now:()=>NOW});r.migrate();
 r.campaigns.upsert({genesisHash:GENESIS,programId:program.toBase58(),campaign:campaign.toBase58(),mode:'standard',campaignVersion:2,registryStatus:'planned'});
 r.campaigns.upsert({genesisHash:GENESIS,programId:program.toBase58(),campaign:other.toBase58(),mode:'standard',campaignVersion:2,registryStatus:'planned'});
 const live=r.capabilities.grant({genesisHash:GENESIS,programId:program.toBase58(),campaign:campaign.toBase58(),tags:[4,3],programVersion:2,expiresAt:new Date(NOW+1000).toISOString()});
 const old=r.capabilities.grant({genesisHash:GENESIS,programId:program.toBase58(),campaign:other.toBase58(),tags:[4],expiresAt:new Date(NOW-1000).toISOString()});
 assert.throws(()=>r.capabilities.grant({genesisHash:GENESIS,programId:program.toBase58(),campaign:other.toBase58(),tags:[4],recipients:[stranger.toBase58()],expiresAt:new Date(NOW+1000).toISOString()}),/no recipients/);
 assert.deepEqual(live.tags,[3,4]);assert.equal(live.programVersion,2);assert.equal(r.capabilities.list().length,1);assert.equal(r.capabilities.list({includeExpired:true}).length,2);
 for(const tag of NEVER_GRANTABLE_TAGS)assert.throws(()=>r.capabilities.grant({genesisHash:GENESIS,programId:program.toBase58(),campaign:campaign.toBase58(),tags:[4,tag],expiresAt:new Date(NOW+1000).toISOString()}),/never be granted/,'registry refuses tag '+tag+' at grant time');
 assert.equal(r.capabilities.list({includeExpired:true}).length,2,'a refused grant stores nothing');
 const loaded=await loadCapabilities({registry:r,now:()=>NOW});
 assert.equal(loaded.capabilities.get(campaign.toBase58()).programVersion,2);
 assert.deepEqual([...loaded.capabilities.keys()],[campaign.toBase58()]);assert.deepEqual(loaded.skipped,[{campaign:other.toBase58(),reason:'expired'}]);
 assert.equal(r.capabilities.revoke(live.capabilityId),true);assert.equal((await loadCapabilities({registry:r,now:()=>NOW})).skipped.find(s=>s.campaign===campaign.toBase58()).reason,'revoked');
 const dir=mkdtempSync(join(tmpdir(),'kids-caps-'));const file=join(dir,'capabilities.json');writeFileSync(file,JSON.stringify({version:1,capabilities:[grant(),grant({campaign:other.toBase58(),tags:[0]})]}));
 const fromFile=await loadCapabilities({file,now:()=>NOW});assert.equal(fromFile.capabilities.size,1);assert.match(fromFile.skipped[0].reason,/never be granted/);
 await assert.rejects(loadCapabilities({}),/signs nothing/);
 r.close();
});
test('evaluateCapabilityRequest: unknown campaign, expired grant, missing fencing token or operation id, tag outside the grant',()=>{
 assert.match(ev(msg([kids(4,other)]),{campaign:other.toBase58()}).reason,/not served/);
 const expired=new Map([[campaign.toBase58(),normalizeCapability(grant({expiresAt:new Date(NOW+10).toISOString()}),{now:()=>NOW})]]);
 assert.match(ev(msg([kids(4)]),{capabilities:expired,now:NOW+11}).reason,/expired/);
 assert.match(ev(msg([kids(4)]),{fencingToken:0}).reason,/fencing token/);assert.match(ev(msg([kids(4)]),{fencingToken:null}).reason,/fencing token/);
 assert.match(ev(msg([kids(4)]),{operationId:null}).reason,/operation id/);
 assert.match(ev(msg([kids(21)])).reason,/tag 21 outside capability/,'a legacy keeper tag not in the grant');
 assert.match(ev(msg([kids(4,other)])).reason,/not served/,'the instruction names another campaign than the request');
 const ok=ev(msg([kids(4)],10_000));assert.equal(ok.ok,true);assert.deepEqual(ok.operations,['cu-limit','cu-price','kids:4']);assert.equal(ok.replay,'new');assert.equal(ok.spendLamports,6_000n);
 assert.equal(ev(msg([ComputeBudgetProgram.setComputeUnitLimit({units:1000})])).reason,'transaction does nothing but set a budget');
});
test('a recipient or authority mutation is refused even when bundled with a granted tag; sponsored token accounts only for the campaign authorities',()=>{
 const mint=Keypair.generate().publicKey;
 assert.match(ev(msg([kids(4),createSetAuthorityInstruction(mint,operator.publicKey,AuthorityType.MintTokens,stranger)])).reason,/token instruction not allowed/);
 assert.match(ev(msg([kids(4),SystemProgram.transfer({fromPubkey:operator.publicKey,toPubkey:stranger,lamports:1})])).reason,/transfer not allowed/);
 assert.match(ev(msg([kids(4),SystemProgram.createAccount({fromPubkey:operator.publicKey,newAccountPubkey:mint,lamports:1,space:82,programId:new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')})])).reason,/creation not allowed/);
 const ata=Keypair.generate().publicKey;
 assert.match(ev(msg([kids(4),createAssociatedTokenAccountIdempotentInstruction(operator.publicKey,ata,stranger,mint)])).reason,/ata owner is not served/);
 const auth=new PublicKey(launchAuthority(program.toBase58(),campaign.toBase58()));
 assert.equal(ev(msg([kids(4),createAssociatedTokenAccountIdempotentInstruction(operator.publicKey,ata,auth,mint)])).ok,true);
});
test('replay: one operation id signs one message; the same id with another message is refused, the same message is a retry',()=>{
 const replay=createOperationRegistry({now:()=>NOW});
 const a=ev(msg([kids(4)]),{replay});assert.equal(a.replay,'new');replay.approve('settle:1',a.hash,NOW);
 assert.equal(ev(msg([kids(4)]),{replay}).replay,'retry');
 assert.match(ev(msg([kids(5)]),{replay}).reason,/reused for a different message/);
});
test('signer service: a campaign-scoped request takes the capability path, the legacy path stays as it was, and a request naming a campaign without capabilities is refused',async()=>{
 const logs=[];let caps=new Map([[campaign.toBase58(),normalizeCapability(grant({tags:[4]}),{now:()=>NOW})]]);
 const s=createSignerService({keypair:operator,token,programId:program,campaigns:new Set([campaign.toBase58()]),now:()=>NOW,log:l=>logs.push(l),capabilities:()=>caps});
 await new Promise(r=>s.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+s.server.address().port;
 const post=body=>fetch(url+'/sign',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
 const wire=m=>Buffer.from(m.serialize()).toString('base64');
 try{
  const legacy=await post({message:wire(msg([kids(21)])),operationId:'legacy:1'});assert.equal(legacy.status,200,'legacy keeper tag on the served campaign, no campaign field: unchanged');
  const scoped=await post({message:wire(msg([kids(4)])),operationId:'settle:1',campaign:campaign.toBase58(),fencingToken:2});assert.equal(scoped.status,200);
  assert.ok(logs.some(l=>l.event==='signer-signed'&&l.campaign===campaign.toBase58()&&l.fencingToken===2));
  const outside=await post({message:wire(msg([kids(21)])),operationId:'fee:1',campaign:campaign.toBase58(),fencingToken:2});assert.equal(outside.status,403);assert.match((await outside.json()).error,/tag 21 outside/);
  const noToken=await post({message:wire(msg([kids(4)])),operationId:'settle:2',campaign:campaign.toBase58()});assert.equal(noToken.status,403);assert.match((await noToken.json()).error,/fencing token/);
  const replayed=await post({message:wire(msg([kids(4)],10_000)),operationId:'settle:1',campaign:campaign.toBase58(),fencingToken:2});assert.equal(replayed.status,409,'same id, another message (a priority fee added)');
  const unknown=await post({message:wire(msg([kids(4,other)])),operationId:'settle:3',campaign:other.toBase58(),fencingToken:2});assert.equal(unknown.status,403);assert.match((await unknown.json()).error,/not served/);
  caps=new Map();const gone=await post({message:wire(msg([kids(4)])),operationId:'settle:4',campaign:campaign.toBase58(),fencingToken:2});assert.equal(gone.status,403);
  const health=await (await fetch(url+'/healthz')).json();assert.equal(health.capabilities,true);assert.equal(health.servedCampaigns,1);
  const ready=await fetch(url+'/readyz');assert.equal(ready.status,200);assert.deepEqual(await ready.json(),{status:'ready'},'platform readiness route, no identifiers');
 }finally{await new Promise(r=>s.server.close(r));}
 const plain=createSignerService({keypair:operator,token,programId:program,campaigns:new Set([campaign.toBase58()]),now:()=>NOW});
 await new Promise(r=>plain.server.listen(0,'127.0.0.1',r));
 try{const r=await fetch('http://127.0.0.1:'+plain.server.address().port+'/sign',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({message:wire(msg([kids(4)])),operationId:'x',campaign:campaign.toBase58(),fencingToken:1})});assert.equal(r.status,403);assert.match((await r.json()).error,/capabilities not configured/);
  const h=await (await fetch('http://127.0.0.1:'+plain.server.address().port+'/healthz')).json();assert.equal('capabilities' in h,false,'legacy healthz shape unchanged');
 }finally{await new Promise(r=>plain.server.close(r));}
 assert.ok(KEEPER_TAGS.has(21));
});

test('fencing marks: a lower token than the signer has signed for is refused, equal or higher is accepted and raises the mark',()=>{
 const fences=createFenceRegistry();
 const a=ev(msg([kids(4)]),{fencingToken:5,operationKey:'settle-receipts',fences});assert.equal(a.ok,true);assert.equal(a.fenceKey,campaign.toBase58()+'|settle-receipts');
 fences.record(a.fenceKey,5);
 assert.equal(ev(msg([kids(4)]),{fencingToken:4,operationKey:'settle-receipts',operationId:'settle:9',fences}).reason,STALE_FENCING_TOKEN,'stale lease, another receipt of the same job');
 assert.equal(ev(msg([kids(4)]),{fencingToken:5,operationKey:'settle-receipts',fences}).ok,true,'equal: the same lease again');
 assert.equal(ev(msg([kids(4)]),{fencingToken:6,operationKey:'settle-receipts',fences}).ok,true,'higher: a newer lease');
 assert.equal(ev(msg([kids(4)]),{fencingToken:1,operationKey:'refund-receipts',fences}).ok,true,'another job of the same campaign has its own mark');
 assert.equal(ev(msg([kids(4)]),{fencingToken:1,operationKey:'bad key!',fences}).reason,'operation key malformed');
 // no operation key: the operation id is the key
 fences.record(fenceKey(campaign.toBase58(),null,'settle:1'),3);
 assert.equal(ev(msg([kids(4)]),{fencingToken:2,fences}).reason,STALE_FENCING_TOKEN);assert.equal(ev(msg([kids(4)]),{fencingToken:3,fences}).ok,true);
 assert.equal(fences.check('x',1),'ok','an unknown key has no mark');assert.throws(()=>fences.record('x',0),/positive integer/);
 assert.equal(ev(msg([kids(4)]),{fencingToken:1}).ok,true,'no fence registry configured: the check is skipped, nothing else changes');
});
test('signer service: a stale fencing token is 409 stale-fencing-token, the mark survives a restart, and a refused request never raises it',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-fence-'));const stateFile=join(dir,'signer-state.json');
 const caps=new Map([[campaign.toBase58(),normalizeCapability(grant({tags:[4,5]}),{now:()=>NOW})]]);
 const wire=m=>Buffer.from(m.serialize()).toString('base64');
 const serve=async()=>{const logs=[];const s=createSignerService({keypair:operator,token,programId:program,now:()=>NOW,log:l=>logs.push(l),capabilities:()=>caps,stateFile});await new Promise(r=>s.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+s.server.address().port;return {logs,post:body=>fetch(url+'/sign',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)}),close:()=>new Promise(r=>s.server.close(r))};};
 let s=await serve();
 try{
  assert.equal((await s.post({message:wire(msg([kids(4)])),operationId:'settle:1',campaign:campaign.toBase58(),fencingToken:6,operationKey:'settle-receipts'})).status,200);
  const stale=await s.post({message:wire(msg([kids(4)],10_000)),operationId:'settle:2',campaign:campaign.toBase58(),fencingToken:5,operationKey:'settle-receipts'});
  assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:STALE_FENCING_TOKEN,category:'stale-fencing-token'});
  assert.ok(s.logs.some(l=>l.event==='signer-refused'&&l.category==='stale-fencing-token'&&l.fencingToken===5));
  assert.equal((await s.post({message:wire(msg([kids(4)])),operationId:'settle:1',campaign:campaign.toBase58(),fencingToken:6,operationKey:'settle-receipts'})).status,200,'equal token: a retry of the same lease');
  assert.equal((await s.post({message:wire(msg([kids(5)])),operationId:'settle:3',campaign:campaign.toBase58(),fencingToken:7,operationKey:'settle-receipts'})).status,200,'higher token: a newer lease');
  // a refused request (tag outside the grant) with a higher token does not move the mark
  assert.equal((await s.post({message:wire(msg([kids(21)])),operationId:'settle:4',campaign:campaign.toBase58(),fencingToken:9,operationKey:'settle-receipts'})).status,403);
  assert.equal((await s.post({message:wire(msg([kids(5)],20_000)),operationId:'settle:5',campaign:campaign.toBase58(),fencingToken:8,operationKey:'settle-receipts'})).status,200,'8 is above the recorded 7');
  const saved=JSON.parse(readFileSync(stateFile,'utf8'));assert.deepEqual(saved.fences,[[campaign.toBase58()+'|settle-receipts',8]]);
 }finally{await s.close();}
 s=await serve();
 try{
  const stale=await s.post({message:wire(msg([kids(4)],30_000)),operationId:'settle:6',campaign:campaign.toBase58(),fencingToken:7,operationKey:'settle-receipts'});
  assert.equal(stale.status,409,'the high-water mark survived the restart');
  assert.equal((await s.post({message:wire(msg([kids(4)],30_000)),operationId:'settle:6',campaign:campaign.toBase58(),fencingToken:8,operationKey:'settle-receipts'})).status,200);
  assert.equal((await s.post({message:wire(msg([kids(4)],40_000)),operationId:'settle:7',campaign:campaign.toBase58(),fencingToken:1,operationKey:'refund-receipts'})).status,200,'another job starts its own mark');
  assert.equal((await s.post({message:wire(msg([kids(4)],50_000)),operationId:'settle:8',campaign:campaign.toBase58(),fencingToken:1,operationKey:'nope nope'})).status,403);
  assert.equal((await s.post({message:wire(msg([kids(21)])),operationId:'legacy:9'})).status,403,'legacy path: tag 21 is not served here (no campaigns), unchanged by fencing');
 }finally{await s.close();}
});

test('capability loading never resurrects an older grant or aliases the same address across ledgers',async()=>{
 const rows=[grant({capabilityId:'old'}),grant({capabilityId:'new',revokedAt:new Date(NOW).toISOString()})];
 const registry={capabilities:{list:async()=>rows}};
 assert.equal((await loadCapabilities({registry,now:()=>NOW})).capabilities.size,0);
 rows[1]=grant({capabilityId:'new',expiresAt:new Date(NOW-1).toISOString()});
 assert.equal((await loadCapabilities({registry,now:()=>NOW})).capabilities.size,0);
 rows[1]=grant({capabilityId:'new',genesisHash:other.toBase58()});
 const out=await loadCapabilities({registry,now:()=>NOW});assert.equal(out.capabilities.size,0);assert.equal(out.skipped[0].reason,'ambiguous ledger or program');
});

const wire=m=>Buffer.from(m.serialize()).toString('base64');
async function withService(options,fn){
 const s=createSignerService({keypair:operator,token,programId:program,now:()=>NOW,...options});
 await new Promise(resolve=>s.server.listen(0,'127.0.0.1',resolve));
 const post=body=>fetch('http://127.0.0.1:'+s.server.address().port+'/sign',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
 try{await fn(post);}finally{await new Promise(resolve=>s.server.close(resolve));}
}
const scoped=()=>({message:wire(msg([kids(4)])),operationId:'lease:1',operationKey:'settle',campaign:campaign.toBase58(),fencingToken:1});
test('version-2 signer requires live lease evidence; missing, expired, unavailable and near-expiry leases sign nothing',async()=>{
 const caps=new Map([[campaign.toBase58(),normalizeCapability(grant({programVersion:2,capabilityId:'grant'}),{now:()=>NOW})]]);
 await withService({capabilities:caps},async post=>{assert.equal((await post(scoped())).status,503);});
 let evidence={allowed:false,validForMs:0},crash=false;
 await withService({capabilities:caps,authorizeLease:async()=>{if(crash)throw Error('database offline');return evidence;}},async post=>{
  assert.equal((await post(scoped())).status,409,'first-ever signature denied without live lease');
  evidence={allowed:true,validForMs:500};assert.equal((await post(scoped())).status,409);
  crash=true;assert.equal((await post(scoped())).status,503);crash=false;
  evidence={allowed:true,validForMs:30000};assert.equal((await post({...scoped(),operationKey:undefined})).status,403);
  assert.equal((await post(scoped())).status,200);
 });
});
test('async capability lookups cannot bypass the signer per-minute limit or grant expiry',async()=>{
 let entered=0,open;const gate=new Promise(resolve=>{open=resolve;});
 const caps=new Map([[campaign.toBase58(),normalizeCapability(grant(),{now:()=>NOW})]]);
 await withService({maxPerMinute:1,capabilities:async()=>{if(++entered===8)open();await gate;return caps;}},async post=>{
  const responses=await Promise.all(Array.from({length:8},(_,i)=>post({...scoped(),operationId:'burst:'+i})));
  assert.equal(responses.filter(r=>r.status===200).length,1);assert.equal(responses.filter(r=>r.status===429).length,7);
 });
 let now=NOW;
 await withService({now:()=>now,capabilities:async()=>{now=NOW+3600001;return caps;}},async post=>{
  assert.equal((await post(scoped())).status,403,'grant expired during lookup is refused');
 });
});
test('time spent after lease verification cannot produce a signature past the signing window',async()=>{
 const caps=new Map([[campaign.toBase58(),normalizeCapability({...grant(),programVersion:2,tags:[4]},{now:()=>NOW})]]);
 let reads=0;
 await withService({capabilities:caps,authorizeLease:async()=>({allowed:true,validForMs:2000}),monotonicNow:()=>++reads<=2?0:1500},async post=>{
  const result=await post(scoped());assert.equal(result.status,409);const body=await result.json();assert.equal(body.category,'stale-fencing-token');assert.equal(body.signature,undefined);
 });
});

test('process ownership loss during lookup or at the final signing boundary returns no signature',async()=>{
 const caps=new Map([[campaign.toBase58(),normalizeCapability(grant(),{now:()=>NOW})]]);
 for(const stage of ['entry','lookup','boundary']){
  let calls=0,owned=stage!=='entry';
  await withService({capabilities:async()=>{if(stage==='lookup')owned=false;return caps;},ownershipValid:()=>{calls++;return owned&&(stage!=='boundary'||calls<3);}},async post=>{
   const response=await post(scoped());assert.equal(response.status,503);assert.equal((await response.json()).signature,undefined);
  });
 }
});
test('operating-return capability: exactly one transfer from the operator to the sealed creator plus one memo; keeper grants never return',()=>{
 const creator=Keypair.generate().publicKey,memo=new TransactionInstruction({programId:new PublicKey(MEMO_PROGRAM),keys:[],data:Buffer.from('KIDS operating return:'+'a'.repeat(64))}),expiresAt=new Date(Date.now()+3600000).toISOString();
 const raw={campaign:campaign.toBase58(),programId:program.toBase58(),genesisHash:GENESIS,kind:'operating-return',programVersion:3,tags:[],recipients:[creator.toBase58()],expiresAt};
 const cap=normalizeCapability(raw);assert.equal(cap.kind,'operating-return');assert.equal(cap.tags.size,0);assert.deepEqual(cap.recipients,[creator.toBase58()]);
 for(const bad of [{tags:[3]},{recipients:[]},{recipients:[creator.toBase58(),other.toBase58()]},{programVersion:2},{kind:'keeper',tags:[]}])assert.throws(()=>normalizeCapability({...raw,...bad}),JSON.stringify(bad));
 const transfer=(to,lamports)=>SystemProgram.transfer({fromPubkey:operator.publicKey,toPubkey:to,lamports});
 const build=instructions=>new TransactionMessage({payerKey:operator.publicKey,recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:20000}),...instructions]}).compileToV0Message();
 const request=(message,capabilities)=>evaluateCapabilityRequest({message,campaign:campaign.toBase58(),fencingToken:1,operationId:'return-1',operationKey:'operating-return',capabilities,operator:operator.publicKey});
 const grants=new Map([[campaign.toBase58(),cap]]);
 const ok=request(build([transfer(creator,79995000),memo]),grants);
 assert.equal(ok.ok,true,ok.reason);assert.equal(ok.spendLamports,80000000n);assert.deepEqual(ok.operations,['cu-limit','operating-return','memo']);assert.equal(ok.capability.kind,'operating-return');
 for(const [reason,ixs] of [
  ['another destination',[transfer(stranger,1),memo]],
  ['no memo',[transfer(creator,1)]],
  ['two transfers',[transfer(creator,1),transfer(creator,1),memo]],
  ['a launch program instruction beside the transfer',[kids(3),transfer(creator,1),memo]],
  ['a refund instruction alone',[kids(3)]],
  ['over the transfer limit',[transfer(creator,500000001),memo]],
  ['an account sponsorship',[createAssociatedTokenAccountIdempotentInstruction(operator.publicKey,other,creator,other),transfer(creator,1),memo]],
 ]){const v=request(build(ixs),grants);assert.equal(v.ok,false,reason);}
 const keeper=normalizeCapability({...raw,kind:'keeper',tags:[3],recipients:[]});
 assert.equal(request(build([transfer(creator,1),memo]),new Map([[campaign.toBase58(),keeper]])).ok,false,'a keeper grant cannot move SOL to anyone');
 const path=join(mkdtempSync(join(tmpdir(),'kids-return-')),'registry.sqlite'),registry=openRegistry({path});registry.migrate();
 registry.campaigns.upsert({genesisHash:GENESIS,programId:program.toBase58(),campaign:campaign.toBase58(),network:'localnet',mode:'standard',campaignVersion:3,registryStatus:'planned'});
 const granted=registry.capabilities.grant({genesisHash:GENESIS,programId:program.toBase58(),campaign:campaign.toBase58(),kind:'operating-return',programVersion:3,tags:[],recipients:[creator.toBase58()],expiresAt});
 assert.equal(granted.kind,'operating-return');assert.deepEqual(granted.recipients,[creator.toBase58()]);
 assert.throws(()=>registry.capabilities.grant({genesisHash:GENESIS,programId:program.toBase58(),campaign:campaign.toBase58(),kind:'operating-return',programVersion:3,tags:[3],recipients:[creator.toBase58()],expiresAt}),/no tags/);
 registry.close();
});
test('funding-first bookkeeping tags (44-47) pass the capability path under a version-3 grant that carries them, never under a per-receipt grant or a version-2 grant',()=>{
 const v3=new Map([[campaign.toBase58(),normalizeCapability(grant({programVersion:3,tags:[42,44,45,46,47]}),{now:()=>NOW})]]);
 for(const tag of [44,45,46,47]){
  const r=ev(msg([kids(tag)]),{capabilities:v3});assert.equal(r.ok,true,'tag '+tag+': '+r.reason);assert.deepEqual(r.operations,['kids:'+tag]);
 }
 const perReceipt=new Map([[campaign.toBase58(),normalizeCapability(grant({programVersion:3,tags:[3,4,6]}),{now:()=>NOW})]]);
 assert.match(ev(msg([kids(46)]),{capabilities:perReceipt}).reason,/tag 46/,'a per-receipt grant never covers the bookkeeping tags');
 assert.throws(()=>normalizeCapability(grant({programVersion:2,tags:[44]}),{now:()=>NOW}),/version/,'a version-2 grant cannot carry a funding-first tag');
 for(const tag of [44,45,46,47])assert.ok(KEEPER_TAGS.has(tag),'signer policy allows tag '+tag);
});
