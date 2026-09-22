import test from 'node:test';import assert from 'node:assert/strict';import {acceptedProgramHash,nextProgramManifest} from '../program-lineage.mjs';
const h=n=>n.toString(16).padStart(64,'0');
test('a recorded hash is accepted when current or in the lineage; foreign hashes and malformed values are refused',()=>{
 const m={sha256:h(3),lineage:[h(1),h(2)]};assert.ok(acceptedProgramHash(m,h(3))&&acceptedProgramHash(m,h(1))&&acceptedProgramHash(m,h(2)));
 assert.equal(acceptedProgramHash(m,h(4)),false);assert.equal(acceptedProgramHash({sha256:h(3)},h(1)),false);assert.equal(acceptedProgramHash(m,''),false);assert.equal(acceptedProgramHash(m,42),false);assert.equal(acceptedProgramHash(null,h(3)),false);
});
test('an upgrade appends the previous hash once; a different program id or genesis is refused; a first deploy starts empty',()=>{
 const base={programId:'P',genesisHash:'G'};
 const first=nextProgramManifest(null,{...base,sha256:h(1)});assert.deepEqual(first.lineage,[]);
 const second=nextProgramManifest(first,{...base,sha256:h(2)});assert.deepEqual(second.lineage,[h(1)]);
 const same=nextProgramManifest(second,{...base,sha256:h(2)});assert.deepEqual(same.lineage,[h(1)]);
 const third=nextProgramManifest(second,{...base,sha256:h(3)});assert.deepEqual(third.lineage,[h(1),h(2)]);
 assert.throws(()=>nextProgramManifest(second,{programId:'Q',genesisHash:'G',sha256:h(3)}),/identity changed/);assert.throws(()=>nextProgramManifest(second,{programId:'P',genesisHash:'H',sha256:h(3)}),/identity changed/);
});
