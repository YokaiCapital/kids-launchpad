// Explicit owned-localnet qualification against an existing, live test campaign
// with no fee state. Creates its fee state only; does not enable fee workers.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Connection,Keypair,PublicKey,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import pg from 'pg';
import {PostgresRegistry} from '../registry/registry.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
import {decodeCampaign,decodeFeeState,feeStateAddress,feesInitInstruction} from '../protocol-v2/client.mjs';
import {createOperatingLedger} from './operating-ledger.mjs';
import {buildOperatingFundingPacket,createOperatingProofReader} from './operating-proofs.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function qualifyOperatingRent({postgresUrl,campaign}){
 if(!postgresUrl||!campaign)throw Error('Explicit test database and owned test campaign required');
 const m=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v3-program.json',import.meta.url),'utf8'));
 if(m.network!=='localnet'||m.programVersion!==3||m.rpcUrl!=='http://127.0.0.1:19199')throw Error('Owned isolated v3 validator required');
 const c=new Connection(m.rpcUrl,'finalized');assert.equal(await c.getGenesisHash(),m.genesisHash);
 const program=await c.getAccountInfo(new PublicKey(m.programId),'finalized');assert.equal(program.executable,true);assert.equal(program.data.readUInt32LE(0),2);
 const binary=await c.getAccountInfo(new PublicKey(program.data.subarray(4,36)),'finalized');assert.equal(createHash('sha256').update(binary.data.subarray(45,45+m.binarySize)).digest('hex'),m.sha256);
 const account=await c.getAccountInfo(new PublicKey(campaign),'finalized');assert.equal(String(account.owner),m.programId);
 const state=decodeCampaign(account.data);assert.equal(state.state.phase,3);assert.equal(state.terms.mode,0);assert.equal(String(state.terms.treasury),m.treasury);
 const feeAddress=feeStateAddress(m.programId,campaign);assert.equal(await c.getAccountInfo(feeAddress,'finalized'),null,'Choose an uninitialized owned test fee state');
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1});let pool,creator,payer;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:postgresUrl,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  creator=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(m.adminKeyFile,'utf8'))));payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(m.treasuryKeyFile,'utf8'))));assert.equal(String(creator.publicKey),m.pilotCreator);assert.equal(String(payer.publicKey),m.treasury);
  const base={genesisHash:m.genesisHash,programId:m.programId,campaign,payer:m.treasury,policy:'local-rent-qualification'};
  await registry.campaigns.upsert({...base,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  const block=await c.getLatestBlockhash('confirmed'),fundingIntent={...base,creator:m.pilotCreator,lamports:'3000000'},fundingTx=buildOperatingFundingPacket(fundingIntent,block);fundingTx.sign([creator]);
  const funding={binding:fundingIntent,block,signature:encodeBase58(fundingTx.signatures[0]),transactionBase64:Buffer.from(fundingTx.serialize()).toString('base64')};let spend;
  const proofs=createOperatingProofReader({connection:c,genesisHash:m.genesisHash,loadFundingPacket:async()=>funding,loadSpendPacket:async()=>spend}),ledger=createOperatingLedger({registry,...proofs});
  async function finalized(sig){const until=Date.now()+45000;while(Date.now()<until){const s=(await c.getSignatureStatuses([sig],{searchTransactionHistory:true})).value[0];if(s?.confirmationStatus==='finalized'){assert.equal(s.err,null);return;}await pause(400);}throw Error('Local rent signature did not finalize');}
  await c.sendRawTransaction(fundingTx.serialize(),{maxRetries:2,preflightCommitment:'confirmed'});await finalized(funding.signature);await ledger.credit({...base,signature:funding.signature});
  const block2=await c.getLatestBlockhash('confirmed'),rent=await c.getMinimumBalanceForRentExemption(160,'finalized'),tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:block2.blockhash,instructions:[feesInitInstruction(m.programId,campaign,payer.publicKey,creator.publicKey)]}).compileToV0Message());tx.sign([payer]);
  const held={...base,operationId:'fee-state-init',messageHash:createHash('sha256').update(tx.message.serialize()).digest('hex'),maximumLamports:String(rent+10000)};
  spend={binding:base,operationId:held.operationId,maximumLamports:held.maximumLamports,costModel:'v3-fee-state-rent',costIntent:{programVersion:3,operator:m.pilotCreator,maximumRentLamports:String(rent)},block:block2,signature:encodeBase58(tx.signatures[0]),transactionBase64:Buffer.from(tx.serialize()).toString('base64')};
  assert.equal((await ledger.hold(held)).state,'held');assert.equal((await ledger.reconcile(held)).reason,'awaiting-finality');
  await c.sendRawTransaction(tx.serialize(),{maxRetries:2,preflightCommitment:'confirmed'});await finalized(spend.signature);
  const settled=await ledger.reconcile(held);assert.equal(settled.actualLamports,String(rent+5000));await ledger.reconcile(held);
  const balance=await ledger.balance(base);assert.equal(balance.heldLamports,'0');assert.equal(balance.availableLamports,String(3000000-rent-5000));
  const fee=await c.getAccountInfo(feeAddress,'finalized');assert.equal(String(fee.owner),m.programId);assert.equal(fee.data.length,160);assert.equal(fee.lamports,rent);assert.equal(String(decodeFeeState(fee.data,campaign).operator),m.pilotCreator);
  return {network:'localnet',campaign,fundingSignature:funding.signature,spendSignature:spend.signature,actualRentLamports:String(rent),actualNetworkFeeLamports:'5000',unusedReservationReleased:true,...balance,scope:'local-fee-state-only-no-worker-activation'};
 }finally{creator?.secretKey.fill(0);payer?.secretKey.fill(0);if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyOperatingRent({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,campaign:process.env.KIDS_TEST_RENT_CAMPAIGN}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
