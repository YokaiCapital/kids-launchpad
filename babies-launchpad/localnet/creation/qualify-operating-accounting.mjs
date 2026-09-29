// Explicit isolated-ledger accounting rehearsal. The ephemeral payer never leaves
// this process. No public funding policy, production signer or worker is enabled.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Connection,Keypair,PublicKey,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import pg from 'pg';
import {PostgresRegistry} from '../registry/registry.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
import {createOperatingLedger} from './operating-ledger.mjs';
import {createOperatingProofReader,buildOperatingFundingPacket} from './operating-proofs.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function qualifyOperatingAccounting({postgresUrl}){
 if(!postgresUrl)throw Error('Explicit test PostgreSQL required');
 const m=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v3-program.json',import.meta.url),'utf8'));
 if(m.network!=='localnet'||m.programVersion!==3||m.rpcUrl!=='http://127.0.0.1:19199')throw Error('Owned isolated v3 validator required');
 const connection=new Connection(m.rpcUrl,'confirmed');if(await connection.getGenesisHash()!==m.genesisHash)throw Error('Ledger identity changed');
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1});let pool,creator,payer;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:postgresUrl,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  creator=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(m.adminKeyFile,'utf8'))));assert.equal(creator.publicKey.toBase58(),m.pilotCreator);payer=Keypair.generate();
  const base={genesisHash:m.genesisHash,programId:m.programId,campaign:Keypair.generate().publicKey.toBase58(),payer:payer.publicKey.toBase58(),policy:'local-accounting-qualification'},terms={...base,creator:m.pilotCreator,lamports:'1000000'};
  // Synthetic registry identity only; this exercise cannot activate a campaign.
  await registry.campaigns.upsert({...base,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  const block=await connection.getLatestBlockhash('confirmed'),fundingTx=buildOperatingFundingPacket(terms,block);fundingTx.sign([creator]);
  const funding={binding:terms,block,signature:encodeBase58(fundingTx.signatures[0]),transactionBase64:Buffer.from(fundingTx.serialize()).toString('base64')};let spend=null;
  const reader=()=>createOperatingProofReader({connection,genesisHash:m.genesisHash,loadFundingPacket:async()=>funding,loadSpendPacket:async()=>spend});
  const ledger=()=>createOperatingLedger({registry,...reader()});
  const untilFinal=async sig=>{const until=Date.now()+45000;while(Date.now()<until){const s=(await connection.getSignatureStatuses([sig],{searchTransactionHistory:true})).value[0];if(s?.confirmationStatus==='finalized'){assert.equal(s.err,null);return;}await pause(400);}throw Error('Local signature did not finalize');};
  await connection.sendRawTransaction(fundingTx.serialize(),{skipPreflight:false,maxRetries:2});await untilFinal(funding.signature);
  const credits=await Promise.all(Array.from({length:8},()=>ledger().credit({...base,signature:funding.signature})));assert.equal(credits.filter(x=>!x.duplicate).length,1);
  const block2=await connection.getLatestBlockhash('confirmed'),tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:block2.blockhash,instructions:[SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:payer.publicKey,lamports:0})]}).compileToV0Message());tx.sign([payer]);
  const messageHash=createHash('sha256').update(tx.message.serialize()).digest('hex'),x={...base,operationId:'actual-network-fee',messageHash,maximumLamports:'10000'};
  spend={binding:base,operationId:x.operationId,maximumLamports:x.maximumLamports,costModel:'network-fee-only',block:block2,signature:encodeBase58(tx.signatures[0]),transactionBase64:Buffer.from(tx.serialize()).toString('base64')};
  assert.equal((await ledger().hold(x)).state,'held');assert.equal((await ledger().reconcile(x)).reason,'awaiting-finality');
  await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:2});await untilFinal(spend.signature);
  const settled=await ledger().reconcile(x);assert.equal(settled.state,'settled');assert.equal(settled.actualLamports,'5000');await ledger().reconcile(x);
  const balance=await ledger().balance(base),actual=await connection.getBalance(new PublicKey(base.payer),'finalized');assert.equal(balance.fundedLamports,'1000000');assert.equal(balance.heldLamports,'0');assert.equal(balance.availableLamports,String(actual));assert.equal(balance.spentLamports,'5000');
  return {network:'localnet',fundingSignature:funding.signature,spendSignature:spend.signature,creditedOnce:true,unknownHoldPreserved:true,actualCostReconciled:true,...balance,scope:'accounting-only-synthetic-campaign-no-funding-policy-or-worker-activation'};
 }finally{creator?.secretKey.fill(0);payer?.secretKey.fill(0);if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyOperatingAccounting({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
