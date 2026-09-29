import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {Keypair,PublicKey} from '@solana/web3.js';
import {parseReleaseManifest,verifyReleaseManifest,RELEASE_MANIFEST_VERSION} from './release-manifest.mjs';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const sha=b=>createHash('sha256').update(b).digest('hex');
export function releaseFixture({binary=Buffer.from('program-bytes-'.repeat(8)),config=Buffer.from('amm-config-bytes'),presets=Buffer.from('{"presets":1}'),schema=38}={}){
 const programData=Keypair.generate().publicKey;
 const manifest={version:RELEASE_MANIFEST_VERSION,network:'mainnet',genesisHash:addr(1),programId:addr(2),programVersion:3,binarySha256:sha(binary),binarySize:binary.length,
  ammConfig:{address:addr(7),index:7,tradeFeeRate:'25000'},ammConfigHash:sha(config),presets:{file:'deployment/presets/public-presets-v1.json',sha256:sha(presets)},treasury:addr(8),signerPublicKey:addr(9),registrySchemaVersion:schema};
 const accounts=new Map([
  [addr(2),{executable:true,data:Buffer.concat([Buffer.from([2,0,0,0]),programData.toBuffer()])}],
  [programData.toBase58(),{executable:false,data:Buffer.concat([Buffer.alloc(45,1),binary,Buffer.alloc(16,0)])}],
  [addr(7),{executable:false,data:config}]]);
 const connection={getGenesisHash:async()=>addr(1),getAccountInfo:async(key)=>{const a=accounts.get(key.toBase58());return a?{executable:a.executable,data:a.data,owner:new PublicKey(addr(5)),lamports:1}:null;}};
 return {manifest,connection,accounts,presets,programData};
}
test('release manifest parsing refuses missing identity, wrong version, non-v3 programs and traversal in the presets path',()=>{
 const {manifest}=releaseFixture();
 const m=parseReleaseManifest(manifest);assert.equal(m.network,'mainnet');assert.equal(m.ammConfig.tradeFeeRate,'25000');assert.equal(Object.isFrozen(m),true);
 for(const patch of [{version:2},{network:'localnet'},{programVersion:2},{binarySha256:'zz'},{binarySize:0},{ammConfig:{index:-1,address:manifest.ammConfig.address,tradeFeeRate:'1'}},{ammConfigHash:'0'},{presets:{file:'../secrets.json',sha256:manifest.presets.sha256}},{registrySchemaVersion:0},{treasury:'not-an-address'}])assert.throws(()=>parseReleaseManifest({...manifest,...patch}));
});
test('release verification checks genesis, executable program, exact bytes with zero tail, AMM config hash, presets bytes and registry schema',async()=>{
 const {manifest,connection,accounts,presets,programData}=releaseFixture();
 const ok=await verifyReleaseManifest(manifest,{connection,presetsBytes:presets,registrySchemaVersion:38});
 assert.deepEqual(ok.checks,{genesis:true,program:true,binary:true,ammConfig:true,presets:true,registrySchema:true});
 const expectMismatch=async(check,input)=>{await assert.rejects(verifyReleaseManifest(input.manifest??manifest,{connection:input.connection??connection,presetsBytes:input.presetsBytes??presets,registrySchemaVersion:input.schema??38}),e=>e.code==='RELEASE_MISMATCH'&&e.check===check);};
 await expectMismatch('genesis',{connection:{...connection,getGenesisHash:async()=>addr(3)}});
 await expectMismatch('program',{connection:{...connection,getAccountInfo:async k=>k.toBase58()===addr(2)?{executable:false,data:Buffer.alloc(36)}:connection.getAccountInfo(k)}});
 const tampered=new Map(accounts);tampered.set(programData.toBase58(),{executable:false,data:Buffer.concat([Buffer.alloc(45,1),Buffer.from('other-bytes'),Buffer.alloc(16,0)])});
 await expectMismatch('binary',{connection:{...connection,getAccountInfo:async k=>{const a=tampered.get(k.toBase58());return a?{executable:a.executable,data:a.data}:null;}}});
 const dirtyTail=new Map(accounts);dirtyTail.set(programData.toBase58(),{executable:false,data:Buffer.concat([accounts.get(programData.toBase58()).data.subarray(0,45+manifest.binarySize),Buffer.from([1])])});
 await expectMismatch('binary',{connection:{...connection,getAccountInfo:async k=>{const a=dirtyTail.get(k.toBase58());return a?{executable:a.executable,data:a.data}:null;}}});
 await expectMismatch('amm-config',{manifest:{...manifest,ammConfigHash:'0'.repeat(64)}});
 await expectMismatch('presets',{presetsBytes:Buffer.from('changed')});
 await expectMismatch('registry-schema',{schema:37});
});
