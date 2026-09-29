// Explicit opt-in: starts the existing native grinder and uses the isolated
// validator. No normal CI run starts compute work or signs on a hosted network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {createMintLeases} from '../mints/leases.mjs';
import {qualifyInventory} from '../mints/qualify-inventory.mjs';
import {createCreationStore} from '../creation/store.mjs';
import {createPreparationService} from '../creation/preparation.mjs';
import {createMetadataPublisher} from '../creation/publication.mjs';
import {createMintPlanService} from '../creation/mint-plan.mjs';
import {contentHash} from '../creation/pinata.mjs';
import {PINATA_GATEWAY} from '../token-metadata.mjs';
const enabled=process.env.KIDS_QUALIFY_CREATION_STOCK==='1',url=process.env.KIDS_TEST_POSTGRES_URL;
if(enabled&&!url)throw Error('Explicit isolated PostgreSQL test database required');
test('accepted v3 creation uses a real kids mint through reused encrypted inventory', {skip:!enabled,timeout:720000}, async t=>{
  const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
  try {
    await control.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});
    const registry=new PostgresRegistry({pool});
    let sharedPlan;
    const report=await qualifyInventory({programVersion:3,registry,mintPlan:{seal:id=>sharedPlan.seal(id),load:id=>sharedPlan.load(id)},prepare:async({inventory,manifest,connection,creator})=>{
      const image=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]),sha=contentHash(image);
      const draftId='qualification',draft={mode:'standard',creator,name:'Local qualification',symbol:'LOCAL',description:'Synthetic publication provider, real local mint.',pfp:{assetId:'fixture-image',sha256:sha}};
      await registry.drafts.save({creator,id:draftId,revision:0,body:draft});
      // Only the reservation bridge is under test. These are synthetic review
      // hashes, not a live cost quote or approval to charge a real user.
      const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:manifest.rpcUrl,genesisHash:manifest.genesisHash,programId:manifest.programId,pilotCreator:creator,policyHash:canonicalHash('qualification-policy'),planHash:canonicalHash('qualification-plan')};
      const store=createCreationStore(registry),quote=await store.issue({owner:creator,draftId,revision:1,draftHash:canonicalHash(draft),descriptorHash:canonicalHash(config),requestKey:draftId,body:{genesisHash:config.genesisHash,programId:config.programId,policyHash:config.policyHash,planHash:config.planHash,terms:{mode:'standard'},fundingEnabled:false,publicationConsent:true}});
      await store.accept({owner:creator,quoteId:quote.id});
      const service=createPreparationService({registry,connection,config,mintLeases:createMintLeases({registry,inventory})});
      const first=await service.prepare(creator,{draftId});
      // Provider is explicitly synthetic: no private artwork is published and no
      // Pinata credential is used. Actual on-chain metadata must match this receipt.
      const receipt=input=>{const cid='Qm'+(input.stage==='image'?'a':'b').repeat(44);return {cid,uri:PINATA_GATEWAY+cid,inputHash:input.inputHash};};
      const publisher=createMetadataPublisher({registry,config,limits:{ownerPins:2,globalPins:2,ownerBytes:10000,globalBytes:10000},loadOwnedImage:async()=>({owner:creator,assetId:'fixture-image',sanitized:true,sha256:sha,bytes:image,contentType:'image/png'}),provider:{publish:async input=>receipt(input),recover:async input=>receipt(input)}});
      const reopen=()=>createMintPlanService({registry,connection,config,publisher});
      sharedPlan={seal:id=>reopen().seal(creator,id),load:id=>reopen().load(id)};
      const restarted=createPreparationService({registry,connection,config,mintLeases:createMintLeases({registry,inventory})});
      assert.deepEqual(await restarted.prepare(creator,{draftId}),first);
      return first;
    }});
    assert.match(report.mint,/kids$/);assert.equal(report.programVersion,3);assert.ok(report.requestId);assert.equal(report.leaseState,'consumed');assert.equal(report.sharedMintPlanVerified,true);assert.equal(report.metadataPublished,false);
    t.diagnostic(JSON.stringify(report));
  } finally {if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
