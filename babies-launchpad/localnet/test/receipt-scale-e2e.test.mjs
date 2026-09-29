// Explicit localnet benchmark. Measures actual program work, not hosted/mainnet
// throughput; does not enable batching in any deployed worker or change policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {Connection,PublicKey,Keypair,Transaction,VersionedTransaction,SystemProgram,ComputeBudgetProgram,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import * as client from '../protocol-v2/client.mjs';
import * as policy from '../protocol-v2/policy.mjs';
const enabled=process.env.KIDS_QUALIFY_RECEIPT_SCALE==='1';
const SOL=1000000000n;
const chunks=(items,n)=>Array.from({length:Math.ceil(items.length/n)},(_,i)=>items.slice(i*n,(i+1)*n));
async function concurrent(items,n,fn){let next=0;const results=[];await Promise.all(Array.from({length:n},async()=>{for(;;){const i=next++;if(i>=items.length)return;results[i]=await fn(items[i],i);}}));return results;}
test('100 receipts: exact settlement/refunds, atomic batch failure and measured keeper costs',{skip:!enabled,timeout:240000},async t=>{
 const manifest=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v3-program.json',import.meta.url),'utf8'));
 assert.equal(manifest.rpcUrl,'http://127.0.0.1:19199');assert.equal(manifest.programVersion,3);
 const connection=new Connection(manifest.rpcUrl,'confirmed'),programId=new PublicKey(manifest.programId);
 assert.equal(await connection.getGenesisHash(),manifest.genesisHash);assert.ok((await connection.getAccountInfo(programId))?.executable);
 const load=path=>Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path,'utf8'))));
 const admin=load(manifest.adminKeyFile),treasury=load(manifest.treasuryKeyFile),owners=Array.from({length:100},()=>Keypair.generate());
 assert.equal(admin.publicKey.toBase58(),manifest.pilotCreator);
 const send=async(instructions,payer=admin,{skipPreflight=false,measure=false}={})=>{
  const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:600000}),...instructions);
  const block=await connection.getLatestBlockhash('confirmed');tx.recentBlockhash=block.blockhash;tx.feePayer=payer.publicKey;tx.sign(payer);
  const wire=tx.serialize();let metrics={};
  if(measure){
   const sim=await connection.simulateTransaction(VersionedTransaction.deserialize(wire),{sigVerify:true,commitment:'confirmed'});
   assert.equal(sim.value.err,null);assert.ok(Number.isSafeInteger(sim.value.unitsConsumed));
   const fee=await connection.getFeeForMessage(tx.compileMessage(),'confirmed');assert.ok(Number.isSafeInteger(fee.value));
   metrics={quotedFeeLamports:fee.value,simulatedComputeUnits:sim.value.unitsConsumed};
  }
  const signature=await connection.sendRawTransaction(wire,{skipPreflight,maxRetries:0});
  assert.equal((await connection.confirmTransaction({signature,...block},'confirmed')).value.err,null);
  return {signature,packetBytes:wire.length,...metrics};
 };
 const clock=async()=>BigInt((await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)).data.readBigInt64LE(32));
 if(await connection.getBalance(admin.publicKey)<Number(10n*SOL)){const s=await connection.requestAirdrop(admin.publicKey,Number(20n*SOL));await connection.confirmTransaction(s,'confirmed');}
 await concurrent(chunks(owners,10),4,group=>send(group.map(o=>SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:o.publicKey,lamports:50000000n}))));
 const now=await clock(),nonce=randomBytes(8).readBigUInt64LE(),tier=client.AMM_CONFIG_TIERS[0],mint=Keypair.generate().publicKey;
 const terms={layoutVersion:2,mode:0,decimals:6,splitPolicy:policy.SPLIT_POLICY_STANDARD_V3,vestingRule:policy.VESTING_RULE_STANDARD_V3,feeRoutingVersion:1,creatorFeeEnabled:0,
  genesis:new PublicKey(manifest.genesisHash),creator:admin.publicKey,nonce,dev:admin.publicKey,treasury:treasury.publicKey,childMint:mint,supply:1000000000000000n,
  opensAt:now-1n,deadline:now+45n,launchDeadline:now+3600n,soft:SOL,hard:2n*SOL,
  ammProgram:client.RAYDIUM_CPMM,ammConfig:tier.address,ammTradeFeeRate:tier.tradeFeeRate,ammConfigIndex:tier.index,
  feeWeights:policy.FEE_WEIGHTS_STANDARD,splitBps:policy.SPLIT_STANDARD_V3,vesting:policy.VESTING_STANDARD_V3,buybackMaxSlippageBps:0,lockProgram:client.RAYDIUM_LOCK,
  metadataHash:createHash('sha256').update('receipt scale fixture').digest(),metadataUri:'https://kids.fun/rehearsal/receipt-scale.json',parentReferenceConfig:[0,0]};
 const made=client.createInstruction(programId,terms),campaign=made.campaign;
 await send([made.instruction]);
 const read=async()=>client.decodeCampaign((await connection.getAccountInfo(campaign)).data);
 const committedAt=Date.now();
 await concurrent(owners,8,o=>send([client.commitInstruction(programId,campaign,o.publicKey,manifest.genesisHash,30000000n,0n)],o));
 const commitMs=Date.now()-committedAt;
 assert.equal((await read()).state.receiptCount,100n);assert.equal((await read()).state.total,3n*SOL);
 while(await clock()<terms.deadline)await pause(500);
 await send([client.finalizeInstruction(programId,campaign)]);
 const instructions=group=>group.flatMap(o=>[client.settleInstruction(programId,campaign,o.publicKey),client.refundInstruction(programId,campaign,o.publicKey)]);
 const receiptKeys=owners.map(o=>client.receiptAddress(programId,campaign,o.publicKey));
 const before=await connection.getMultipleAccountsInfo([campaign,receiptKeys[0],owners[0].publicKey]);
 const badRefund=client.refundInstruction(programId,campaign,owners[1].publicKey);badRefund.keys[2].pubkey=owners[0].publicKey;
 // The first owner's valid settlement/refund must roll back with the bad second
 // recipient. Skip preflight so the validator actually executes the failed tx.
 await assert.rejects(send([...instructions([owners[0]]),badRefund],admin,{skipPreflight:true}));
 const after=await connection.getMultipleAccountsInfo([campaign,receiptKeys[0],owners[0].publicKey]);
 for(let i=0;i<before.length;i++){assert.equal(after[i].lamports,before[i].lamports);assert.deepEqual(after[i].data,before[i].data);}
 const individualAt=Date.now();
 const measured=ix=>send(ix,admin,{measure:true});
 const individual=await concurrent(owners.slice(0,20),4,async o=>[await measured([client.settleInstruction(programId,campaign,o.publicKey)]),await measured([client.refundInstruction(programId,campaign,o.publicKey)])]);
 const individualMs=Date.now()-individualAt,batchAt=Date.now();
 // Settlement and refund stay separate, as in the independently scheduled lanes.
 const batches=await concurrent(chunks(owners.slice(20),8),4,async group=>[await measured(group.map(o=>client.settleInstruction(programId,campaign,o.publicKey))),await measured(group.map(o=>client.refundInstruction(programId,campaign,o.publicKey)))]);
 const batchMs=Date.now()-batchAt;
 await connection.confirmTransaction(batches.at(-1)[1].signature,'finalized');
 const state=(await read()).state;
 assert.equal(state.settledCount,100n);assert.equal(state.settledAccepted,2n*SOL);assert.equal(state.refunded,SOL);
 const accounts=await connection.getMultipleAccountsInfo(receiptKeys,'finalized');
 accounts.forEach((a,i)=>{assert.ok(a.owner.equals(programId));const r=client.decodeReceipt(a.data);assert.ok(r.owner.equals(owners[i].publicKey));assert.equal(r.committed,30000000n);assert.equal(r.accepted,20000000n);assert.equal(r.refunded,10000000n);assert.equal(r.settled,true);});
 // A replay with a new transaction signature cannot increase payments/counters.
 const repeated=await send(instructions(owners.slice(20,28)));
 assert.deepEqual((await read()).state,state);
 const metrics=({quotedFeeLamports,simulatedComputeUnits,packetBytes})=>({quotedFeeLamports,simulatedComputeUnits,packetBytes});
 const settle=metrics(individual[0][0]),refund=metrics(individual[0][1]),settleBatch=metrics(batches[0][0]),refundBatch=metrics(batches[0][1]);
 assert.ok(Math.max(settleBatch.packetBytes,refundBatch.packetBytes)<=1232);assert.ok(Math.max(settleBatch.simulatedComputeUnits,refundBatch.simulatedComputeUnits)<=600000);
 const report={scope:'isolated-v3-receipt-program-only-not-mainnet-throughput',campaign:campaign.toBase58(),receipts:100,commitMs,individualReceipts:20,individualTransactions:40,individualMs,batchReceipts:80,batchTransactions:20,batchSize:8,batchMs,settle,refund,settleBatch,refundBatch,receiptRentLamports:await connection.getMinimumBalanceForRentExemption(policy.RECEIPT_LEN),totalAcceptedLamports:String(state.settledAccepted),totalRefundedLamports:String(state.refunded),atomicFailureVerified:true,replaySignature:repeated.signature};
 t.diagnostic(JSON.stringify(report));
 for(const o of owners)o.secretKey.fill(0);admin.secretKey.fill(0);treasury.secretKey.fill(0);
});
