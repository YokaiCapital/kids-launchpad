// The hosted creator flow composes only from a verified non-localnet release, a provider RPC and the pilot wallet, with
// the manifest's signer as the operating payer; media and mints live on the service volume. Real PostgreSQL registry.
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import pg from '../../localnet/node_modules/pg/lib/index.js';
import {Keypair} from '@solana/web3.js';
import {PostgresRegistry} from '../../localnet/registry/registry.mjs';
import {readPresets} from '../../localnet/registry/presets.mjs';
import {releaseFixture} from '../../localnet/hosted/release-manifest.test.mjs';
import {composeHostedCreatorHttp,hostedCreatorScope,openHostedMintInventory,manifestCostQuote,ONE_TRANSACTION_BUILDS} from '../server/hosted-creator-services.mjs';
import {createFileObjectStore} from '../server/media-store.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
test('media store keeps sanitized objects private on the volume and round-trips their bytes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-media-'));
 try{
  const store=createFileObjectStore({dir});assert.match(store.storageId,/^[a-f0-9]{64}$/);assert.equal(await store.verifyPrivacy(),true);
  const bytes=randomBytes(64),saved=await store.put('art:owner:1',{bytes,contentType:'image/png',width:2,height:2});
  assert.equal(saved.byteCount,64);assert.match(saved.sha256,/^[a-f0-9]{64}$/);
  const back=await store.read('art:owner:1');assert.deepEqual(Buffer.from(back.bytes),bytes);assert.equal(back.contentType,'image/png');assert.equal(back.sha256,saved.sha256);
  assert.equal(await store.read('missing'),null);
  await assert.rejects(store.put('bad key with spaces',{bytes}));await assert.rejects(store.put('x',{bytes,sha256:'0'.repeat(64)}),/differs/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('hosted mint inventory opens on the volume without refilling when asked, and refuses a weak key',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-mints-'));
 try{
  await assert.rejects(openHostedMintInventory({dir,encryptionKeyHex:'short',refill:false}),/64 lowercase/);
  const published=[],logged=[];
  const mints=await openHostedMintInventory({dir,encryptionKeyHex:randomBytes(32).toString('hex'),refill:false,publish:c=>published.push(c),log:e=>logged.push(e)});
  // The reserve count is published for the status page and logged once at open (again only when it changes).
  assert.deepEqual(published,[{available:0,reserved:0,signed:0,quarantined:0,target:3}]);assert.deepEqual(logged.filter(e=>e.event==='hosted-mint-reserve-count'),[{event:'hosted-mint-reserve-count',available:0,reserved:0,signed:0,quarantined:0,target:3}]);
  assert.equal(typeof mints.inventory.assetMintSigner,'function');assert.equal(mints.counts().available,0);await mints.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('hosted creator flow composes from the verified release with the signer as payer and refuses loopback, localnet or a missing pilot wallet',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),dir=mkdtempSync(join(tmpdir(),'kids-hosted-'));let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:6,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const pilot=Keypair.generate().publicKey.toBase58(),release=releaseFixture({schema:39}).manifest,manifest=readPresets();
  const rpc='https://rpc.example.test/v1',connection={rpcEndpoint:rpc,getGenesisHash:async()=>release.genesisHash};
  const env={KIDS_PUBLIC_PILOT_WALLET:pilot,KIDS_RPC_URL:rpc,KIDS_MEDIA_DIR:join(dir,'media')};
  const mints=await openHostedMintInventory({dir:join(dir,'mints'),encryptionKeyHex:randomBytes(32).toString('hex'),refill:false});
  const stubs={inventory:mints.inventory,provider:{publish:async()=>{throw Error('never');},recover:async()=>{throw Error('never');}},sanitize:async()=>{throw Error('never');},log:()=>{}};
  const scope=hostedCreatorScope({env,release,manifest,setupPlan:{version:'x',counts:{}}});
  assert.equal(scope.mode,'hosted');assert.equal(scope.operatingPayer,release.signerPublicKey);assert.equal(scope.treasury,release.treasury);assert.equal(scope.operatingReserveLamports,'100000000');assert.equal(scope.pilotCreator,pilot);
  // The one-transaction path (tag 40) is offered only when the verified release names a program build that has it.
  assert.equal(ONE_TRANSACTION_BUILDS.includes(release.binarySha256),false);assert.equal(scope.oneTransaction,false);
  const one=hostedCreatorScope({env,release:{...release,binarySha256:ONE_TRANSACTION_BUILDS[0]},manifest,setupPlan:{version:'x',counts:{},priorityFeeLamports:'12000'}});assert.equal(one.oneTransaction,true);assert.equal(one.priorityFeeLamports,'12000');
  assert.throws(()=>hostedCreatorScope({env:{...env,KIDS_PUBLIC_PILOT_WALLET:''},release,manifest,setupPlan:{}}),/KIDS_PUBLIC_PILOT_WALLET/);
  await assert.rejects(composeHostedCreatorHttp({registry,env,release:{...release,network:'localnet'},manifest,connection,...stubs}),/localnet/);
  await assert.rejects(composeHostedCreatorHttp({registry,env:{...env,KIDS_RPC_URL:'http://127.0.0.1:8899'},release,manifest,connection:{...connection,rpcEndpoint:'http://127.0.0.1:8899'},...stubs}));
  let reads=0;const readCosts=async({ammConfig,counts,owner})=>{reads+=1;assert.equal(owner,pilot);assert.ok(ammConfig);assert.ok(counts);return {costs:{totalLamports:'250000000',lines:[]},evidence:{slot:77}};};
  const hosted=await composeHostedCreatorHttp({registry,env,release,manifest,connection,readCosts,...stubs});
  try{
   // The served manifest carries the cost quote the review step adds up (its absence blocked the pilot's first creation).
   const q=hosted.manifest().costQuote;assert.equal(reads,1);assert.equal(q.validForSeconds,600);assert.equal(q.slot,77);
   assert.deepEqual(q.items.map(i=>[i.key,i.kind,i.lamports]),[['operating-reserve','refundable','100000000'],['setup','consumed','250000000']]);
   assert.equal(hosted.config.mode,'hosted');assert.equal(hosted.config.operatingPayer,release.signerPublicKey);assert.equal(typeof hosted.account.handle,'function');assert.equal(typeof hosted.directory,'object');
   const served=hosted.manifest();assert.equal(served.capabilities.create,true);assert.equal(served.capabilities.commit,true);assert.equal(served.capabilities.trade,true);assert.equal(served.capabilities.videoPublication,false);assert.equal(served.treasury,release.treasury);
   assert.equal(served.operating.reserveLamports,'100000000');
   assert.equal(hosted.services.operatingReserve!=null,true,'the reserve stage is composed');
  }finally{await hosted.close();await mints.close();}
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();rmSync(dir,{recursive:true,force:true});}
});
test('manifest cost quote: reserve and setup items, no reserve when the manifest has none, refuses missing costs',()=>{
 const costs={costs:{totalLamports:'123'},evidence:{slot:1}};
 const withReserve=manifestCostQuote({costs,manifest:{agreed:{operating:{reserveLamports:'100000000'}}},now:()=>0});
 assert.deepEqual(withReserve.items.map(i=>i.key),['operating-reserve','setup']);assert.equal(withReserve.quotedAt,'1970-01-01T00:00:00.000Z');
 assert.deepEqual(manifestCostQuote({costs,manifest:{}}).items.map(i=>i.key),['setup']);
 assert.throws(()=>manifestCostQuote({costs:{costs:{totalLamports:'x'}},manifest:{}}),/itemized/);
 assert.throws(()=>manifestCostQuote({costs:null,manifest:{}}),/itemized/);
});
import {createCustodyClient} from '../../localnet/mints/custody-client.mjs';
import {FUNDING_FIRST_BUILDS} from '../../localnet/hosted/funding-first-builds.mjs';
import {VersionedTransaction,TransactionMessage,ComputeBudgetProgram} from '@solana/web3.js';
test('the custody endpoint composes on the inventory host from KIDS_CUSTODY_TOKEN and KIDS_CUSTODY_PORT; funding-first rounds need the build that carries them and the endpoint',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),dir=mkdtempSync(join(tmpdir(),'kids-hosted-custody-'));let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:6,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const pilot=Keypair.generate().publicKey.toBase58(),release=releaseFixture({schema:39}).manifest,manifest=readPresets(),setupPlan={version:'x',counts:{},priorityFeeLamports:'12000'};
  const rpc='https://rpc.example.test/v1',connection={rpcEndpoint:rpc,getGenesisHash:async()=>release.genesisHash};
  const env={KIDS_PUBLIC_PILOT_WALLET:pilot,KIDS_RPC_URL:rpc,KIDS_MEDIA_DIR:join(dir,'media')};
  const mints=await openHostedMintInventory({dir:join(dir,'mints'),encryptionKeyHex:randomBytes(32).toString('hex'),refill:false});
  const stubs={inventory:mints.inventory,provider:{publish:async()=>{throw Error('never');},recover:async()=>{throw Error('never');}},sanitize:async()=>{throw Error('never');},log:()=>{}};
  const readCosts=async()=>({costs:{totalLamports:'250000000',lines:[]},evidence:{slot:77}});
  // Funding-first rounds are admitted only on the program build that carries them (also a one-transaction build).
  assert.throws(()=>hostedCreatorScope({env:{...env,KIDS_FUNDING_FIRST:'1'},release,manifest,setupPlan}),/funding-first accounting/);
  const ff=hostedCreatorScope({env:{...env,KIDS_FUNDING_FIRST:'1'},release:{...release,binarySha256:FUNDING_FIRST_BUILDS[0]},manifest,setupPlan});assert.equal(ff.fundingFirst,true);assert.equal(ff.oneTransaction,true);
  assert.equal(hostedCreatorScope({env,release:{...release,binarySha256:FUNDING_FIRST_BUILDS[0]},manifest,setupPlan}).fundingFirst,false,'off unless asked for');
  // The endpoint needs its token and port; admitting funding-first rounds needs the endpoint.
  await assert.rejects(composeHostedCreatorHttp({registry,env:{...env,KIDS_CUSTODY_TOKEN:'t'.repeat(40)},release,manifest,connection,readCosts,...stubs}),/KIDS_CUSTODY_PORT/);
  await assert.rejects(composeHostedCreatorHttp({registry,env:{...env,KIDS_FUNDING_FIRST:'1'},release:{...release,binarySha256:FUNDING_FIRST_BUILDS[0]},manifest,connection,readCosts,...stubs}),/KIDS_CUSTODY_TOKEN/);
  const plain=await composeHostedCreatorHttp({registry,env,release,manifest,connection,readCosts,...stubs});assert.equal(plain.custody,null);await plain.close();
  const token='custody-'+'k'.repeat(40);
  const hosted=await composeHostedCreatorHttp({registry,env:{...env,KIDS_CUSTODY_TOKEN:token,KIDS_CUSTODY_PORT:'0',KIDS_CUSTODY_HOST:'127.0.0.1'},release,manifest,connection,readCosts,...stubs});
  try{
   assert.ok(hosted.custody?.address?.port>0,'the endpoint listens');
   const url2='http://127.0.0.1:'+hosted.custody.address.port,client=createCustodyClient({url:url2,token});
   const keeper=Keypair.generate(),tx=new VersionedTransaction(new TransactionMessage({payerKey:keeper.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1})]}).compileToV0Message());
   const ref={mint:Keypair.generate().publicKey.toBase58(),feeNft:Keypair.generate().publicKey.toBase58(),campaign:Keypair.generate().publicKey.toBase58(),keeper:keeper.publicKey.toBase58(),operationId:'f'.repeat(64),attempt:1,lookups:null,operationKey:'launch',fencingToken:1};
   // The endpoint runs the real adapter over this service's inventory: a mint it never reserved is refused, nothing is signed.
   await assert.rejects(client.coSign(tx,ref),e=>e.status===409&&e.code==='CUSTODY_REFUSED'&&/custody-binding/.test(e.message));
   await assert.rejects(createCustodyClient({url:url2,token:'wrong-'+'w'.repeat(40)}).coSign(tx,ref),e=>e.status===401);
   assert.equal((await fetch(url2+'/healthz')).status,200);
  }finally{await hosted.close();await mints.close();}
  await assert.rejects(fetch('http://127.0.0.1:'+hosted.custody.address.port+'/healthz'),'closed with the composition');
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();rmSync(dir,{recursive:true,force:true});}
});
