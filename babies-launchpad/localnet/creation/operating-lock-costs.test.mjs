import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,SystemProgram} from '@solana/web3.js';
import {launchInstruction} from '../protocol-v2/client.mjs';
import {operatingCostModel,reconcileOperatingCost} from './operating-costs.mjs';
const key=()=>Keypair.generate().publicKey;
function fixture(){
 const x={payer:String(key()),programId:String(key()),campaign:String(key()),maximumLamports:'12000000'};
 const row={costModel:'v3-launch-lock-rent',costIntent:{programVersion:3,maximumRentLamports:'11000000',computeUnits:1000000,feeNft:String(key()),terms:{childMint:String(key()),ammProgram:String(key()),ammConfig:String(key()),lockProgram:String(key())}},block:{blockhash:String(key())}};
 const {instruction}=launchInstruction(x.programId,x.campaign,row.costIntent.terms,x.payer,row.costIntent.feeNft);
 const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:row.costIntent.computeUnits}),instruction];
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:instruction.keys[1].pubkey,recentBlockhash:row.block.blockhash,instructions}).compileToV0Message()),packet={tx,bytes:tx.message.serialize()};
 assert.ok(tx.serialize().length<=1232,'Qualified packet fits without address lookup tables');
 const model=operatingCostModel(row,packet,x),pre=tx.message.staticAccountKeys.map(()=>0),post=pre.slice();
 pre[0]=20000000;const rents=[1461600,2039280,2672640,2039280];
 model.rentIndices.forEach((i,n)=>{post[i]=rents[n];});post[0]=pre[0]-10000-rents.reduce((a,b)=>a+b,0);
 // Accepted funds and the PDA's independently funded setup budget must not
 // become an operating charge against the keeper's campaign budget.
 pre[model.poolIndices[0]]=50000000000;post[model.poolIndices[0]]=10000000;
 pre[model.poolIndices[1]]=100000000;post[model.poolIndices[1]]=1000000;
 return {x,row,packet,model,pre,post,fee:10000n,instructions};
}
test('lock cost attributes only four rent destinations and fee, not pool reserves',()=>{
 const f=fixture();assert.equal(reconcileOperatingCost(f.model,f),8222800n);
 f.pre[f.model.rentIndices[2]]=1000000;f.post[0]+=1000000;
 assert.equal(reconcileOperatingCost(f.model,f),7222800n,'Only the keeper top-up is charged');
});
test('failed atomic launch charges only the network fee and releases no unexplained movement',()=>{
 const f=fixture();f.post=f.pre.slice();f.post[0]-=10000;
 assert.equal(reconcileOperatingCost(f.model,{...f,failed:true}),10000n);
 f.post[f.model.poolIndices[0]]--;assert.throws(()=>reconcileOperatingCost(f.model,{...f,failed:true}));
});
test('lock rent refuses unexplained inflow, rent refunds, over-ceiling or metadata movement',()=>{
 for(const mutate of [f=>f.post[0]++,f=>{f.pre[f.model.rentIndices[0]]=2000000;},f=>{f.post[f.model.rentIndices[0]]+=11000000;f.post[0]-=11000000;},f=>{const i=f.packet.tx.message.staticAccountKeys.findIndex(k=>k.equals(f.instructions[1].keys[10].pubkey));f.post[i]++;},f=>{f.failed=true;}]){
  const f=fixture();mutate(f);assert.throws(()=>reconcileOperatingCost(f.model,f));
 }
});
test('launch cost binds exact program, campaign, mint, AMM, lock, NFT and compute template',()=>{
 const changes=[f=>f.row.costIntent.programVersion=2,f=>f.x.campaign=String(key()),f=>f.x.programId=String(key()),f=>f.x.payer=String(key()),f=>f.row.costIntent.feeNft=String(key()),f=>f.row.costIntent.computeUnits++,f=>f.row.costIntent.maximumRentLamports='12000001',...['childMint','ammProgram','ammConfig','lockProgram'].map(k=>f=>f.row.costIntent.terms[k]=String(key()))];
 for(const mutate of changes){const f=fixture();mutate(f);assert.throws(()=>operatingCostModel(f.row,f.packet,f.x));}
 for(const extra of [ComputeBudgetProgram.setComputeUnitPrice({microLamports:1}),SystemProgram.transfer({fromPubkey:key(),toPubkey:key(),lamports:1})]){
  const f=fixture(),tx=new VersionedTransaction(new TransactionMessage({payerKey:f.instructions[1].keys[1].pubkey,recentBlockhash:f.row.block.blockhash,instructions:[...f.instructions,extra]}).compileToV0Message());
  assert.throws(()=>operatingCostModel(f.row,{tx,bytes:tx.message.serialize()},f.x));
 }
 const f=fixture();f.row.costIntent.terms.childMint=f.x.payer;assert.throws(()=>operatingCostModel(f.row,f.packet,f.x),/Aliased/);
});
