// Real database gate. Use an isolated PostgreSQL database; every run owns a fresh schema.
// KIDS_TEST_POSTGRES_URL must never point at a production database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {createJobRunner} from '../jobs/runner.mjs';
import {createBudgetLedger} from '../budgets.mjs';
import {loadCapabilities} from '../signer/capabilities.mjs';
import {operatorPacketCases} from '../test/helpers/operator-packet-cases.mjs';
import {mintLeaseCases} from '../test/helpers/mint-lease-cases.mjs';
import {PostgresAccountStore} from '../../interaction-review/server/postgres-account-store.mjs';
import {generateKeypair,signWithSeed} from '../../shared/solana.mjs';
import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry, MIGRATIONS, campaignId} from './registry.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const identity=n=>({genesisHash:addr(200),programId:addr(201),campaign:addr(n)});
const campaign=n=>({...identity(n),mode:'standard',campaignVersion:2,registryStatus:'active',sourcePaths:['test/'+n]});
const owner=addr(202);

test('PostgreSQL registry: multiple replicas, durable state and financial concurrency', {skip:!url}, async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:url,max:1});
 const pools=[];let now=1790000000000;
 const make=()=>{const pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`,statement_timeout:10000});pools.push(pool);return new PostgresRegistry({pool,now:()=>now});};
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  const a=make(),b=make();
  await t.test('two replicas migrate once without partial schema or sequence reset',async()=>{
   const applied=await Promise.all([a.migrate(),b.migrate()]);
   assert.deepEqual(applied.flat().sort((a,b)=>a-b),MIGRATIONS.map(m=>m.version));
   assert.deepEqual(await a.migrate(),[]);
  });
  await t.test('100 concurrent campaigns get distinct ordinals and preserve sealed terms',async()=>{
   const rows=await Promise.all(Array.from({length:100},(_,i)=>(i%2?a:b).campaigns.upsert({...campaign(i+1),softCapLamports:'50000000000'})));
   assert.equal(new Set(rows.map(x=>x.campaign.ordinal)).size,100);
   assert.equal(await b.campaigns.count(),100);
   const updates=await Promise.all(Array.from({length:12},(_,i)=>(i%2?a:b).campaigns.upsert({...campaign(1),hardCapLamports:'100000000000',softCapLamports:'1'})));
   assert.ok(updates.every(x=>x.campaign.softCapLamports==='50000000000'&&x.conflicts.includes('softCapLamports')));
   assert.equal((await b.campaigns.get(identity(1))).hardCapLamports,'100000000000');
   await a.migrate();assert.ok((await a.campaigns.upsert(campaign(101))).campaign.ordinal>100);
  });
  await t.test('creator directory and literal search stay scoped across keyset pages',async()=>{
   for(const n of [1,2,3])await a.campaigns.upsert({...campaign(n),creator:owner,name:n===1?'Percent %_!':'Shared name',symbol:'DIR'+n});
   const first=await a.campaigns.list({creator:owner,limit:2});assert.equal(first.campaigns.length,2);assert.ok(first.nextCursor);
   const next=await b.campaigns.list({creator:owner,cursor:first.nextCursor,limit:2});assert.equal(next.campaigns.length,1);assert.deepEqual(new Set([...first.campaigns,...next.campaigns].map(c=>c.campaign)),new Set([1,2,3].map(n=>identity(n).campaign)));
   assert.equal((await a.campaigns.list({query:'%_!'})).campaigns.length,1);assert.equal((await a.campaigns.list({query:'dir2'})).campaigns[0].campaign,identity(2).campaign);assert.equal((await a.campaigns.list({creator:addr(203)})).campaigns.length,0);
  });
  await t.test('signer lease authority observes another replica revoking a grant and uses database time',async()=>{
   const current=Date.now();
   const cap=await a.capabilities.grant({...identity(90),tags:[4],programVersion:2,expiresAt:new Date(current+60000).toISOString()});
   const job=(await a.jobs.enqueue({...identity(90),operationKey:'lease-authority',jobClass:'settlement'})).job;
   const leased=await a.jobs.leaseById({jobId:job.jobId,token:job.fencingToken,owner:'worker',ttlMs:5000});
   const input={capability:cap,operationKey:'lease-authority',fencingToken:leased.fencingToken};
   // The host clock is intentionally in the past. Both worker and signer
   // must agree on the database clock, without granting a historical lease.
   assert.equal((await b.capabilities.authorizeLease(input)).allowed,true);
   await a.query('UPDATE jobs SET lease_expires_at=? WHERE job_id=?',[new Date(current-1).toISOString(),job.jobId]);
   assert.equal((await b.capabilities.authorizeLease(input)).allowed,false);
   await a.query('UPDATE jobs SET lease_expires_at=? WHERE job_id=?',[new Date(current+30000).toISOString(),job.jobId]);
   assert.equal((await b.capabilities.authorizeLease(input)).allowed,true);
   await a.capabilities.revoke(cap.capabilityId);
   assert.equal((await b.capabilities.authorizeLease(input)).allowed,false);
  });
  await t.test('draft revision race has exactly one winner, loser must reload',async()=>{
   const attempts=await Promise.allSettled([a,b].map((r,i)=>r.drafts.save({creator:owner,id:'draft',revision:0,body:{name:'draft '+i}})));
   assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
   assert.equal(attempts.find(x=>x.status==='rejected').reason.code,'REVISION_CONFLICT');
   assert.equal((await b.drafts.get(owner,'draft')).revision,1);
  });
  await t.test('idempotent intents reject changed financial parameters across replicas',async()=>{
   const input={...identity(1),wallet:owner,action:'commit',idempotencyKey:'same',params:{lamports:'5000000000'}};
   const results=await Promise.all(Array.from({length:12},(_,i)=>(i%2?a:b).intents.create(input)));
   assert.equal(results.filter(x=>x.created).length,1);
   assert.equal(new Set(results.map(x=>x.intent.intentId)).size,1);
   await assert.rejects(b.intents.create({...input,params:{lamports:'1'}}),{code:'IDEMPOTENCY_CONFLICT'});
  });
  let signedPacket;
  await t.test('wallet packet is shared, signed once and remains the same after uncertain send',async()=>{
   const input={owner,campaignId:campaignId(identity(1)),requestKey:'commit-1',descriptor:'commit:5',prepared:{amount:'5000000000',lastValidBlockHeight:100}};
   const packets=await Promise.all(Array.from({length:12},(_,i)=>(i%2?a:b).walletPackets.prepare(input)));
   assert.equal(new Set(packets.map(x=>x.id)).size,1);
   await assert.rejects(b.walletPackets.prepare({...input,descriptor:'commit:6'}),{code:'IDEMPOTENCY_CONFLICT'});
   const p=packets[0];
   const races=await Promise.allSettled([a,b].map((r,i)=>r.walletPackets.sign({id:p.id,owner,signedBase64:Buffer.from('synthetic-packet-'+i).toString('base64'),signature:String(i+3).repeat(64)})));
   assert.equal(races.filter(x=>x.status==='fulfilled').length,1);
   signedPacket=await a.walletPackets.get(p.id);
   await b.walletPackets.progress(p.id,'expired','old unsigned read',{expectedStatus:'prepared'});assert.equal((await b.walletPackets.get(p.id)).status,'signed');
   await b.walletPackets.progress(p.id,'unknown');
   const read=await b.walletPackets.get(p.id);
   assert.equal(read.signedBase64,signedPacket.signedBase64);assert.equal(read.signature,signedPacket.signature);
   await a.walletPackets.progress(p.id,'confirmed');await b.walletPackets.progress(p.id,'unknown');
   assert.equal((await b.walletPackets.get(p.id)).status,'confirmed');
   await a.walletPackets.progress(p.id,'finalized');assert.equal((await b.walletPackets.get(p.id)).status,'finalized');
  });
  await t.test('two creators cannot reserve the same mint; transition compare-and-set wins once',async()=>{
   const input={mint:addr(150),creator:owner,network:'localnet',draftId:'d1',idempotencyKey:'mint-1',signerRef:'fixture:mint-1'};
   const attempts=await Promise.allSettled([a,b].map((r,i)=>r.mintLeases.insert({...input,creator:addr(202+i)})));
   assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
   const lease=await b.mintLeases.byMint(input.mint);
   const moved=await Promise.all([a,b].map(r=>r.mintLeases.transition({leaseId:lease.leaseId,from:'reserved',to:'signed-pending'})));
   assert.equal(moved.filter(Boolean).length,1);
  });
  await t.test('independent lane lease reaches a launch behind 250 fee jobs and fences stale workers',async()=>{
   for(let i=0;i<250;i++)await a.jobs.enqueue({...identity(1),operationKey:'fees:'+i,jobClass:'fee-harvest'});
   const launch=await b.jobs.enqueue({...identity(2),operationKey:'launch',jobClass:'launch'});
   const lease=await a.jobs.leaseNext({owner:'launch-1',jobClasses:['launch'],ttlMs:1000});
   assert.equal(lease.jobId,launch.job.jobId);
   assert.equal(await b.jobs.leaseNext({owner:'launch-2',jobClasses:['launch']}),null);
   const feeLeases=await Promise.all(Array.from({length:16},(_,i)=>(i%2?a:b).jobs.leaseNext({owner:'fee-'+i,jobClasses:['fee-harvest']})));
   assert.equal(new Set(feeLeases.map(j=>j.jobId)).size,16);
   now+=1001;
   await a.query("UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE job_id=?",[lease.jobId]);
   assert.equal(await a.jobs.holds({jobId:lease.jobId,token:lease.fencingToken,owner:'launch-1'}),false);
   const takeover=await b.jobs.leaseNext({owner:'launch-2',jobClasses:['launch']});
   assert.equal(takeover.fencingToken,lease.fencingToken+1);
   await assert.rejects(a.jobs.complete({jobId:lease.jobId,token:lease.fencingToken}),{code:'STALE_LEASE'});
   assert.equal((await b.jobs.complete({jobId:takeover.jobId,token:takeover.fencingToken})).state,'done');
  });
  await t.test('a slow worker slot does not block refill, while another lane remains untouched',async()=>{
   const work=make();let unblock,slowEntered,fastFinished;
   const blocked=new Promise(r=>{unblock=r;}),entered=new Promise(r=>{slowEntered=r;}),finished=new Promise(r=>{fastFinished=r;});
   let fast=0,peak=0,active=0;
   for(let i=0;i<6;i++)await a.jobs.enqueue({...identity(i+10),operationKey:'slot-'+i,jobClass:'settlement',payload:{slow:i===0}});
   const worker=createJobRunner({registry:work,lane:'lifecycle',owner:'continuous',concurrency:2,handlers:{settlement:{async run(job){active++;peak=Math.max(peak,active);try{if(job.payload.slow){slowEntered();await blocked;}else{fast++;if(fast===5)fastFinished();}return {outcome:'done'};}finally{active--;}}}}});
   assert.throws(()=>createJobRunner({registry:work,owner:'mixed',handlers:{}}),/explicit independent lane/);
   const serving=worker.serve({pollMs:10});
   try{
    await Promise.race([Promise.all([entered,finished]),new Promise((_,reject)=>{const timeout=setTimeout(()=>reject(Error('Worker did not refill its free slot')),3000);timeout.unref();})]);
    assert.equal(fast,5);assert.ok(peak<=2);
    assert.ok((await a.jobs.listForCampaign({...identity(1),limit:300})).some(j=>j.jobClass==='fee-harvest'&&j.state==='queued'));
   }finally{worker.stop();unblock();await serving;await worker.drain();}
  });
  await t.test('wallet sign-in works across replicas, consumes a nonce once, scopes origin and revokes everywhere',async()=>{
   const left=new PostgresAccountStore({registry:a,origin:'https://kids.test',clock:()=>now});
   const right=new PostgresAccountStore({registry:b,origin:'https://kids.test',clock:()=>now});
   const other=new PostgresAccountStore({registry:b,origin:'https://other.test',clock:()=>now});
   const wallet=generateKeypair(),challenge=await left.challenge(wallet.address);
   const proof={id:challenge.id,signature:signWithSeed(wallet.seed,Buffer.from(challenge.message)).toString('base64')};
   await assert.rejects(other.verify(proof),/expired or already used/);
   const results=await Promise.allSettled([left.verify(proof),right.verify(proof)]);
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
   const session=results.find(r=>r.status==='fulfilled').value;
   assert.equal((await right.session(session.token)).owner,wallet.address);
   assert.equal(await other.session(session.token),null);
   await left.logout(session.token);assert.equal(await right.session(session.token),null);
   const pending=await Promise.allSettled(Array.from({length:10},(_,i)=>(i%2?left:right).challenge(wallet.address)));
   assert.equal(pending.filter(r=>r.status==='fulfilled').length,10,'a challenge request is never refused: the oldest pending ones give way');
   const kept=Number((await left.registry.query('SELECT COUNT(*) AS n FROM wallet_auth_challenges WHERE owner=?',[wallet.address])).rows[0].n);assert.ok(kept>=1&&kept<=5,'at most five pending challenges survive concurrent requests: '+kept);
   now+=300001;await left.pruneExpired();
   assert.equal((await left.challenge(wallet.address)).owner,wallet.address);
  });
  await t.test('HTTP replicas share sign-in, CSRF and drafts through the authenticated gateway',async()=>{
   const [{accountPlugin},{createApiServer},{createPublicLaunchAccount},{createPublicLaunchAccess},{gatewayHeaders},{initialDraft}]=await Promise.all([
    import('../../interaction-review/server/account-plugin.mjs'),import('../../interaction-review/server/runtime.mjs'),
    import('../../interaction-review/server/public-launch-account.mjs'),import('../../interaction-review/server/public-launch-access.mjs'),
    import('../../shared/trusted-gateway.mjs'),import('../../interaction-review/src/public/launch-draft.mjs')]);
   const wallet=generateKeypair(),access=createPublicLaunchAccess({KIDS_PUBLIC_PILOT_WALLET:wallet.address});
   const csrfSecret=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),gatewaySecret=randomUUID();
   const priorGateway=process.env.KIDS_GATEWAY_INTERNAL_TOKEN;process.env.KIDS_GATEWAY_INTERNAL_TOKEN=gatewaySecret;
   const servers=[a,b].map(registry=>createApiServer({plugins:[accountPlugin({sharedAccounts:true,accountRegistry:registry,csrfSecret,publicLaunchService:createPublicLaunchAccount({registry,access})})],probe:async()=>true,probeInterval:60000}));
   try{
    await Promise.all(servers.map(r=>new Promise(resolve=>r.server.listen(0,'127.0.0.1',resolve))));
    async function request(index,path,{body,cookie='',csrf}={}){
     const method=body===undefined?'GET':'POST',base='http://127.0.0.1:'+servers[index].server.address().port;
     const res=await fetch(base+path,{method,headers:{origin:'https://kids.fun',cookie,...gatewayHeaders(method,path,'viewer',gatewaySecret),...(body===undefined?{}:{'content-type':'application/json','x-kids-csrf':csrf})},body:body===undefined?undefined:JSON.stringify(body)});
     return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
    }
    const state=await request(0,'/api/account/state');assert.equal(state.status,200);const csrf=state.body.csrf;
    const challenge=await request(0,'/api/account/challenge',{csrf,body:{owner:wallet.address}});assert.equal(challenge.status,200);
    const login=await request(1,'/api/account/verify',{csrf,body:{id:challenge.body.id,signature:signWithSeed(wallet.seed,Buffer.from(challenge.body.message)).toString('base64')}});assert.equal(login.status,200);assert.ok(login.cookie);
    assert.equal((await request(0,'/api/account/state',{cookie:login.cookie})).body.owner,wallet.address);
    const draft=initialDraft(null,{creator:wallet.address});draft.name='Replica draft';
    const saved=await request(1,'/api/account/launches/drafts/save',{csrf,cookie:login.cookie,body:{id:'replica-draft',revision:0,draft}});assert.equal(saved.status,200,JSON.stringify(saved.body));
    const listed=await request(0,'/api/account/launches/drafts',{cookie:login.cookie});assert.equal(listed.body.drafts[0].body.name,'Replica draft');
    assert.equal((await request(0,'/api/account/logout',{csrf,cookie:login.cookie,body:{}})).status,200);
    assert.equal((await request(1,'/api/account/launches/drafts',{cookie:login.cookie})).status,401);
   }finally{await Promise.all(servers.map(r=>r.shutdown()));if(priorGateway===undefined)delete process.env.KIDS_GATEWAY_INTERNAL_TOKEN;else process.env.KIDS_GATEWAY_INTERNAL_TOKEN=priorGateway;}
  });
  await t.test('transaction rollback leaves no write and returns all pool connections',async()=>{
   await assert.rejects(a.transaction(async()=>{await a.campaigns.upsert(campaign(120));throw Error('abort');}),/abort/);
   assert.equal(await b.campaigns.get(identity(120)),null);
   for(let i=0;i<20;i++)await assert.rejects(a.transaction(()=>{throw Error('abort');}),/abort/);
   assert.equal(pools[0].waitingCount,0);assert.equal(pools[0].idleCount,pools[0].totalCount);
  });
  await t.test('a fresh process connection recovers the signed packet and registry state',async()=>{
   const fresh=make();await fresh.migrate();
   const recovered=await fresh.walletPackets.get(signedPacket.id);
   assert.equal(recovered.signature,signedPacket.signature);assert.equal(recovered.signedBase64,signedPacket.signedBase64);
   assert.equal(await fresh.campaigns.count(),101);
  });
  await t.test('budget credits and spends are idempotent and bounded across replicas',async()=>{
   const ledgers=[a,b].map(registry=>createBudgetLedger({registry})),base={identity:identity(1),payer:owner};
   const credit={...base,lamports:1000n,operationKey:'confirmed-funding-1'};
   const results=await Promise.all(Array.from({length:20},(_,i)=>ledgers[i%2].reserve(credit)));
   assert.ok(results.every(r=>r.budget.reservedLamports==='1000'));
   const spends=await Promise.all(Array.from({length:20},(_,i)=>ledgers[i%2].spend({...base,lamports:100n,operationKey:'debit-'+i})));
   assert.equal(spends.filter(r=>r.outcome==='spent').length,10);assert.equal(spends.filter(r=>r.outcome==='insufficient').length,10);
   assert.equal((await ledgers[0].get(base)).spentLamports,'1000');assert.equal((await ledgers[1].get(base)).availableLamports,'0');
   const replay=await Promise.all(Array.from({length:20},(_,i)=>ledgers[i%2].spend({...base,lamports:100n,operationKey:'debit-'+i})));
   assert.deepEqual(replay,spends);
   await assert.rejects(ledgers[1].reserve({...credit,lamports:2000n}),{code:'IDEMPOTENCY_CONFLICT'});
   assert.equal((await ledgers[1].spend({...base,identity:identity(2),lamports:1n,operationKey:'other-campaign'})).outcome,'insufficient');
   assert.equal((await ledgers[0].spend({...base,payer:addr(204),lamports:1n,operationKey:'other-payer'})).outcome,'insufficient');
   await assert.rejects(b.budgets.put({...identity(1),payer:owner,reservedLamports:'1',spentLamports:'2',returnedLamports:'0',policy:'creator-funded-v1'}),/exceed/);
  });
  await t.test('async capability loading preserves program version and revocation across replicas',async()=>{
   const grant=await a.capabilities.grant({...identity(4),programVersion:2,tags:[3,4,6],expiresAt:new Date(now+60000).toISOString()});
   assert.equal(grant.programVersion,2);
   const loaded=await loadCapabilities({registry:b,now:()=>now});assert.equal(loaded.capabilities.get(identity(4).campaign).programVersion,2);
   await a.capabilities.revoke(grant.capabilityId);
   assert.equal((await loadCapabilities({registry:b,now:()=>now})).capabilities.has(identity(4).campaign),false);
   await assert.rejects(a.capabilities.grant({...identity(4),programVersion:99,tags:[4],expiresAt:new Date(now+60000).toISOString()}),/program version/);
  });
  await t.test('concurrent capability grants have a deterministic latest grant despite identical host time',async()=>{
   const grants=await Promise.all(Array.from({length:8},(_,i)=>(i%2?a:b).capabilities.grant({...identity(92),tags:[4],programVersion:2,expiresAt:new Date(now+60000).toISOString()})));
   assert.equal(new Set(grants.map(c=>c.createdAt)).size,8);
   const newest=grants.sort((x,y)=>x.createdAt.localeCompare(y.createdAt)).at(-1);
   assert.equal((await loadCapabilities({registry:a,now:()=>now})).capabilities.get(identity(92).campaign).capabilityId,newest.capabilityId);
   await b.capabilities.revoke(newest.capabilityId);
   assert.equal((await loadCapabilities({registry:a,now:()=>now})).capabilities.has(identity(92).campaign),false);
  });
  await t.test('mint inventory orchestration across registry replicas',async st=>mintLeaseCases(st,[a,b]));
  await t.test('replicas share upstream limits and fees cannot consume launch reserves',async()=>{
   const policy={ratePerSecond:2,burst:4,lanes:{lifecycle:{ratePerSecond:1,burst:2},harvest:{ratePerSecond:1,burst:2}}};
   const base={resource:'rpc-primary',policy};
   for(const lane of ['lifecycle','harvest'])await a.admission.consume({...base,lane});
   // Freeze refill for this concurrency assertion without relying on wall-clock speed.
   await a.query("UPDATE admission_buckets SET tokens_micro='2000000',updated_ms=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)+60000 WHERE resource=?",['rpc-primary']);
   const fees=await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).admission.consume({...base,lane:'harvest'})));
   assert.equal(fees.filter(r=>r.allowed).length,2);
   const launches=await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).admission.consume({...base,lane:'lifecycle'})));
   assert.equal(launches.filter(r=>r.allowed).length,2);
   assert.equal((await make().admission.consume({...base,lane:'harvest'})).allowed,false,'a new replica has no fresh quota');
   await assert.rejects(b.admission.consume({...base,lane:'harvest',policy:{...policy,lanes:{lifecycle:{ratePerSecond:1,burst:1},harvest:{ratePerSecond:1,burst:3}}}}),{code:'ADMISSION_POLICY_CONFLICT'});
  });
  await t.test('operator packets survive crash boundaries across database replicas',async st=>operatorPacketCases(st,[a.operatorPackets,b.operatorPackets]));
  await t.test('database dump restores the signed packet, auth data and queued jobs', {skip:!process.env.KIDS_TEST_PG_BIN}, async()=>{
   const temp=await mkdtemp(join(tmpdir(),'kids-registry-restore-'));
   const exec=promisify(execFile),parsed=new URL(url);
   const env={PATH:process.env.PATH,PGDATABASE:decodeURIComponent(parsed.pathname.slice(1)),PGHOST:parsed.searchParams.get('host')||parsed.hostname,PGPORT:parsed.searchParams.get('port')||parsed.port||'5432',PGUSER:parsed.searchParams.get('user')||decodeURIComponent(parsed.username),PGPASSWORD:decodeURIComponent(parsed.password)};
   const bin=process.env.KIDS_TEST_PG_BIN;
   const before=await admin.query(`SELECT COUNT(*)::int AS n FROM ${schema}.jobs`);
   const operatorBefore=(await admin.query(`SELECT operation_id,attempt,signed_base64 FROM ${schema}.operator_packets WHERE status='signed' ORDER BY operation_id`)).rows;
   assert.ok(operatorBefore.length>0);
   try{
    await exec(join(bin,'pg_dump'),['--format=custom','--schema',schema,'--file',join(temp,'test.dump')],{env});
    // This schema was created by this test and contains only synthetic data.
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await exec(join(bin,'pg_restore'),['--dbname',env.PGDATABASE,'--exit-on-error','--no-owner',join(temp,'test.dump')],{env});
    const restored=make();await restored.migrate();
    assert.equal((await restored.walletPackets.get(signedPacket.id)).signedBase64,signedPacket.signedBase64);
    assert.equal(await restored.campaigns.count(),101);
    assert.deepEqual((await admin.query(`SELECT operation_id,attempt,signed_base64 FROM ${schema}.operator_packets WHERE status='signed' ORDER BY operation_id`)).rows,operatorBefore);
    const after=await admin.query(`SELECT COUNT(*)::int AS n FROM ${schema}.jobs`);assert.equal(after.rows[0].n,before.rows[0].n);
    assert.ok((await admin.query(`SELECT COUNT(*)::int AS n FROM ${schema}.wallet_auth_challenges`)).rows[0].n>0);
   }finally{await rm(temp,{recursive:true,force:true});}
  });
  await t.test('scoped leasing excludes other ledgers, programs and old campaign versions before choosing a job',async()=>{
   const same=identity(120),otherLedger={...same,genesisHash:addr(210)},otherProgram={...same,programId:addr(211)},oldVersion=identity(121);
   for(const id of [otherLedger,otherProgram,oldVersion,same]){
    await a.campaigns.upsert({...id,mode:'standard',campaignVersion:id===oldVersion?1:2,registryStatus:'planned'});
    await a.jobs.enqueue({...id,jobClass:'scope-test',operationKey:'scope:one'});
   }
   const options={owner:'scoped',jobClasses:['scope-test'],scope:{genesisHash:same.genesisHash,programId:same.programId,campaignVersion:2}};
   const got=await b.jobs.leaseNext(options);assert.equal(got.campaign,same.campaign);assert.equal(got.genesisHash,same.genesisHash);assert.equal(got.programId,same.programId);
   assert.equal(await a.jobs.leaseNext(options),null,'old-version and foreign jobs remain unleased');
   for(const id of [otherLedger,otherProgram,oldVersion])assert.equal((await a.jobs.listForCampaign(id))[0].state,'queued');
  });
 }finally{await Promise.all(pools.map(p=>p.end()));await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
