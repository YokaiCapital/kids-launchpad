import test from 'node:test';import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {readCreationCosts} from './live-costs.mjs';import {ACCOUNT_BYTES} from '../budgets.mjs';
import {RAYDIUM_CPMM,AMM_CONFIG_TIERS} from '../protocol-v2/client.mjs';import {discriminator} from '../cpmm.mjs';
const key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const counts={transactions:8,signatures:11,ataCreates:9,lockedPositions:1,feeStates:1};
function fixture(){
 const config=Buffer.alloc(236);discriminator('account:AmmConfig').copy(config);config.writeUInt16LE(7,10);config.writeBigUInt64LE(25000n,12);config.writeBigUInt64LE(120000n,20);config.writeBigUInt64LE(40000n,28);config.writeBigUInt64LE(150000000n,36);
 const clock=Buffer.alloc(40);clock.writeBigInt64LE(1790000000n,32);const rents=[];
 const connection={getGenesisHash:async()=>key(1),getMultipleAccountsInfoAndContext:async()=>({context:{slot:100},value:[{owner:RAYDIUM_CPMM,data:config},{data:clock}]}),getMinimumBalanceForRentExemption:async bytes=>{rents.push(bytes);return bytes*10+100;},getLatestBlockhash:async()=>({blockhash:key(2),lastValidBlockHeight:300}),getFeeForMessage:async(m,c)=>{assert.equal(m.header.numRequiredSignatures,1);assert.equal(c,'confirmed');return {context:{slot:101},value:5000};}};
 return {config,rents,connection,input:{connection,genesisHash:key(1),owner:key(3),ammConfig:AMM_CONFIG_TIERS[1].address.toBase58(),counts,priorityFeeLamports:'10000'}};
}
test('setup evidence reads every rent live and prices all planned signatures and fee state',async()=>{
 const f=fixture(),q=await readCreationCosts(f.input),by=s=>q.costs.lines.find(l=>l.item.startsWith(s));
 assert.equal(q.coverage,'bounded-setup-only');assert.equal(q.evidence.tradeFeeRate,'25000');
 assert.equal(by('associated').lamports,String((165*10+100)*9));assert.equal(by('fee state').lamports,'1700');
 assert.equal(by('transaction').lamports,String(5000*11+10000*8));assert.equal(by('receipt').lamports,'0');
 assert.deepEqual([...f.rents].sort((a,b)=>a-b),[...new Set(Object.values(ACCOUNT_BYTES))].sort((a,b)=>a-b));
 assert.equal(BigInt(q.costs.totalLamports),BigInt(q.costs.subtotalLamports)+BigInt(q.costs.marginLamports));
});
test('inactive config creator rate is not confused with enabling creator fees on a pool',async()=>{
 const f=fixture();f.config.writeBigUInt64LE(500n,108);assert.equal((await readCreationCosts(f.input)).evidence.tradeFeeRate,'25000');
});
test('setup quote refuses unknown fees, changed network, unsupported config, stale context and disabled pools',async()=>{
 for(const mutate of [f=>f.connection.getFeeForMessage=async()=>({context:{slot:101},value:null}),f=>f.connection.getFeeForMessage=async()=>({context:{slot:99},value:5000}),f=>f.connection.getMinimumBalanceForRentExemption=async()=>Number.MAX_SAFE_INTEGER+1,f=>f.connection.getGenesisHash=async()=>key(4),f=>{f.config[9]=1;},f=>f.config.writeBigUInt64LE(20000n,12),f=>f.input.ammConfig=key(4),f=>f.input.counts={transactions:8},f=>f.input.priorityFeeLamports=undefined]){
  const f=fixture();mutate(f);await assert.rejects(readCreationCosts(f.input));
 }
 const f=fixture();let calls=0;f.connection.getGenesisHash=async()=>key(++calls===1?1:4);await assert.rejects(readCreationCosts(f.input),/network changed/);
});
