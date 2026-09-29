// Real local-validator transactions, using small separate boundary fixtures.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {context,localKey,chainTime,devVestingState,claimDevVesting} from './dev-vesting.mjs';
import {Keypair,PublicKey,Transaction,ComputeBudgetProgram,sendAndConfirmTransaction,token,rewards,merkle} from './rewards-client.mjs';
import {scheduleBytes} from './vesting-plan.mjs';
const ctx=await context(),{connection,programId}=ctx,admin=localKey('admin'),alice=localKey('alice'),bob=localKey('bob'),mint=new PublicKey(ctx.config.mints.SHART);
const state=await devVestingState();assert(state.funded);assert.equal(state.totalRaw,'30000000000000');
const txs=[],checks=[];
async function send(ixs,signers){return sendAndConfirmTransaction(connection,new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:600000}),...ixs),signers,{commitment:'confirmed'});}
async function rejected(label,fn){let error;try{await fn();}catch(e){error=e;}assert(error,label+' unexpectedly succeeded');if(!error.message.includes('custom program error'))throw error;checks.push(label);}
const ata=token.getAssociatedTokenAddressSync(mint,alice.publicKey);
await send([token.createAssociatedTokenAccountIdempotentInstruction(admin.publicKey,ata,alice.publicKey,mint)],[admin]);
async function fixture(kind,start,end){const schedule=scheduleBytes(kind,start,end),seed=Keypair.generate(),amount=1000000n;
 const built=rewards.createMerkleDistributionInstruction({payer:admin.publicKey,authority:admin.publicKey,seed:seed.publicKey,mint,tokenProgram:token.TOKEN_PROGRAM_ID,authorityTokenAccount:token.getAssociatedTokenAddressSync(mint,admin.publicKey),merkleRoot:merkle.rewardsLeafHash(alice.publicKey,amount,schedule),amount,totalAmount:amount,clawbackTs:9223372036854775807n,revocable:0,programId});
 txs.push(await send([built.instruction],[admin,seed]));
 const claim=(who=alice,opts={})=>rewards.claimMerkleInstruction({payer:who.publicKey,claimant:who.publicKey,distribution:built.distribution,mint,tokenProgram:token.TOKEN_PROGRAM_ID,claimantTokenAccount:ata,totalAmount:amount,amount:0n,schedule,proof:[],programId,...opts}).instruction;
 return {...built,claim,amount};
}
const now=await chainTime(connection);
const future=await fixture('launch',now+3600,now+7200);
await rejected('launch unlock rejected before launch',()=>send([future.claim()],[alice]));
const partial=await fixture('linear',now-3600,now+3600);
await rejected('wrong dev rejected on chain',()=>send([partial.claim(bob)],[bob]));
await rejected('schedule tampering rejected',()=>send([partial.claim(alice,{schedule:Buffer.from([0])})],[alice]));
await rejected('unvested full withdrawal rejected',()=>send([partial.claim(alice,{amount:partial.amount})],[alice]));
const sig=await send([partial.claim()],[alice]);txs.push(sig);
const claimed=rewards.decodeMerkleDistribution((await connection.getAccountInfo(partial.distribution)).data).totalClaimed;
assert(claimed>400000n&&claimed<600000n);checks.push('partial linear claim paid only vested amount');
await rejected('early clawback rejected even for funding admin',()=>send([rewards.closeMerkleDistributionInstruction({authority:admin.publicKey,distribution:partial.distribution,mint,tokenProgram:token.TOKEN_PROGRAM_ID,authorityTokenAccount:token.getAssociatedTokenAddressSync(mint,admin.publicKey),programId}).instruction],[admin]));
const ended=await fixture('linear',now-7200,now-3600);
const before=(await token.getAccount(connection,ata)).amount;txs.push(await send([ended.claim()],[alice]));assert.equal((await token.getAccount(connection,ata)).amount-before,ended.amount);checks.push('final unlock pays exact remainder');
await rejected('double claim rejected',()=>send([ended.claim()],[alice]));
// Exercise the actual funded three-month schedule too.
const beforeReal=(await token.getAccount(connection,ata)).amount;
const actual=await claimDevVesting(alice.publicKey.toBase58());txs.push(actual.signature);
const paid=(await token.getAccount(connection,ata)).amount-beforeReal;
assert(paid>0n);assert.equal(actual.state.tranches[0].claimedRaw,actual.state.immediateRaw);checks.push('funded 1% launch unlock claimed; three-month stream remains funded');
const report={network:'localnet',programId:programId.toBase58(),sourceCommit:rewards.REWARDS_PROGRAM_SOURCE_COMMIT,checks,partialClaimRaw:claimed.toString(),actualDevClaimRaw:paid.toString(),transactions:txs,limits:['Boundary fixtures use shifted timestamps; actual allocation keeps the full three-calendar-month schedule','This verifies dev vesting, not a pool launch or prelaunch escrow']};
writeFileSync(new URL('./.runtime/vesting-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
