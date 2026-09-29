// Registry gates (plan section 8, P1): migration on a temp sqlite file, idempotent campaign upserts that never blank a
// row, cursor pagination with filters, intent idempotency, fenced job leases (a stale token cannot complete) and
// chain-event dedupe. Postgres concurrency is exercised in registry/postgres.test.mjs.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PublicKey} from '@solana/web3.js';
import {openRegistry,PostgresRegistry,parseCampaignId,campaignId,toPostgresPlaceholders,splitStatements,mergeCampaign,normalizeCampaign,REGISTRY_SCHEMA_VERSION,MIGRATIONS,MAX_PAGE} from '../registry/registry.mjs';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const GENESIS=addr(200),PROGRAM=addr(201),WALLET=addr(202);
const campaign=(n,extra={})=>({genesisHash:GENESIS,programId:PROGRAM,campaign:addr(n),mode:'family',campaignVersion:3,registryStatus:'archived',sourcePaths:['fixture/'+n],...extra});
function clock(start=1790000000000){let t=start;return {now:()=>t,advance(ms){t+=ms;}};}
test('schema migrates once on a temp sqlite file and reopens at the recorded version',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-registry-'));const path=join(dir,'nested','registry.sqlite');
 const r=openRegistry({driver:'sqlite',path});
 assert.equal(r.schemaVersion(),0);assert.deepEqual(r.migrate(),MIGRATIONS.map(m=>m.version));assert.deepEqual(r.migrate(),[]);assert.equal(r.schemaVersion(),REGISTRY_SCHEMA_VERSION);
 const tables=r.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(x=>x.name);
 for(const t of ['schema_migrations','campaigns','campaign_profiles','creator_drafts','transaction_intents','commitments','claims','mint_leases','operational_budgets','jobs','chain_events','market_cursors','candles','signer_capabilities'])assert.ok(tables.includes(t),t+' exists');
 r.close();assert.ok(existsSync(path));
 const again=openRegistry({driver:'sqlite',path});assert.deepEqual(again.migrate(),[]);assert.equal(again.campaigns.count(),0);again.close();
});
test('the migration file splits into statements a Postgres driver could run one by one; placeholders rewrite to $n',()=>{
 const {readFileSync}=globalThis.process.getBuiltinModule('node:fs');
 const statements=splitStatements(readFileSync(new URL('../registry/schema.sql',import.meta.url),'utf8'));
 assert.ok(statements.length>=13);for(const s of statements){assert.doesNotMatch(s,/PRAGMA|AUTOINCREMENT|WITHOUT ROWID|SERIAL|JSONB/);assert.match(s,/^CREATE (TABLE|INDEX) IF NOT EXISTS/);}
 assert.equal(toPostgresPlaceholders('SELECT ? , ?'),'SELECT $1 , $2');
});
test('campaign upserts are idempotent, never blank a field, keep sealed terms and report disagreements',()=>{
 const r=openRegistry();r.migrate();
 const first=r.campaigns.upsert(campaign(1,{softCapLamports:'1000',name:'One',chainStatus:'open',sourceSlot:100}));
 assert.equal(first.inserted,true);assert.equal(first.campaign.ordinal,1);
 const same=r.campaigns.upsert(campaign(1,{softCapLamports:'1000',name:'One',chainStatus:'open',sourceSlot:100}));
 assert.deepEqual([same.inserted,same.updated,same.conflicts],[false,false,[]]);
 const sparse=r.campaigns.upsert(campaign(1,{registryStatus:'historical'}));
 assert.equal(sparse.updated,false,'an emptier source changes nothing');assert.equal(sparse.campaign.name,'One');assert.equal(sparse.campaign.registryStatus,'archived','lower rank does not win');
 const conflict=r.campaigns.upsert(campaign(1,{softCapLamports:'2000',hardCapLamports:'9000'}));
 assert.deepEqual(conflict.conflicts,['softCapLamports']);assert.equal(conflict.campaign.softCapLamports,'1000');assert.equal(conflict.campaign.hardCapLamports,'9000','a missing sealed field is filled');
 const older=r.campaigns.upsert(campaign(1,{chainStatus:'launched',sourceSlot:50}));assert.equal(older.campaign.chainStatus,'open','an older slot never moves the projection');
 const newer=r.campaigns.upsert(campaign(1,{chainStatus:'launched',sourceSlot:150,sourcePaths:['fixture/other']}));
 assert.equal(newer.campaign.chainStatus,'launched');assert.deepEqual(newer.campaign.sourcePaths,['fixture/1','fixture/other']);
 const active=r.campaigns.upsert(campaign(1,{registryStatus:'active',terms:{a:1}}));assert.equal(active.campaign.registryStatus,'active');
 const terms=r.campaigns.upsert(campaign(1,{terms:{b:2}}));assert.deepEqual(terms.campaign.terms,{a:1,b:2},'terms merge as an object');
 assert.equal(r.campaigns.get(addr(1)).ordinal,1);assert.equal(r.campaigns.get(campaignId(campaign(1))).name,'One');assert.equal(r.campaigns.get(addr(99)),null);
 assert.throws(()=>r.campaigns.upsert({...campaign(2),mode:'other'}),/mode/);assert.throws(()=>r.campaigns.upsert(campaign(2,{softCapLamports:'1e9'})),/decimal/);assert.throws(()=>r.campaigns.upsert(campaign(2,{creator:'nope'})),/address/);
 r.close();
});
test('a bare address shared by two ledgers is refused as ambiguous; the full id resolves',()=>{
 const r=openRegistry();r.migrate();
 r.campaigns.upsert(campaign(3));r.campaigns.upsert({...campaign(3),genesisHash:addr(210)});
 assert.throws(()=>r.campaigns.get(addr(3)),e=>e.code==='AMBIGUOUS');
 assert.equal(r.campaigns.get({genesisHash:addr(210),programId:PROGRAM,campaign:addr(3)}).genesisHash,addr(210));
 assert.deepEqual(parseCampaignId(addr(3)),{campaign:addr(3)});assert.deepEqual(parseCampaignId(GENESIS+':'+PROGRAM+':'+addr(3)),{genesisHash:GENESIS,programId:PROGRAM,campaign:addr(3)});
 for(const bad of ['','x','a:b','a:b:c',addr(3)+':'+addr(3),addr(3)+'?x'])assert.equal(parseCampaignId(bad),null);
 r.close();
});
test('list pages newest first with a cursor and filters by status and mode',()=>{
 const r=openRegistry();r.migrate();
 for(let n=1;n<=7;n++)r.campaigns.upsert(campaign(n,{mode:n%2?'family':'standard',chainStatus:n<=4?'open':null}));
 const p1=r.campaigns.list({limit:3});assert.deepEqual(p1.campaigns.map(c=>c.ordinal),[7,6,5]);assert.ok(p1.nextCursor);
 const p2=r.campaigns.list({limit:3,cursor:p1.nextCursor});assert.deepEqual(p2.campaigns.map(c=>c.ordinal),[4,3,2]);
 const p3=r.campaigns.list({limit:3,cursor:p2.nextCursor});assert.deepEqual(p3.campaigns.map(c=>c.ordinal),[1]);assert.equal(p3.nextCursor,null);
 assert.deepEqual(r.campaigns.list({status:'open'}).campaigns.map(c=>c.ordinal),[4,3,2,1]);
 assert.deepEqual(r.campaigns.list({status:'unknown'}).campaigns.map(c=>c.ordinal),[7,6,5]);
 assert.deepEqual(r.campaigns.list({mode:'standard'}).campaigns.map(c=>c.ordinal),[6,4,2]);
 assert.deepEqual(r.campaigns.list({mode:'standard',status:'open',limit:1}).campaigns.map(c=>c.ordinal),[4]);
 assert.deepEqual(r.campaigns.list({registryStatus:'active'}).campaigns,[]);
 assert.throws(()=>r.campaigns.list({cursor:'not-a-cursor'}),/cursor/);assert.throws(()=>r.campaigns.list({status:'weird'}),/status/);assert.throws(()=>r.campaigns.list({limit:MAX_PAGE+1}),/limit/);
 r.close();
});
test('intents are idempotent per campaign, wallet, action and key; a reused key with other parameters is refused',()=>{
 const r=openRegistry();r.migrate();r.campaigns.upsert(campaign(1));
 const base={...campaign(1),wallet:WALLET,action:'commit',idempotencyKey:'client-1',params:{lamports:'5000000000'}};
 const a=r.intents.create(base),b=r.intents.create({...base,params:{lamports:'5000000000'}});
 assert.equal(a.created,true);assert.equal(b.created,false);assert.equal(a.intent.intentId,b.intent.intentId);assert.equal(b.intent.status,'prepared');
 assert.throws(()=>r.intents.create({...base,params:{lamports:'1'}}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 const other=r.intents.create({...base,idempotencyKey:'client-2'});assert.notEqual(other.intent.intentId,a.intent.intentId);
 const otherWallet=r.intents.create({...base,wallet:addr(203)});assert.equal(otherWallet.created,true);
 assert.equal(r.intents.progress({intentId:a.intent.intentId,status:'submitted',signature:'5'.repeat(64),messageDigest:'a'.repeat(64)}),true);
 const after=r.intents.get(a.intent.intentId);assert.equal(after.status,'submitted');assert.equal(after.messageDigest,'a'.repeat(64));
 assert.throws(()=>r.intents.create({...base,messageDigest:'b'.repeat(64)}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 assert.throws(()=>r.intents.create({...base,campaign:addr(77)}),/FOREIGN KEY|constraint/i,'an intent needs a registered campaign');
 r.close();
});
test('job leases carry a fencing token: an expired holder cannot complete, renew or fail the job',()=>{
 const c=clock();const r=openRegistry({now:c.now});r.migrate();r.campaigns.upsert(campaign(1));
 const q=r.jobs.enqueue({...campaign(1),operationKey:'settle',jobClass:'settlement',payload:{receipts:196}});
 assert.equal(q.created,true);assert.equal(r.jobs.enqueue({...campaign(1),operationKey:'settle',jobClass:'settlement'}).created,false,'one job per operation key');
 const w1=r.jobs.lease({owner:'worker-1',ttlMs:5000});assert.equal(w1.fencingToken,1);assert.equal(w1.leaseOwner,'worker-1');assert.equal(w1.state,'leased');
 assert.equal(r.jobs.lease({owner:'worker-2',ttlMs:5000}),null,'nothing else is due');
 assert.equal(r.jobs.renew({jobId:w1.jobId,token:1,owner:'worker-1',ttlMs:5000}),true);
 c.advance(6000);
 const w2=r.jobs.lease({owner:'worker-2',ttlMs:5000});assert.equal(w2.jobId,w1.jobId);assert.equal(w2.fencingToken,2);assert.equal(w2.retryCount,1);
 assert.throws(()=>r.jobs.complete({jobId:w1.jobId,token:1,result:{stale:true}}),e=>e.code==='STALE_LEASE');
 assert.equal(r.jobs.renew({jobId:w1.jobId,token:1,owner:'worker-1'}),false);
 assert.throws(()=>r.jobs.fail({jobId:w1.jobId,token:1,error:'late'}),e=>e.code==='STALE_LEASE');
 const still=r.jobs.get(w1.jobId);assert.equal(still.state,'leased');assert.equal(still.leaseOwner,'worker-2');assert.equal(still.result,null,'the stale holder published nothing');
 const done=r.jobs.complete({jobId:w2.jobId,token:2,result:{settled:196}});assert.equal(done.state,'done');assert.deepEqual(done.result,{settled:196});assert.equal(done.leaseOwner,null);
 assert.throws(()=>r.jobs.complete({jobId:w2.jobId,token:2}),e=>e.code==='STALE_LEASE','a finished job cannot be completed twice');
 const q2=r.jobs.enqueue({...campaign(1),operationKey:'refund',jobClass:'refund'});const w3=r.jobs.lease({owner:'worker-3',jobClass:'refund'});assert.equal(w3.jobId,q2.job.jobId);
 const back=r.jobs.fail({jobId:w3.jobId,token:w3.fencingToken,error:'rpc timeout',requeue:true});assert.equal(back.state,'queued');assert.equal(r.jobs.lease({owner:'worker-4'}).fencingToken,2);
 r.close();
});
test('chain events dedupe on genesis, signature, instruction path and kind; finalized wins, block time fills once',()=>{
 const r=openRegistry();r.migrate();
 const ev={genesisHash:GENESIS,signature:'3'.repeat(64),instructionPath:'2.1',kind:'commit',programId:PROGRAM,campaign:addr(1),slot:500};
 assert.equal(r.chainEvents.record(ev).inserted,true);
 const again=r.chainEvents.record({...ev,slot:999,blockTime:1790000000,status:'finalized',asset:{lamports:'5'}});
 assert.equal(again.inserted,false);assert.equal(again.event.status,'finalized');assert.equal(again.event.blockTime,1790000000);assert.equal(again.event.slot,500,'the first observation keeps its slot');
 assert.equal(r.chainEvents.record({...ev,status:'confirmed'}).event.status,'finalized','finalized never downgrades');
 assert.equal(r.chainEvents.record({...ev,kind:'refund'}).inserted,true);assert.equal(r.chainEvents.record({...ev,instructionPath:'2.2'}).inserted,true);
 assert.equal(r.chainEvents.list({...campaign(1)}).length,3);
 assert.throws(()=>r.chainEvents.record({...ev,instructionPath:'x'}),/instruction path/);assert.throws(()=>r.chainEvents.record({...ev,status:'maybe'}),/status/);
 r.close();
});
test('the Postgres adapter requires an explicit connection URL',()=>{
 assert.throws(()=>new PostgresRegistry(),/Postgres connection URL/);
 assert.throws(()=>openRegistry({driver:'postgres'}),/Postgres connection URL/);assert.throws(()=>openRegistry({driver:'mysql'}),/Unknown registry driver/);
});
test('merge rules are pure: nulls skipped, sealed kept, rank wins',()=>{
 const existing={...normalizeCampaign(campaign(1,{softCapLamports:'1',registryStatus:'planned'})),ordinal:1,createdAt:'t',updatedAt:'t'};
 const {merged,conflicts}=mergeCampaign(existing,normalizeCampaign(campaign(1,{softCapLamports:'2',registryStatus:'historical',name:'N'})));
 assert.deepEqual(conflicts,['softCapLamports']);assert.equal(merged.softCapLamports,'1');assert.equal(merged.registryStatus,'planned');assert.equal(merged.name,'N');
});
