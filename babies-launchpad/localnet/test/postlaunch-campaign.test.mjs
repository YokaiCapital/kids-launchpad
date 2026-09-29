import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {Keypair} from '@solana/web3.js';import {NATIVE_MINT,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {createCampaignResolver,verifyLaunchedIdentity} from '../postlaunch-campaign.mjs';
import {poolAddresses} from '../cpmm.mjs';import {CPMM,AMM_CONFIG} from '../atomic-launch.mjs';
const pk=()=>Keypair.generate().publicKey;
function fixture(){
 const programId=pk(),address=pk(),mint=pk(),creator=pk(),dev=pk(),treasury=pk(),p=poolAddresses(CPMM,AMM_CONFIG,mint,NATIVE_MINT);
 const state={phase:3,mint,pool:p.pool,creator,dev,treasury,soft:100000000000n,hard:500000000000n,supply:1000000000000000n,deadline:100,launchDeadline:86500};
 const record={ready:true,network:'localnet',rpcUrl:'http://127.0.0.1:19099',address:address.toBase58(),campaign:address.toBase58(),mint:mint.toBase58(),pool:p.pool.toBase58(),creator:creator.toBase58(),dev:dev.toBase58(),treasury:treasury.toBase58(),soft:state.soft.toString(),hard:state.hard.toString(),supply:state.supply.toString(),deadline:100,launchDeadline:86500,programId:programId.toBase58(),programSha256:'hash',genesisHash:'genesis',launchSignature:'receipt'};
 const pool=Buffer.alloc(637);createHash('sha256').update('account:PoolState').digest().copy(pool,0,0,8);[AMM_CONFIG,creator,p.vault0,p.vault1,p.lpMint,p.mint0,p.mint1,TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,p.observation].forEach((k,i)=>k.toBuffer().copy(pool,8+i*32));
 const config=Buffer.alloc(236);createHash('sha256').update('account:AmmConfig').digest().copy(config,0,0,8);config.writeUInt16LE(2,10);config.writeBigUInt64LE(20000n,12);config.writeBigUInt64LE(120000n,20);config.writeBigUInt64LE(40000n,28);
 const ctx={programId,manifest:{sha256:'hash',genesisHash:'genesis'},connection:{getMultipleAccountsInfo:async()=>[{owner:CPMM,data:pool},{owner:CPMM,data:config}],getSignatureStatuses:async()=>({value:[{confirmationStatus:'confirmed',err:null}]})}};
 return {ctx,state,record};
}
test('registered active prelaunch never falls back or masquerades as launched',async()=>{
 const f=fixture();f.state.phase=0;const resolver=createCampaignResolver({context:async()=>f.ctx,readState:async()=>f.state,has:()=>true,readRecord:()=>f.record});assert.equal(await resolver.resolve('active'),null);await assert.rejects(resolver.byCampaign(f.record.address),/has not launched/);assert.throws(()=>verifyLaunchedIdentity(f.ctx,f.state,f.record),/has not launched/);
});
test('active selection requires confirmed receipt and exact canonical chain identity',async()=>{
 const f=fixture(),resolver=createCampaignResolver({context:async()=>f.ctx,readState:async()=>f.state,has:()=>true,readRecord:()=>f.record});assert.equal((await resolver.resolve('active')).scope,'active-localnet');
 f.record.genesisHash='other';await assert.rejects(resolver.resolve('active'),/identity|ledger|program/i);f.record.genesisHash='genesis';f.state.pool=pk();await assert.rejects(resolver.resolve('active'),/pool/);f.state.pool=poolAddresses(CPMM,AMM_CONFIG,f.state.mint,NATIVE_MINT).pool;f.ctx.connection.getSignatureStatuses=async()=>({value:[{confirmationStatus:'processed',err:null}]});await assert.rejects(resolver.resolve('active'),/not confirmed/);f.ctx.connection.getSignatureStatuses=async()=>({value:[null]});assert.equal((await resolver.resolve('active')).receiptHistoryAvailable,false);
});
test('a stored campaign cannot be replayed against another registered pool',async()=>{
 const f=fixture(),resolver=createCampaignResolver({context:async()=>f.ctx,readState:async()=>f.state,has:()=>true,readRecord:()=>f.record});await assert.rejects(resolver.byCampaign(pk().toBase58()),/not a registered/);assert.equal((await resolver.resolve('rehearsal')).scope,'localnet-rehearsal');
});
