// Explicit fresh-campaign rehearsal on the owned v3 local validator. Exercises
// real Raydium locking and finalized cost attribution, not public activation.
import assert from 'node:assert/strict';
import {createStandardOperatingCostReader} from '../signer/standard-cost-reader.mjs';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Connection,Keypair,PublicKey,Transaction,TransactionMessage,VersionedTransaction,SystemProgram,ComputeBudgetProgram,SYSVAR_CLOCK_PUBKEY,sendAndConfirmTransaction} from '@solana/web3.js';
import {createMint,getOrCreateAssociatedTokenAccount,mintTo,setAuthority,AuthorityType,NATIVE_MINT} from '@solana/spl-token';
import pg from 'pg';
import * as client from '../protocol-v2/client.mjs';
import * as policy from '../protocol-v2/policy.mjs';
import {createChainAdapter} from '../protocol-v2/chain-adapter.mjs';
import {PostgresRegistry} from '../registry/registry.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
import {createOperatingLedger} from './operating-ledger.mjs';
import {buildOperatingFundingPacket,createOperatingProofReader} from './operating-proofs.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function qualifyOperatingLock({postgresUrl,log=()=>{}}){
 if(!postgresUrl)throw Error('Explicit local test database required');
 const m=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v3-program.json',import.meta.url),'utf8'));
 if(m.network!=='localnet'||m.programVersion!==3||m.rpcUrl!=='http://127.0.0.1:19199')throw Error('Owned isolated v3 validator required');
 const c=new Connection(m.rpcUrl,'confirmed');assert.equal(await c.getGenesisHash(),m.genesisHash);
 const program=await c.getAccountInfo(new PublicKey(m.programId),'finalized');assert.equal(program.executable,true);assert.equal(program.data.readUInt32LE(0),2);
 const binary=await c.getAccountInfo(new PublicKey(program.data.subarray(4,36)),'finalized');assert.equal(createHash('sha256').update(binary.data.subarray(45,45+m.binarySize)).digest('hex'),m.sha256);
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1}),directory=mkdtempSync(join(tmpdir(),'kids-operating-lock-'));let pool,creator,payer,nft;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:postgresUrl,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  creator=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(m.adminKeyFile,'utf8'))));payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(m.treasuryKeyFile,'utf8'))));nft=Keypair.generate();
  assert.equal(String(creator.publicKey),m.pilotCreator);assert.equal(String(payer.publicKey),m.treasury);
  const send=instructions=>sendAndConfirmTransaction(c,new Transaction().add(...instructions),[creator],{commitment:'confirmed'});
  const time=async()=> (await c.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'confirmed')).data.readBigInt64LE(32);
  const nonce=randomBytes(8).readBigUInt64LE(),campaign=client.campaignAddress(m.programId,creator.publicKey,nonce),authority=client.launchAuthority(m.programId,campaign);
  assert.equal(await c.getAccountInfo(campaign),null);
  const mint=await createMint(c,creator,creator.publicKey,creator.publicKey,6),custody=await getOrCreateAssociatedTokenAccount(c,creator,mint,authority,true);
  await getOrCreateAssociatedTokenAccount(c,creator,NATIVE_MINT,authority,true);
  const supply=1000000000000000n;await mintTo(c,creator,mint,custody.address,creator,supply);
  await setAuthority(c,creator,mint,creator,AuthorityType.MintTokens,authority);await setAuthority(c,creator,mint,creator,AuthorityType.FreezeAccount,authority);
  const now=await time(),tier=client.AMM_CONFIG_TIERS[0],terms={layoutVersion:2,mode:0,decimals:6,splitPolicy:policy.SPLIT_POLICY_STANDARD_V3,vestingRule:policy.VESTING_RULE_STANDARD_V3,feeRoutingVersion:1,creatorFeeEnabled:0,genesis:new PublicKey(m.genesisHash),creator:creator.publicKey,nonce,dev:creator.publicKey,treasury:payer.publicKey,childMint:mint,supply,
   opensAt:now-1n,deadline:now+30n,launchDeadline:now+3630n,soft:500000000n,hard:1000000000n,ammProgram:client.RAYDIUM_CPMM,ammConfig:tier.address,ammTradeFeeRate:tier.tradeFeeRate,ammConfigIndex:tier.index,feeWeights:policy.FEE_WEIGHTS_STANDARD,splitBps:policy.SPLIT_STANDARD_V3,vesting:policy.VESTING_STANDARD_V3,buybackMaxSlippageBps:0,lockProgram:client.RAYDIUM_LOCK,distributionProgram:PublicKey.default,
   parentMint:[PublicKey.default,PublicKey.default],parentProgram:[PublicKey.default,PublicKey.default],parentSlot:[0,0],parentRoot:['00'.repeat(32),'00'.repeat(32)],parentSupply:[0,0],parentEligible:[0,0],parentExpirySeconds:0,metadataHash:createHash('sha256').update('local-lock-cost:'+nonce).digest(),metadataUri:'https://kids.fun/rehearsal/'+mint+'.json',parentReferenceConfig:[0,0]};
  await send([client.createInstruction(m.programId,terms).instruction,SystemProgram.transfer({fromPubkey:creator.publicKey,toPubkey:authority,lamports:300000000n})]);
  await send([client.commitInstruction(m.programId,campaign,creator.publicKey,m.genesisHash,2000000000n,0n)]);
  log({event:'lock-qualification-funded',campaign:String(campaign)});
  const clockDeadline=Date.now()+120000;while(await time()<terms.deadline){if(Date.now()>clockDeadline)throw Error('Local campaign clock stalled');await pause(500);}
  await send([client.finalizeInstruction(m.programId,campaign),client.settleInstruction(m.programId,campaign,creator.publicKey)]);
  const base={genesisHash:m.genesisHash,programId:m.programId,campaign:String(campaign),payer:m.treasury,policy:'local-lock-cost-qualification'};
  await registry.campaigns.upsert({...base,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  async function finalized(signature){const until=Date.now()+120000;while(Date.now()<until){const status=(await c.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];if(status?.confirmationStatus==='finalized'){assert.equal(status.err,null);return;}await pause(400);}throw Error('Local lock transaction did not finalize');}
  const fundingIntent={...base,creator:m.pilotCreator,lamports:'20000000'},block=await c.getLatestBlockhash('confirmed'),fundingTx=buildOperatingFundingPacket(fundingIntent,block);fundingTx.sign([creator]);
  const funding={binding:fundingIntent,block,signature:encodeBase58(fundingTx.signatures[0]),transactionBase64:Buffer.from(fundingTx.serialize()).toString('base64')};let spend;
  const proofs=createOperatingProofReader({connection:c,genesisHash:m.genesisHash,loadFundingPacket:async()=>funding,loadSpendPacket:async()=>spend}),ledger=createOperatingLedger({registry,...proofs});
  writeFileSync(join(directory,'funding-packet.json'),JSON.stringify(funding),{mode:0o600,flag:'wx'});
  await c.sendRawTransaction(fundingTx.serialize(),{maxRetries:2,preflightCommitment:'confirmed'});await finalized(funding.signature);await ledger.credit({...base,signature:funding.signature});
  const sizes=[82,165,256,679],rents=Object.fromEntries(await Promise.all(sizes.map(async size=>[size,await c.getMinimumBalanceForRentExemption(size,'finalized')]))),rentLimit=rents[82]+rents[165]*2+rents[256]+rents[679];
  const launch=client.launchInstruction(m.programId,campaign,terms,payer.publicKey,nft.publicKey),block2=await c.getLatestBlockhash('confirmed'),computeUnits=1400000;
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:block2.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:computeUnits}),launch.instruction]}).compileToV0Message());tx.sign([payer,nft]);assert.ok(tx.serialize().length<=1232);
  const held={...base,operationId:'launch-lock',messageHash:createHash('sha256').update(tx.message.serialize()).digest('hex'),maximumLamports:String(rentLimit+10000)};
  const reviewedCost=await createStandardOperatingCostReader({connection:c,...base,feeOperator:m.pilotCreator})({binding:held,descriptor:{...base,computeUnits},packet:Buffer.from(tx.serialize()).toString('base64')});
  spend={binding:base,operationId:held.operationId,maximumLamports:held.maximumLamports,...reviewedCost,block:block2,signature:encodeBase58(tx.signatures[0]),transactionBase64:Buffer.from(tx.serialize()).toString('base64')};
  writeFileSync(join(directory,'lock-packet.json'),JSON.stringify(spend),{mode:0o600,flag:'wx'});
  assert.equal((await ledger.hold(held)).state,'held');assert.equal((await ledger.reconcile(held)).reason,'awaiting-finality');
  await c.sendRawTransaction(tx.serialize(),{maxRetries:2,preflightCommitment:'confirmed'});await finalized(spend.signature);
  const settled=await ledger.reconcile(held),actualRent=rents[82]+rents[165]*2+rents[256];assert.equal(settled.actualLamports,String(actualRent+10000));await ledger.reconcile(held);
  const balance=await ledger.balance(base);assert.equal(balance.heldLamports,'0');assert.equal(balance.availableLamports,String(20000000-actualRent-10000));
  const chain=createChainAdapter({connection:c,programId:m.programId,signer:payer,genesisHash:m.genesisHash,commitment:'finalized'}),verified=await chain.verifyLaunch(base);assert.equal(verified.ok,true,verified.failures.join('; '));assert.equal(String(verified.checks.liability),'1000000000');assert.equal(await c.getAccountInfo(launch.addresses.metadata,'finalized'),null);
  const report={network:'localnet',campaign:String(campaign),mint:String(mint),fundingSignature:funding.signature,spendSignature:spend.signature,packetBytes:tx.serialize().length,actualRentLamports:String(actualRent),actualNetworkFeeLamports:'10000',unusedMetadataAllowanceReleased:String(rents[679]),refundLiabilityLamports:String(verified.checks.liability),poolVerified:true,chainDerivedCostTemplate:true,workerActivation:false,...balance,directory};
  writeFileSync(join(directory,'report.json'),JSON.stringify(report),{mode:0o600,flag:'wx'});return report;
 }catch(e){log({event:'lock-qualification-failed',reason:String(e.message).slice(0,1000),directory});throw e;}
 finally{creator?.secretKey.fill(0);payer?.secretKey.fill(0);nft?.secretKey.fill(0);if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyOperatingLock({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,log:x=>console.log(JSON.stringify(x))}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
