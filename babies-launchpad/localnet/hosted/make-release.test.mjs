import test from 'node:test';
import {validateAdmissionPolicy} from '../registry/admission.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PublicKey} from '@solana/web3.js';
import {releaseFixture} from './release-manifest.test.mjs';
import {serviceConfigs,parseArgs,main,GENESIS} from './make-release.mjs';
import {validateWorkerConfig} from '../jobs/service.mjs';
import {validateMarketConfig} from '../market/public-service.mjs';
import {validateSignerConfig} from '../signer/main.mjs';
import {REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
test('generated service configs pass every hosted validator with the manifest scope and signer',()=>{
 const {manifest}=releaseFixture({schema:REGISTRY_SCHEMA_VERSION}),configs=serviceConfigs(manifest);
 assert.deepEqual(Object.keys(configs).sort(),['market-indexing.json','signer-v3.json','worker-accounting.json','worker-economics.json','worker-harvest.json','worker-lifecycle.json','worker-provisioning.json','worker-recovery.json']);
 assert.equal(validateSignerConfig(configs['signer-v3.json']).feeOperator,manifest.signerPublicKey);
 for(const lane of ['lifecycle','recovery','accounting','provisioning','harvest','economics']){
  const c=validateWorkerConfig({...configs['worker-'+lane+'.json'],rpcUrl:'https://rpc.example.test/v1',release:manifest,...(lane==='accounting'?{}:{signer:{...configs['worker-'+lane+'.json'].signer,token:'t'.repeat(40)}})});
  assert.equal(c.scope.programId,manifest.programId);assert.equal(c.mode,'hosted');
 }
 const market=validateMarketConfig({...configs['market-indexing.json'],rpcUrl:'https://rpc.example.test/v1',release:manifest});assert.equal(market.scope.campaignVersion,3);
 // The indexer builds its RPC admission guard from this block (the hosted indexer crashed without it, 28 September 2026).
 assert.equal(configs['market-indexing.json'].rpcAdmission.resource,'rpc-indexing');assert.ok(validateAdmissionPolicy(configs['market-indexing.json'].rpcAdmission.policy).lanes.indexing,'indexing lane partition present');
 assert.throws(()=>parseArgs(['--network']),/Missing value/);assert.deepEqual(parseArgs(['--network','mainnet']),{network:'mainnet'});
 assert.equal(GENESIS.mainnet,'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
});
test('the release tool proves the deployed bytes against the binary and writes the manifest and configs',async()=>{
 const fx=releaseFixture({schema:REGISTRY_SCHEMA_VERSION}),root=mkdtempSync(join(tmpdir(),'kids-release-'));
 try{
  const binary=Buffer.from('program-bytes-'.repeat(8));writeFileSync(join(root,'kids.so'),binary);
  const presets=Buffer.from('{"presets":1}');const {mkdirSync}=await import('node:fs');mkdirSync(join(root,'deployment/presets'),{recursive:true});writeFileSync(join(root,'deployment/presets/public-presets-v1.json'),presets);
  // The tool looks the sealed tier up by index (mainnet address); the fixture keeps that account under its own key.
  const info=fx.connection.getAccountInfo.bind(fx.connection),connection={...fx.connection,getGenesisHash:async()=>GENESIS.mainnet,getAccountInfo:async(k,o)=>String(k)==='ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi'?info(new PublicKey(fx.manifest.ammConfig.address),o):info(k,o)};
  const chunks=[];const out={write:s=>chunks.push(s)};
  await assert.rejects(main(['--network','devnet','--rpc','https://rpc.example.test','--program',fx.manifest.programId,'--binary',join(root,'kids.so'),'--signer',fx.manifest.signerPublicKey,'--treasury',fx.manifest.treasury],{connectionFactory:()=>connection,root,stdout:out}),/another network/);
  const args=['--network','mainnet','--rpc','https://rpc.example.test','--program',fx.manifest.programId,'--binary',join(root,'kids.so'),'--signer',fx.manifest.signerPublicKey,'--treasury',fx.manifest.treasury,'--out','deployment/hosted'];
  const result=await main(args,{connectionFactory:()=>connection,root,stdout:out});
  assert.equal(result.manifest.genesisHash,GENESIS.mainnet);assert.equal(result.manifest.binarySize,binary.length);assert.equal(result.written.length,9);
  const written=JSON.parse(readFileSync(join(root,'deployment/hosted/release-mainnet.json'),'utf8'));assert.equal(written.registrySchemaVersion,REGISTRY_SCHEMA_VERSION);assert.equal(written.ammConfig.index,7);
  assert.ok(JSON.parse(chunks.join('')).checks.binary);
 }finally{rmSync(root,{recursive:true,force:true});}
});
