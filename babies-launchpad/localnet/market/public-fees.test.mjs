import test from 'node:test';import assert from 'node:assert/strict';import {PublicKey} from '@solana/web3.js';
import * as client from '../protocol-v2/client.mjs';import {projectStandardFees,validateFeeProjection} from './public-fees.mjs';
const key=n=>new PublicKey(Buffer.alloc(32,n)),programId=key(2),campaign=key(3);
function fixture(){
 const bytes=Buffer.alloc(client.FEE_STATE_LEN);client.FEE_STATE_MAGIC.copy(bytes);campaign.toBuffer().copy(bytes,8);
 // 169 lamports: floor(169*148/168)=148, floor(169*20/168)=20, 1 dust.
 for(const [i,v]of [[0,2n],[1,169n],[2,100n],[3,10n],[10,3n]])bytes.writeBigUInt64LE(v,40+8*i);
 return {bytes,input:{programId,campaign,slot:10,terms:{mode:0,supply:1000n,ammTradeFeeRate:25000n,feeWeights:{treasury:148,dev:20,parentA:0,parentB:0}},account:{owner:String(programId),executable:false,data:[bytes.toString('base64'),'base64']}}};
}
test('finalized counters conserve collected fees, distributions, burns and rounding dust',()=>{
 const {input}=fixture(),f=projectStandardFees(input);validateFeeProjection(f);
 assert.equal(f.solCollectedLamports,'169');assert.equal(f.solPendingLamports,'59');assert.equal(f.solDustLamports,'1');assert.equal(f.treasuryAccruedLamports,'148');assert.equal(f.devAccruedLamports,'20');assert.equal(f.coinCollectedBaseUnits,'5');assert.equal(f.coinBurnedBaseUnits,'3');assert.equal(f.poolTradeFeeRate,'25000');
 for(const field of ['solPendingLamports','coinCollectedBaseUnits','solDustLamports'])assert.throws(()=>validateFeeProjection({...f,[field]:'0'}),/conserve/);
});
test('missing setup stays unknown; wrong owner, campaign, data, scope or parent amounts are rejected',()=>{
 const {input,bytes}=fixture();assert.equal(projectStandardFees({...input,account:null}).status,'awaiting-setup');
 for(const account of [{...input.account,owner:String(key(9))},{...input.account,executable:true},{...input.account,data:['bad','base64']}])assert.throws(()=>projectStandardFees({...input,account}));
 assert.throws(()=>projectStandardFees({...input,campaign:key(9)}));assert.throws(()=>projectStandardFees({...input,terms:{...input.terms,mode:1}}));
 bytes.writeBigUInt64LE(1n,72);assert.throws(()=>projectStandardFees({...input,account:{...input.account,data:[bytes.toString('base64'),'base64']}}));
});
test('overpayment and impossible burn totals are rejected, not clamped into reassuring values',()=>{
 const {input,bytes}=fixture();bytes.writeBigUInt64LE(149n,56);assert.throws(()=>projectStandardFees({...input,account:{...input.account,data:[bytes.toString('base64'),'base64']}}));
 assert.throws(()=>projectStandardFees({...input,terms:{...input.terms,supply:4n}}));
 const f=projectStandardFees(input);for(const poolTradeFeeRate of ['0','1000000','NaN'])assert.throws(()=>validateFeeProjection({...f,poolTradeFeeRate}));
});
