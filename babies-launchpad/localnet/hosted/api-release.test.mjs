import test from 'node:test';import assert from 'node:assert/strict';
import {writeFileSync,mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {verifyApiRelease} from './api-release.mjs';
import {releaseFixture} from './release-manifest.test.mjs';
test('API release verification is dark without a manifest, waits for the registry, proves the release and fails closed',async()=>{
 assert.deepEqual(await verifyApiRelease({env:{}}),{configured:false});
 const dir=mkdtempSync(join(tmpdir(),'kids-release-')),file=join(dir,'release.json');
 try{
  const fx=releaseFixture({schema:38});writeFileSync(file,JSON.stringify(fx.manifest));
  const env={KIDS_RELEASE_MANIFEST:file,KIDS_RPC_URL:'https://rpc.example.test/v1'};
  const registry={schemaVersion:async()=>38};
  await assert.rejects(verifyApiRelease({env:{KIDS_RELEASE_MANIFEST:file}}),/KIDS_RPC_URL/);
  await assert.rejects(verifyApiRelease({env:{...env,KIDS_RPC_URL:'http://127.0.0.1:8899'}}),/loopback/);
  // The registry opens a little later; verification waits for it, bounded.
  const late={registry:null};setTimeout(()=>{late.registry=registry;},300);
  const ok=await verifyApiRelease({env,registryImport:late,connectionFactory:url=>{assert.equal(url,env.KIDS_RPC_URL);return fx.connection;},presetsBytes:fx.presets});
  assert.equal(ok.configured,true);assert.equal(ok.network,'mainnet');assert.deepEqual(ok.checks,{genesis:true,program:true,binary:true,ammConfig:true,presets:true,registrySchema:true});
  await assert.rejects(verifyApiRelease({env,registryImport:{registry:null},connectionFactory:()=>fx.connection,presetsBytes:fx.presets,waitMs:300}),/registry to be open/);
  await assert.rejects(verifyApiRelease({env,registryImport:{registry:{schemaVersion:async()=>37}},connectionFactory:()=>fx.connection,presetsBytes:fx.presets}),e=>e.code==='RELEASE_MISMATCH'&&e.check==='registry-schema');
  await assert.rejects(verifyApiRelease({env,registryImport:{registry},connectionFactory:()=>({...fx.connection,getGenesisHash:async()=>'11111111111111111111111111111111'}),presetsBytes:fx.presets}),e=>e.code==='RELEASE_MISMATCH'&&e.check==='genesis');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
