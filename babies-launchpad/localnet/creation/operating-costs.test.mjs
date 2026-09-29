import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,TransactionMessage,VersionedTransaction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {feesInitInstruction} from '../protocol-v2/client.mjs';
import {operatingCostModel,reconcileOperatingCost,operatingReturnInstructions,operatingReturnMemo} from './operating-costs.mjs';
const key=()=>Keypair.generate().publicKey;
function fixture(){
 const x={payer:String(key()),programId:String(key()),campaign:String(key()),maximumLamports:'2100000'},operator=key();
 const row={costModel:'v3-fee-state-rent',costIntent:{programVersion:3,operator:String(operator),maximumRentLamports:'2004480'},block:{blockhash:String(key())}};
 const ix=feesInitInstruction(x.programId,x.campaign,x.payer,operator),tx=new VersionedTransaction(new TransactionMessage({payerKey:ix.keys[1].pubkey,recentBlockhash:row.block.blockhash,instructions:[ix]}).compileToV0Message()),packet={tx,bytes:tx.message.serialize()};
 const model=operatingCostModel(row,packet,x),pre=tx.message.staticAccountKeys.map(()=>0),post=pre.slice();pre[0]=3000000;post[0]=990520;post[model.index]=2004480;
 return {x,row,packet,model,pre,post,fee:5000n};
}
test('fee-state cost separates actual rent from network fees, including prefunded accounts',()=>{
 const f=fixture();assert.equal(reconcileOperatingCost(f.model,f),2009480n);
 f.pre[f.model.index]=1000000;f.post[0]+=1000000;assert.equal(reconcileOperatingCost(f.model,f),1009480n);
 f.post=f.pre.slice();f.post[0]-=5000;assert.equal(reconcileOperatingCost(f.model,{...f,failed:true}),5000n);
});
test('unexplained income, excess rent, failure with rent movement, and different account deltas refuse settlement',()=>{
 for(const mutate of [f=>{f.post[0]++;},f=>{f.post[f.model.index]++;f.post[0]--;},f=>{f.failed=true;},f=>{f.post[f.post.length-1]++;}]){
  const f=fixture();mutate(f);assert.throws(()=>reconcileOperatingCost(f.model,f));
 }
});
test('cost model is exact-packet, program-version, operator and rent-bound',()=>{
 for(const mutate of [f=>{f.row.costIntent.programVersion=2;},f=>{f.row.costIntent.operator=String(key());},f=>{f.row.costIntent.maximumRentLamports='2100001';},f=>{f.x.campaign=String(key());},f=>{f.x.programId=String(key());},f=>{f.row.costModel='all-rent';}]){
  const f=fixture();mutate(f);assert.throws(()=>operatingCostModel(f.row,f.packet,f.x));
 }
 const f=fixture(),ix=feesInitInstruction(f.x.programId,f.x.campaign,f.x.payer,f.row.costIntent.operator),tx=new VersionedTransaction(new TransactionMessage({payerKey:ix.keys[1].pubkey,recentBlockhash:f.row.block.blockhash,instructions:[ix,SystemProgram.transfer({fromPubkey:ix.keys[1].pubkey,toPubkey:key(),lamports:1})]}).compileToV0Message());
 assert.throws(()=>operatingCostModel(f.row,{tx,bytes:tx.message.serialize()},f.x));
});
test('operating return model: exact template, the creator receives the amount, the fee is the only cost; a failed return moves nothing',()=>{
 const x={genesisHash:String(key()),payer:String(key()),programId:String(key()),campaign:String(key()),maximumLamports:'80000000'},creator=String(key());
 const row={costModel:'v3-operating-return',costIntent:{programVersion:3,creator,lamports:'79995000',computeUnits:20000},block:{blockhash:String(key())}};
 const build=ixs=>{const tx=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(x.payer),recentBlockhash:row.block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:20000}),...ixs]}).compileToV0Message());return {tx,bytes:tx.message.serialize()};};
 const packet=build(operatingReturnInstructions(x,{creator,lamports:'79995000'}));
 assert.equal(packet.tx.message.compiledInstructions.length,3);assert.match(operatingReturnMemo({...x,creator,lamports:'79995000'}),/^KIDS operating return:[a-f0-9]{64}$/);
 const model=operatingCostModel(row,packet,x);assert.equal(model.kind,'v3-operating-return');assert.equal(model.returnLamports,79995000n);assert.ok(model.index>0);
 const pre=packet.tx.message.staticAccountKeys.map(()=>0),post=pre.slice();pre[0]=100000000;post[0]=100000000-79995000-5000;post[model.index]=79995000;
 assert.equal(reconcileOperatingCost(model,{pre,post,fee:5000n,failed:false}),80000000n);
 const failedPost=pre.slice();failedPost[0]-=5000;assert.equal(reconcileOperatingCost(model,{pre,post:failedPost,fee:5000n,failed:true}),5000n);
 assert.throws(()=>reconcileOperatingCost(model,{pre,post:post.map((v,i)=>i===model.index?v-1:v),fee:5000n,failed:false}),/does not reconcile/);
 const otherIndex=[1,2,3].find(i=>i!==model.index);assert.throws(()=>reconcileOperatingCost(model,{pre,post:post.map((v,i)=>i===otherIndex?v+1:v),fee:5000n,failed:false}),/Unexplained/);
 assert.throws(()=>reconcileOperatingCost(model,{pre,post,fee:5000n,failed:true}),/does not reconcile/);
 assert.throws(()=>operatingCostModel({...row,costIntent:{...row.costIntent,lamports:'80000000'}},packet,x),/Invalid operating return intent/);
 assert.throws(()=>operatingCostModel(row,build(operatingReturnInstructions(x,{creator,lamports:'79995001'})),x),/differs/);
 assert.throws(()=>operatingCostModel(row,build(operatingReturnInstructions({...x,campaign:String(key())},{creator,lamports:'79995000'})),x),/differs/);
 assert.throws(()=>operatingCostModel({...row,costIntent:{...row.costIntent,creator:x.payer}},build(operatingReturnInstructions(x,{creator:x.payer,lamports:'79995000'})),x),/recipient/);
});
