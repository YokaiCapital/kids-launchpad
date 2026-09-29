import test from 'node:test';import assert from 'node:assert/strict';
import {createCreationActivation} from './activation.mjs';
function fixture(){
 // Separate identities, as on mainnet: the keeper signer and the sealed platform treasury are different keys.
 const release={genesisHash:'genesis',programId:'program',signerPublicKey:'keeper',treasury:'treasury'},owner='creator',calls=[];
 let scheduled=false,cap=null,budget='20000000';
 const campaign={creator:owner,campaignVersion:3,mode:'standard',treasury:'treasury',terms:{creationSignature:'signature'}};
 const snapshot={stage:'complete',state:'funded',creationMode:'single',campaign:'campaign',signatures:{launch:'signature'},operatingReserve:{signature:'signature'}};
 const registry={campaigns:{get:async()=>campaign},capabilities:{latest:async()=>cap},transaction:fn=>fn(),query:async()=>({rows:scheduled?[{initial_capability_id:'keeper'}]:[]})};
 const operator={status:async()=>{calls.push('status');return {chain:{creator:owner},budget:{availableLamports:budget}};},grantKeeper:async()=>{calls.push('grant');cap={kind:'keeper',expiresAt:new Date(Date.now()+10000000).toISOString()};},schedule:async()=>{calls.push('schedule');scheduled=true;return {scheduled:true};}};
 return {activate:createCreationActivation({registry,release,owner,operator}),snapshot,campaign,calls,budget:value=>budget=value,cap:value=>cap=value};
}
test('activation requires finalized bound funding and schedules once across retries',async()=>{
 const f=fixture();await f.activate(f.snapshot);f.budget('0');await f.activate(f.snapshot);assert.deepEqual(f.calls,['status','grant','schedule']);
});
test('wrong creator, transaction, treasury, legacy creation or insufficient budget cannot activate',async()=>{
 for(const change of [f=>f.campaign.creator='other',f=>f.campaign.treasury='other',f=>f.snapshot.operatingReserve.signature='other',f=>f.snapshot.creationMode='legacy',f=>f.budget('19999999')]){
  const f=fixture();change(f);await assert.rejects(f.activate(f.snapshot));assert.equal(f.calls.includes('grant'),false);assert.equal(f.calls.includes('schedule'),false);
 }
 const f=fixture();f.cap({kind:'keeper',revokedAt:'now',expiresAt:'2099-01-01'});await assert.rejects(f.activate(f.snapshot),/review/);assert.equal(f.calls.includes('schedule'),false);
});
