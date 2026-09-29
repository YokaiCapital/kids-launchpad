import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {PublicKey} from '@solana/web3.js';
import {decodePublicActivity} from './public-activity-decode.mjs';import {validatePublicEvent,hasMovement} from '../../shared/public-activity.mjs';import {encodeBase58} from '../../shared/solana.mjs';
const fixture=n=>JSON.parse(readFileSync(new URL('../test/fixtures/market/activity/'+n+'.json',import.meta.url),'utf8'));
const id={...fixture('identity'),distribution:null,distributionProgram:null,programVersion:3,mode:'standard'},key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58(),data=n=>encodeBase58(Uint8Array.of(n));
function refundTx(){const owner=key(5),second=key(6),receipt=key(7),ix=o=>({programId:id.launchProgram,accounts:[id.campaign,receipt,o],data:data(3)});return {version:0,slot:30,blockTime:100,transaction:{signatures:['2'.repeat(88)],message:{accountKeys:[{pubkey:owner,signer:true},{pubkey:second,signer:false},{pubkey:id.campaign,signer:false}],instructions:[ix(owner),ix(second)]}},meta:{err:null,fee:5,preBalances:[100,200,1000],postBalances:[125,220,950],innerInstructions:[]}};}
test('v3 uses exact movement semantics without inheriting the retired legacy sell tag',()=>{
 for(const name of ['commit','fees-collect','fees-distribute','burn-child','launch']){const out=decodePublicActivity(fixture(name),id);assert.equal(out.unsupported,false);assert.deepEqual(out.skipped,[]);assert.ok(out.events.length);out.events.forEach(validatePublicEvent);}
 const tx=fixture('fees-sell'),out=decodePublicActivity(tx,id);assert.equal(out.events[0].kind,'fees-operator');assert.deepEqual(out.events[0].assets,[]);
 assert.throws(()=>decodePublicActivity(tx,{...id,programVersion:2}),/scope/);assert.throws(()=>decodePublicActivity(tx,{...id,mode:'family'}),/scope/);
});
test('multi-wallet native refunds reconcile recipients and fee payer exactly',()=>{
 const tx=refundTx(),out=decodePublicActivity(tx,id);assert.deepEqual(out.skipped,[]);assert.deepEqual(out.events.map(e=>e.assets[0].amountRaw),['30','20']);out.events.forEach(validatePublicEvent);
 tx.meta.postBalances[2]=949;const mismatch=decodePublicActivity(tx,id);assert.ok(mismatch.events.every(e=>e.amountsUnresolved&&e.assets.length===0&&hasMovement(e)));
});
test('duplicate recipients, unsafe numbers and mixed transactions never invent refund amounts',()=>{
 for(const change of [t=>t.transaction.message.instructions[1].accounts[2]=t.transaction.message.instructions[0].accounts[2],t=>t.meta.preBalances[0]=Number.MAX_SAFE_INTEGER+1,t=>t.transaction.message.instructions.push({programId:key(9),accounts:[],data:data(1)})]){
  const tx=refundTx();change(tx);const events=decodePublicActivity(tx,id).events;assert.ok(events.every(e=>e.amountsUnresolved&&e.assets.length===0));
 }
 const failed=refundTx();failed.meta.err={InstructionError:[0,'Custom']};assert.ok(decodePublicActivity(failed,id).events.every(e=>e.failed&&!e.assets.length));
});
test('invalid failed instructions cannot stop indexing; successful unknown instructions remain unsupported',()=>{
 const tx=refundTx();tx.transaction.message.instructions[0].data=data(99);tx.meta.err={InstructionError:[0,'Custom']};const out=decodePublicActivity(tx,id);assert.deepEqual(out.skipped,[]);assert.equal(out.events[0].kind,'program-attempt');out.events.forEach(validatePublicEvent);
 tx.meta.err=null;assert.ok(decodePublicActivity(tx,id).skipped.length);
});
test('setup return is actual native transfer to the creator, not its instruction data',()=>{
 const tx=refundTx(),source=key(9),owner=tx.transaction.message.accountKeys[0].pubkey;tx.transaction.message.instructions=[{programId:id.launchProgram,accounts:[id.campaign,source,owner,key(0)],data:data(27)}];tx.meta.innerInstructions=[{index:0,instructions:[{programId:'11111111111111111111111111111111',parsed:{type:'transfer',info:{source,destination:owner,lamports:17}}}]}];const e=decodePublicActivity(tx,id).events[0];assert.equal(e.kind,'setup-return');assert.equal(e.assets[0].amountRaw,'17');assert.equal(e.assets[0].role,'creator');validatePublicEvent(e);
});

test('the compact creation (tag 40) is a campaign creation bound to the campaign account, exactly like tag 0',()=>{
 const creator=key(5),amm=key(6),ix=(tag,campaign=id.campaign)=>({programId:id.launchProgram,accounts:[creator,campaign,'11111111111111111111111111111111',amm],data:data(tag)});
 const tx=instruction=>{const base=refundTx();base.transaction.message.instructions=[instruction];base.meta.innerInstructions=[];return base;};
 const shapes=[0,40].map(tag=>{const out=decodePublicActivity(tx(ix(tag)),id);assert.deepEqual(out.skipped,[],'tag '+tag);assert.equal(out.events.length,1,'tag '+tag);assert.equal(out.events[0].kind,'campaign-init');out.events.forEach(validatePublicEvent);return {...out.events[0],tag:undefined,signature:undefined};});
 assert.deepEqual(shapes[0],shapes[1],'the compact creation decodes to the same event as the full creation');
 const foreign=decodePublicActivity(tx(ix(40,key(8))),id);assert.deepEqual(foreign.events,[]);assert.deepEqual(foreign.skipped,[],'another campaign\'s creation is neither an event nor a skip');
});
