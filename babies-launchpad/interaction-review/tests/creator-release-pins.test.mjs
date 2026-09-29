import test from 'node:test';import assert from 'node:assert/strict';
import {checkReleasePins,createCreatorController} from '../src/public/creator-controller.mjs';
const release={programId:'ABq14qMonDrPbRJUbyfACsazK2ESaiKWcw5u66qy6f7T',genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',treasury:'91eLwFTAxkcQLPSMxbzdSFkTyEwyRYcoZk64HMZj8vX'};
const quote={...release,fundingEnabled:false};
test('build-time release pins refuse a served quote that names another program, ledger or treasury',()=>{
 checkReleasePins(quote,release);checkReleasePins({...quote,programId:'other'},null);
 for(const field of ['programId','genesisHash','treasury'])assert.throws(()=>checkReleasePins({...quote,[field]:'11111111111111111111111111111111'},release),new RegExp('released program: '+field));
 assert.throws(()=>checkReleasePins({...quote,treasury:undefined},release),/treasury/);
 const request={owner:'W',state:'accepted',id:'r1',draftId:'d1',body:{quote:{...quote,programId:'11111111111111111111111111111111'},draft:{}}};
 assert.throws(()=>createCreatorController({owner:'W',request,api:async()=>{throw Error('no call expected');},wallet:()=>{},network:'mainnet',release}),/released program: programId/);
 assert.doesNotThrow(()=>createCreatorController({owner:'W',request:{...request,body:{quote,draft:{}}},api:async()=>{throw Error('no call expected');},wallet:()=>{},network:'mainnet',release}).dispose());
});
