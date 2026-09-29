import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Keypair,PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {createMintLeases} from '../mints/leases.mjs';
import {fakeInventory} from '../test/helpers/mint-inventory-fixture.mjs';
import {createCreationStore} from './store.mjs';
import {createPreparationService} from './preparation.mjs';
import {campaignAddress,launchAuthority} from '../protocol-v2/client.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
const address=()=>Keypair.generate().publicKey.toBase58();

test('creation preparation survives replicas and inventory boundaries without mint replacement', {skip:!url}, async t=>{
  const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),pools=[];
  try {
    await control.query(`CREATE SCHEMA ${schema}`);
    const make=()=>{const pool=new pg.Pool({connectionString:url,max:6,options:`-c search_path=${schema}`});pools.push(pool);return new PostgresRegistry({pool});};
    const a=make(),b=make();await a.migrate();
    const owner=address(),config={mode:'localnet-rehearsal',programVersion:3,genesisHash:address(),programId:address(),pilotCreator:owner,rpcUrl:'http://127.0.0.1:19199',policyHash:'a'.repeat(64),planHash:'b'.repeat(64)};
    const connection={rpcEndpoint:config.rpcUrl,getGenesisHash:async()=>config.genesisHash};
    const inventory=fakeInventory({stock:Array.from({length:20},address)});
    // Synthetic on-curve stock exercises reservation, not suffix grinding. The
    // default real mint service enforces lowercase kids and is separately qualified.
    const leases=[a,b].map(registry=>createMintLeases({registry,inventory,validateMint:m=>new PublicKey(m).toBase58()}));
    const services=[a,b].map((registry,i)=>createPreparationService({registry,connection,config,mintLeases:leases[i]}));
    const accepted=async(draftId)=>{
      const body={name:'Coin',symbol:'COIN',creator:owner,mode:'standard'};
      await a.drafts.save({creator:owner,id:draftId,revision:0,body});
      const store=createCreationStore(a),q=await store.issue({owner,draftId,revision:1,draftHash:canonicalHash(body),descriptorHash:canonicalHash({draftId}),requestKey:draftId,body:{genesisHash:config.genesisHash,programId:config.programId,policyHash:config.policyHash,planHash:config.planHash,terms:{mode:'standard'},fundingEnabled:false}});
      return store.accept({owner,quoteId:q.id});
    };
    await t.test('parallel retries allocate one nonce, campaign and mint with public fields only',async()=>{
      const request=await accepted('parallel');
      const results=await Promise.all(Array.from({length:12},(_,i)=>services[i%2].prepare(owner,{draftId:'parallel',creator:address(),nonce:'1',mint:address()})));
      assert.equal(new Set(results.map(r=>JSON.stringify(r))).size,1);
      const r=results[0];assert.equal(r.state,'reserved');assert.equal(r.fundingEnabled,false);
      assert.equal(r.campaign,campaignAddress(config.programId,owner,r.nonce).toBase58());
      assert.equal(r.authority,launchAuthority(config.programId,r.campaign).toBase58());
      const lease=await a.mintLeases.get(r.leaseId);assert.equal(lease.campaign,r.campaign);assert.equal(lease.creator,owner);assert.equal(lease.idempotencyKey,'asset:'+request.id);
      assert.equal(inventory.reservations.size,1);
      assert.deepEqual(Object.keys(r).sort(),['requestId','genesisHash','programId','programVersion','campaign','nonce','authority','state','mint','leaseId','reason','fundingEnabled'].sort());
      assert.equal(Number((await a.query('SELECT COUNT(*) n FROM wallet_packets')).rows[0].n),0);
      assert.equal(await a.campaigns.count(),0,'off-chain preparation does not advertise a launch');
    });
    await t.test('lost inventory response recovers the same binding after service restart',async()=>{
      const request=await accepted('crash'),original=inventory.reserve;let first=true;
      inventory.reserve=binding=>{const receipt=original(binding);if(first){first=false;throw Error('synthetic lost reservation response');}return receipt;};
      try {
        await assert.rejects(services[0].prepare(owner,{draftId:'crash'}),/synthetic/);
        const before=await services[1].status(owner,{draftId:'crash'});assert.equal(before.state,'allocated');
        const receipt=inventory.findReservation({creator:owner,draftId:'asset:'+request.id,idempotencyKey:'asset:'+request.id});assert.ok(receipt);
        const after=await services[1].prepare(owner,{draftId:'crash'});
        assert.equal(after.campaign,before.campaign);assert.equal(after.nonce,before.nonce);assert.equal(after.mint,receipt.mintAddress);
      } finally {inventory.reserve=original;}
    });
    await t.test('empty inventory waits without a random mint fallback or campaign change',async()=>{
      await accepted('empty');const empty=fakeInventory(),mints=createMintLeases({registry:a,inventory:empty,validateMint:m=>m});
      const service=createPreparationService({registry:a,connection,config,mintLeases:mints});
      const before=await service.prepare(owner,{draftId:'empty'});assert.equal(before.reason,'waiting-for-mint');assert.equal(before.mint,null);
      const mint=address();empty.mints.set(mint,{status:'available'});
      const after=await service.prepare(owner,{draftId:'empty'});assert.equal(after.campaign,before.campaign);assert.equal(after.mint,mint);
    });
    await t.test('released or signed leases stop; retries never substitute a fresh mint',async()=>{
      for(const state of ['released','signed-pending']) {
        const id='state-'+state;await accepted(id);const before=await services[0].prepare(owner,{draftId:id});
        if(state==='released')await leases[0].reconcile({leaseId:before.leaseId,rpc:{mintExists:async()=>false}});
        else await leases[0].recordSigningIntent({leaseId:before.leaseId,messageDigest:'c'.repeat(64)});
        assert.equal((await services[1].status(owner,{draftId:id})).state,'attention','status does not advertise a stale reservation as usable');
        const count=inventory.reservations.size,after=await services[1].prepare(owner,{draftId:id});
        assert.equal(after.state,'attention');assert.equal(after.mint,before.mint);assert.equal(inventory.reservations.size,count);
      }
    });
    await t.test('foreign wallet, unaccepted review, changed network or policy fail before reserving',async()=>{
      const n=inventory.reservations.size;
      await assert.rejects(services[0].prepare(address(),{draftId:'parallel'}),{code:'CREATION_ACCESS'});
      await assert.rejects(services[0].prepare(owner,{draftId:'absent'}),{code:'CREATION_SCOPE'});
      // Another program is out of scope; a changed ACTIVE plan or policy is not (an accepted request keeps its quoted terms).
      const wrong=createPreparationService({registry:a,connection,config:{...config,programId:address()},mintLeases:leases[0]});
      await assert.rejects(wrong.prepare(owner,{draftId:'parallel'}),{code:'CREATION_SCOPE'});
      const changedPlan=createPreparationService({registry:a,connection,config:{...config,planHash:'d'.repeat(64)},mintLeases:leases[0]});await changedPlan.status(owner,{draftId:'parallel'});
      const genesis=connection.getGenesisHash;connection.getGenesisHash=async()=>address();
      await assert.rejects(services[0].prepare(owner,{draftId:'parallel'}),{code:'CREATION_NETWORK'});connection.getGenesisHash=genesis;
      assert.equal(inventory.reservations.size,n);
      assert.throws(()=>createPreparationService({registry:a,connection,config:{...config,programVersion:2},mintLeases:leases[0]}),/isolated v3/);
      assert.throws(()=>createPreparationService({registry:a,connection,config:{...config,rpcUrl:'https://api.mainnet-beta.solana.com'},mintLeases:leases[0]}),/loopback/);
    });
    await t.test('review body mutation cannot rebind a persisted campaign',async()=>{
      const r=await accepted('mutation');await services[0].prepare(owner,{draftId:'mutation'});
      r.body.draft.name='Changed';await a.query('UPDATE creation_requests SET body=? WHERE request_id=?',[JSON.stringify(r.body),r.id]);
      await assert.rejects(services[1].prepare(owner,{draftId:'mutation'}),{code:'IDEMPOTENCY_CONFLICT'});
    });
  } finally {await Promise.all(pools.map(p=>p.end()));await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
