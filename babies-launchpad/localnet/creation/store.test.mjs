import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';
import {randomUUID} from 'node:crypto';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';import {canonicalHash} from '../registry/canonical.mjs';
import {createCreationStore} from './store.mjs';import {createPublicCreationReview} from '../../interaction-review/server/public-creation.mjs';
import {quoteCampaignCosts} from '../budgets.mjs';
import {quoteAuthorityFunding} from './setup-funding.mjs';
import {readPresets} from '../registry/presets.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
test('creation reviews survive replicas without duplicate creation or accepting changed terms',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});const pools=[];
 try{
  await control.query(`CREATE SCHEMA ${schema}`);
  const make=()=>{const pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});pools.push(pool);return new PostgresRegistry({pool});};
  const a=make(),b=make();await a.migrate();const left=createCreationStore(a),right=createCreationStore(b),owner=key(1);
  const body={name:'Coin',symbol:'COIN',mode:'standard',creator:owner,devBeneficiary:owner,parents:[null,null],presetId:'default',start:'after-creation',pfp:{url:'https://kids.fun/assets/pfp.png'}};
  const draft=async id=>a.drafts.save({creator:owner,id,revision:0,body});
  const quote=(draftId,requestKey)=>({owner,draftId,requestKey,revision:1,draftHash:canonicalHash(body),descriptorHash:canonicalHash({draftId}),body:{noMoney:true}});
  await t.test('simultaneous quote retries share exactly one stored result',async()=>{
   await draft('one');const input=quote('one','req');const quotes=await Promise.all(Array.from({length:12},(_,i)=>(i%2?left:right).issue(input)));
   assert.equal(new Set(quotes.map(q=>q.id)).size,1);const q=quotes[0];
   await assert.rejects(right.issue({...input,descriptorHash:'f'.repeat(64)}),{code:'IDEMPOTENCY_CONFLICT'});
   assert.equal(await right.get(key(2),q.id),null);await assert.rejects(right.accept({owner:key(2),quoteId:q.id}),{code:'QUOTE_UNAVAILABLE'});
   const accepted=await Promise.all(Array.from({length:10},(_,i)=>(i%2?left:right).accept({owner,quoteId:q.id})));
   assert.equal(new Set(accepted.map(r=>r.id)).size,1);assert.equal(accepted[0].state,'accepted');
   await a.query('UPDATE creation_quotes SET expires_at=0 WHERE quote_id=?',[q.id]);assert.equal((await right.accept({owner,quoteId:q.id})).id,accepted[0].id,'accepted retry resumes after quote expiry');
   await assert.rejects(b.drafts.save({creator:owner,id:'one',revision:1,body:{name:'Changed'}}),/cannot be edited/);
   assert.equal(Number((await a.query('SELECT COUNT(*) AS n FROM mint_leases')).rows[0].n),0);assert.equal(Number((await a.query('SELECT COUNT(*) AS n FROM wallet_packets')).rows[0].n),0);
  });
  await t.test('quote expiry and draft edits cannot silently change what was approved',async()=>{
   await draft('two');const q=await left.issue(quote('two','req2'));await b.drafts.save({creator:owner,id:'two',revision:1,body:{...body,name:'Other'}});
   await assert.rejects(right.accept({owner,quoteId:q.id}),{code:'REVISION_CONFLICT'});
   await draft('three');const expired=await left.issue(quote('three','req3'));await a.query('UPDATE creation_quotes SET expires_at=0 WHERE quote_id=?',[expired.id]);
   await assert.rejects(right.accept({owner,quoteId:expired.id}),{code:'QUOTE_EXPIRED'});assert.equal((await a.drafts.get(owner,'three')).status,'draft');
  });
  await t.test('two independently quoted tabs cannot both start the same draft',async()=>{
   await draft('four');const qs=await Promise.all([left.issue(quote('four','req4')),right.issue(quote('four','req5'))]);
   const outcomes=await Promise.allSettled([left.accept({owner,quoteId:qs[0].id}),right.accept({owner,quoteId:qs[1].id})]);
   assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'CREATION_STARTED');
  });
  await t.test('save racing acceptance never changes an accepted financial snapshot',async()=>{
   for(let i=0;i<5;i++){
    const id='race'+i;await draft(id);const q=await left.issue(quote(id,id));
    const results=await Promise.allSettled([left.accept({owner,quoteId:q.id}),b.drafts.save({creator:owner,id,revision:1,body:{...body,name:'Edited'}})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const saved=await a.drafts.get(owner,id),request=await right.status(owner,id);
    if(request){assert.equal(saved.status,'creating');assert.equal(saved.revision,1);assert.equal(request.body.draft.name,'Coin');}
    else{assert.equal(saved.status,'draft');assert.equal(saved.revision,2);}
   }
  });
  await t.test('server quote binds immutable manifest/plan and excludes client funding fields',async()=>{
   await draft('service');const manifest=readPresets(),config={mode:'localnet-rehearsal',genesisHash:key(3),programId:key(4),rpcUrl:'http://127.0.0.1:19199'},setupPlan={version:'fixture-plan',counts:{transactions:8,signatures:11,ataCreates:9,lockedPositions:1,feeStates:1},priorityFeeLamports:'10000'};
   const connection={rpcEndpoint:config.rpcUrl,getGenesisHash:async()=>config.genesisHash};let reads=0;
   const readCosts=async input=>{reads++;assert.equal(input.owner,owner);return {coverage:'bounded-setup-only',costs:{totalLamports:'123'},evidence:{genesisHash:config.genesisHash,ammConfig:manifest.agreed.feePolicy.ammConfig,tradeFeeRate:'25000',chainTimeUnix:'1790000000'}};};
   const args={registry:a,connection,config,manifest,setupPlan,readCosts},service=createPublicCreationReview(args);
   const input={draftId:'service',revision:1,requestId:'service-quote',totalLamports:'0',owner:key(2)};
   const q=await service.quote(owner,input);assert.equal(q.body.fundingEnabled,false);assert.equal(q.body.costs.totalLamports,'123');assert.equal(q.body.terms.softCapLamports,'50000000000');
   assert.equal((await service.quote(owner,input)).id,q.id);assert.equal(reads,1);
   const changed=createPublicCreationReview({...args,config:{...config,programId:key(5)}});await assert.rejects(changed.accept(owner,{quoteId:q.id}),/configuration/);
   const request=await service.accept(owner,{quoteId:q.id});assert.equal((await service.status(owner,{draftId:'service'})).id,request.id);assert.equal(await changed.status(owner,{draftId:'service'}),null);
   assert.throws(()=>createPublicCreationReview({...args,config:{...config,mode:'production'}}),/localnet/);
  });
  await t.test('v3 review requires owned ready artwork and explicit immutable publication consent',async()=>{
   const manifest=readPresets(),config={mode:'localnet-rehearsal',programVersion:3,genesisHash:key(3),programId:key(4),treasury:key(10),rpcUrl:'http://127.0.0.1:19199'},setupPlan={version:'fixture-plan',counts:{transactions:8}};
   const connection={rpcEndpoint:config.rpcUrl,getGenesisHash:async()=>config.genesisHash};let reads=0;
   const quotedCosts=JSON.parse(JSON.stringify(quoteCampaignCosts({live:{ammCreationFeeLamports:150000000n},counts:{transactions:8,signatures:11,ataCreates:9,lockedPositions:1,feeStates:1}}),(_,v)=>typeof v==='bigint'?String(v):v));
   const readCosts=async()=>{reads++;return {coverage:'bounded-setup-only',costs:quotedCosts,evidence:{genesisHash:config.genesisHash,ammConfig:manifest.agreed.feePolicy.ammConfig,tradeFeeRate:'25000',chainTimeUnix:'1790000000'}};};
   let asset={assetId:'owned-pfp',status:'ready',kind:'pfp',sha256:'a'.repeat(64)};
   const artwork={status:async(w,id)=>w===owner&&id===asset.assetId?asset:null};
   const service=createPublicCreationReview({registry:a,connection,config,manifest,setupPlan,readCosts,artwork});
   await draft('private-art');const input={draftId:'private-art',revision:1,requestId:'private-art-quote'};
   await assert.rejects(service.quote(owner,input),/private artwork/);assert.equal(reads,0);
   const owned={...body,pfp:{assetId:'owned-pfp',sha256:'a'.repeat(64)}};
   await a.drafts.save({creator:owner,id:input.draftId,revision:1,body:owned});input.revision=2;
   await assert.rejects(service.quote(owner,input),/Approve permanent/);assert.equal(reads,0);
   await a.drafts.save({creator:owner,id:input.draftId,revision:2,body:{...owned,publicationConsent:true}});input.revision=3;
   asset={...asset,kind:'banner'};await assert.rejects(service.quote(owner,input),/Upload/);asset={...asset,kind:'pfp'};
   const quote=await service.quote(owner,input);assert.equal(quote.body.publicationConsent,true);assert.equal(quote.body.treasury,config.treasury);assert.deepEqual(quote.body.authorityFunding,quoteAuthorityFunding(quotedCosts));
   const changedTreasury=createPublicCreationReview({registry:a,connection,config:{...config,treasury:key(11)},manifest,setupPlan,readCosts,artwork});
   await assert.rejects(changedTreasury.accept(owner,{quoteId:quote.id}),/configuration/);
   await assert.rejects(changedTreasury.quote(owner,input),{code:'IDEMPOTENCY_CONFLICT'});
   const accepted=await service.accept(owner,{quoteId:quote.id});assert.equal(accepted.body.draft.pfp.assetId,asset.assetId);assert.equal(accepted.body.quote.publicationConsent,true);
  });
 }finally{await Promise.all(pools.map(p=>p.end()));await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
