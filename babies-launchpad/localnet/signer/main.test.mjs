// The hosted signer composes only from a complete environment, a verified release and the matching key; it never
// listens or signs during composition. Real PostgreSQL for ownership, journal coverage and admission tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createPrivateKey,sign} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {Keypair} from '@solana/web3.js';
import {PostgresRegistry,REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
import {releaseFixture} from '../hosted/release-manifest.test.mjs';
import {verifySignature} from '../../shared/solana.mjs';
import {validateSignerConfig,readSignerKey,registryUrl,composeHostedSigner} from './main.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
test('signer config and key files are validated exactly; the registry must be private or TLS',()=>{
 const good={listen:{host:'::',port:4177},rpcAdmission:{resource:'signer-rpc',ratePerSecond:20,burst:40}};
 assert.deepEqual(validateSignerConfig(good),{...good,policy:'creator-funded-v1',feeOperator:null});
 for(const bad of [{},{rpcAdmission:{resource:'x'}},{...good,listen:{host:'',port:1}},{...good,policy:'bad policy'},{...good,feeOperator:'nope'},{...good,extra:1}])assert.throws(()=>validateSignerConfig(bad));
 const dir=mkdtempSync(join(tmpdir(),'kids-signer-key-')),file=join(dir,'key.json'),keypair=Keypair.generate();
 try{
  writeFileSync(file,JSON.stringify(Array.from(keypair.secretKey)),{mode:0o600});const loaded=readSignerKey(file);assert.equal(loaded.publicKey.toBase58(),keypair.publicKey.toBase58());
  // Regression (28 Sep 2026): Keypair keeps the buffer it is given; wiping it after construction zeroed the hosted signer's secret while
  // the public key stayed intact, so every signature was made with a zero seed and refused at the persistence boundary.
  assert.deepEqual(Array.from(loaded.secretKey),Array.from(keypair.secretKey),'the loaded keypair owns its secret after the file bytes are wiped');
  const derived=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(loaded.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'}),probe=Buffer.from('kids signer key regression');
  assert.equal(verifySignature(keypair.publicKey.toBase58(),probe,sign(null,probe,derived)),true,'a signature from the loaded key verifies against the manifest key');
  writeFileSync(file,JSON.stringify([1,2,3]));assert.throws(()=>readSignerKey(file),/64-byte/);
 }finally{rmSync(dir,{recursive:true,force:true});}
 assert.equal(registryUrl('postgres://kids-pg.railway.internal:5432/kids'),'postgres://kids-pg.railway.internal:5432/kids');
 assert.equal(registryUrl('postgresql://host.example.net:5432/kids?sslmode=require'),'postgresql://host.example.net:5432/kids?sslmode=require');
 for(const bad of ['postgres://127.0.0.1:5432/kids','postgres://host.example.net:5432/kids','https://kids-pg.railway.internal','not a url'])assert.throws(()=>registryUrl(bad));
});
test('hosted signer composes from a verified release with the matching key, refuses a foreign key, schema or localnet manifest, and never listens by itself',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),dir=mkdtempSync(join(tmpdir(),'kids-signer-v3-'));let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:6,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const keypair=Keypair.generate(),fx=releaseFixture({schema:REGISTRY_SCHEMA_VERSION}),manifest={...fx.manifest,signerPublicKey:keypair.publicKey.toBase58()};
  const write=(name,value)=>{const p=join(dir,name);writeFileSync(p,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});return p;};
  const env={KIDS_REGISTRY_URL:'postgres://kids-pg.railway.internal:5432/kids',KIDS_RPC_URL:'https://rpc.example.test/v1',KIDS_RELEASE_MANIFEST:write('release.json',manifest),KIDS_SIGNER_TOKEN:'t'.repeat(40),
   KIDS_SIGNER_CONFIG:write('signer.json',{listen:{host:'127.0.0.1',port:4177},rpcAdmission:{resource:'signer-rpc',ratePerSecond:20,burst:40}}),KIDS_SIGNER_KEY_FILE:write('key.json',Array.from(keypair.secretKey)),KIDS_SIGNER_STATE_FILE:join(dir,'signer-state.json')};
  const compose=(patch={},extra={})=>composeHostedSigner({env:{...env,...patch},registryFactory:()=>registry,connectionFactory:()=>fx.connection,presetsBytes:fx.presets,log:()=>{},...extra});
  for(const name of Object.keys(env))await assert.rejects(compose({[name]:''}),new RegExp(name),name+' required');
  await assert.rejects(compose({KIDS_REGISTRY_URL:'postgres://127.0.0.1:5432/kids'}),/loopback/);
  await assert.rejects(compose({KIDS_RPC_URL:'http://127.0.0.1:8899'}),/loopback/);
  await assert.rejects(compose({KIDS_SIGNER_TOKEN:'short'}),/32 characters/);
  await assert.rejects(compose({KIDS_RELEASE_MANIFEST:write('foreign.json',fx.manifest)}),/does not match the release manifest/);
  await assert.rejects(compose({KIDS_RELEASE_MANIFEST:write('old.json',{...manifest,registrySchemaVersion:REGISTRY_SCHEMA_VERSION-1})}),e=>e.code==='RELEASE_MISMATCH');
  const composed=await compose();
  assert.equal(composed.payer,keypair.publicKey.toBase58());assert.equal(composed.manifest.network,'mainnet');assert.equal(composed.config.policy,'creator-funded-v1');assert.equal(composed.service.server.listening,false);
  await composed.service.close();
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();rmSync(dir,{recursive:true,force:true});}
});
