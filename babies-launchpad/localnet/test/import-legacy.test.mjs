// Legacy import gates: a fixture folder (identities, current plan, plan archive, runtime manifest, runtime archive)
// becomes registry rows with the v3 adapter and source paths; rerunning changes nothing; an existing row is never blanked;
// unusable files are reported, not guessed.
import test from 'node:test';import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';import {join} from 'node:path';
import {openRegistry} from '../registry/registry.mjs';
import {importLegacyCampaigns,collectLegacySources,campaignFromManifest,campaignFromPlan,campaignFromIdentities,defaultSources,LEGACY_ADAPTER_VERSION} from '../registry/import-legacy.mjs';
const F=fileURLToPath(new URL('./fixtures/registry-legacy/',import.meta.url));
const sources=()=>({root:F,runtimeDir:join(F,'runtime'),planPath:join(F,'campaign-plan.json'),archiveDir:join(F,'archive'),identitiesPath:join(F,'identities.json')});
const MAINNET='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',LOCAL='YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf',PROGRAM='4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
test('every source becomes a row with the v3 adapter, its paths and the right registry status; sources of one campaign merge',async()=>{
 const r=openRegistry();r.migrate();const lines=[];
 const out=await importLegacyCampaigns({registry:r,sources:sources(),log:l=>lines.push(l)});
 assert.equal(out.total,4);assert.equal(lines[0].campaigns,4);assert.equal(lines[0].inserted,4);
 assert.deepEqual(out.skipped.map(s=>s.path.split('/').pop()),['campaign-plan-wrong-name.json']);
 const historical=r.campaigns.get({genesisHash:MAINNET,programId:PROGRAM,campaign:'8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR'});
 assert.equal(historical.registryStatus,'archived','identities + plan archive: archive rank wins');assert.equal(historical.chainStatus,'launched');assert.equal(historical.pool,'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8');
 assert.equal(historical.name,'Fixture test coin');assert.equal(historical.softCapLamports,'1000000000');assert.equal(historical.legacyAdapterVersion,LEGACY_ADAPTER_VERSION);assert.equal(historical.campaignVersion,3);assert.equal(historical.mode,'family');
 assert.deepEqual(historical.sourcePaths,['identities.json','archive/campaign-plan-8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR.json']);
 assert.equal(historical.terms.deadlineSeconds,600);assert.match(historical.terms.note,/1 SOL soft/);
 const planned=r.campaigns.get('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8');assert.equal(planned.registryStatus,'planned');assert.equal(planned.opensAt,'2026-09-23T23:30:00Z');assert.equal(planned.mint,'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY');assert.equal(planned.symbol,'FIX');assert.equal(planned.chainStatus,null,'nothing guessed from a plan');
 const active=r.campaigns.get('LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY');assert.equal(active.registryStatus,'active');assert.equal(active.genesisHash,LOCAL);assert.equal(active.network,'localnet');assert.equal(active.deadlineUnix,1790000000);assert.equal(active.launchDeadlineUnix,1790086400);assert.equal(active.supplyRaw,'1000000000000000');assert.deepEqual(active.sourcePaths,['runtime/active-launch.json']);assert.equal(active.terms.feeNft,'cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN');
 const archived=r.campaigns.get('GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq');assert.equal(archived.registryStatus,'archived');assert.equal(archived.parentMints,null);assert.deepEqual(archived.sourcePaths,['runtime/archive/GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq/active-launch.json']);
 r.close();
});
test('rerunning the import is idempotent and never blanks or rewrites an existing row',async()=>{
 const r=openRegistry();r.migrate();
 r.campaigns.upsert({genesisHash:MAINNET,programId:PROGRAM,campaign:'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8',mode:'family',campaignVersion:3,registryStatus:'archived',sourcePaths:['earlier'],name:'Kept name',softCapLamports:'1',chainStatus:'launched',sourceSlot:5});
 const first=await importLegacyCampaigns({registry:r,sources:sources()});
 const row=r.campaigns.get('CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8');
 assert.equal(row.name,'Fixture coin','presentation fields take the latest source');assert.equal(row.softCapLamports,'1','sealed terms keep their first value');assert.equal(row.registryStatus,'archived','a plan does not outrank an archive');assert.equal(row.chainStatus,'launched');
 assert.deepEqual(first.rows.find(x=>x.campaign==='CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8').conflicts,['plan:softCapLamports']);
 const before=JSON.stringify(r.campaigns.list({}).campaigns);
 const again=await importLegacyCampaigns({registry:r,sources:sources()});
 assert.equal(again.rows.filter(x=>x.inserted).length,0);assert.equal(again.rows.filter(x=>x.updated).length,0);assert.equal(again.total,4);
 assert.equal(JSON.stringify(r.campaigns.list({}).campaigns),before,'byte-for-byte the same rows');
 r.close();
});
test('a manifest without a campaign yet is skipped with a reason, not imported as an empty row',async()=>{
 const r=openRegistry();r.migrate();
 const out=await importLegacyCampaigns({registry:r,sources:{root:F,runtimeDir:join(F,'runtime-scheduled')}});
 assert.equal(out.total,0);assert.equal(out.skipped.length,1);assert.match(out.skipped[0].reason,/no campaign address yet/);
 assert.equal(campaignFromManifest({address:'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY'},'p','active',{root:F}).reason,'manifest lacks genesisHash or programId');
 assert.match(campaignFromPlan({network:'localnet',campaign:'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY',programId:PROGRAM},'p','archived').reason,/no fixed genesis hash/);
 assert.equal(campaignFromPlan({network:'localnet',campaign:'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY',programId:PROGRAM},'p','archived',{genesisHash:LOCAL}).row.genesisHash,LOCAL);
 assert.equal(campaignFromIdentities({},'p').reason,'no firstCampaign');
 const missing=collectLegacySources({root:F,runtimeDir:join(F,'nowhere'),planPath:join(F,'nowhere.json'),archiveDir:join(F,'nowhere'),identitiesPath:join(F,'nowhere.json')});
 assert.deepEqual(missing,{found:[],skipped:[]},'absent sources are simply absent');
 r.close();
});
test('the default sources point at the repository files and the import of the real files runs read-only',async()=>{
 const d=defaultSources();assert.match(d.identitiesPath,/deployment\/MAINNET-IDENTITIES\.json$/);assert.match(d.archiveDir,/deployment\/mainnet\/archive$/);
 const r=openRegistry();r.migrate();const out=await importLegacyCampaigns({registry:r});
 assert.ok(out.total>=1,'at least the identities campaign imports');for(const row of out.rows)assert.equal(row.conflicts.length,0,'the repository sources agree with each other: '+JSON.stringify(row.conflicts));
 r.close();
});
