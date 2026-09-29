// Explicit local-only qualification using a previously verified mint intent.
// No new mint, production key, cloud provider or public API is used here.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import pg from 'pg';
import {Connection,Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {readPresets,presetTerms,presetsHash} from '../registry/presets.mjs';
import {AMM_CONFIG_TIERS} from '../protocol-v2/client.mjs';
import {createProvisionIntent,reviewedProvisionPolicy,buildProvisionPacket,provisionIntentHash} from './provision-packet.mjs';
import {createProvisionRegistrar} from './provision-registration.mjs';
import {createProvisionExecutor} from './provision-execution.mjs';
import {mintResultAddresses,verifyMintResult} from './mint-result.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function qualifyProvisioning({mintIntentPath,postgresUrl,log=()=>{}}){
 if(!postgresUrl||!mintIntentPath)throw Error('Explicit test PostgreSQL and previous local mint intent required');
 const manifest=JSON.parse(readFileSync(fileURLToPath(new URL('../.runtime/kids-launch-v3-program.json',import.meta.url)),'utf8'));
 if(manifest.network!=='localnet'||manifest.programVersion!==3||!/^http:\/\/127\.0\.0\.1:\d+$/.test(manifest.rpcUrl))throw Error('Local v3 rehearsal manifest required');
 const connection=new Connection(manifest.rpcUrl,'confirmed'),mint=JSON.parse(readFileSync(mintIntentPath,'utf8'));
 if(await connection.getGenesisHash()!==manifest.genesisHash||mint.genesisHash!==manifest.genesisHash||mint.programId!==manifest.programId||mint.creator!==manifest.pilotCreator)throw Error('Mint does not belong to this isolated pilot');
 if(await connection.getAccountInfo(new PublicKey(mint.campaign),'finalized'))throw Error('Qualification campaign already exists; never reuse a funded launch');
 verifyMintResult(mint,await connection.getMultipleAccountsInfoAndContext(mintResultAddresses(mint),'finalized'),{minSlot:0});
 const creator=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(manifest.adminKeyFile,'utf8'))));
 if(creator.publicKey.toBase58()!==mint.creator)throw Error('Local pilot signer mismatch');
 const manifestPolicy=readPresets(),tier=AMM_CONFIG_TIERS[0];manifestPolicy.agreed.feePolicy={...manifestPolicy.agreed.feePolicy,ammConfig:tier.address.toBase58(),ammConfigIndex:2,tradeFeeBps:200};
 const clock=(await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'finalized')).data.readBigInt64LE(32);
 const quote={terms:presetTerms(manifestPolicy,{mode:'standard',capPresetId:'default'}).terms,policyHash:presetsHash(manifestPolicy),planHash:'a'.repeat(64)};
 // Explicit synthetic setup reserve, not an all-in cost quote or a live default.
 const intent=createProvisionIntent({mint,policy:reviewedProvisionPolicy(quote),treasury:manifest.treasury,opensAt:String(clock+180n),authorityBudgetLamports:'300000000'});
 const directory=mkdtempSync(join(tmpdir(),'kids-provision-qualification-'));writeFileSync(join(directory,'intent.json'),JSON.stringify(intent,null,2),{mode:0o600});
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:postgresUrl,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:manifest.rpcUrl,genesisHash:mint.genesisHash,programId:mint.programId,pilotCreator:mint.creator,treasury:manifest.treasury};
  const open=extra=>createProvisionExecutor({registry,connection,config,loadIntent:async()=>intent,...extra});
  const reports=[];
  for(const stage of ['native-custody','create-campaign']){
   const block=await connection.getLatestBlockhash('confirmed'),tx=buildProvisionPacket(intent,stage,block);tx.sign([creator]);const creatorPacket=Buffer.from(tx.serialize()).toString('base64');
   const approved=await open().record(mint.requestId,{stage,block,creatorPacket});
   let crashed=false;
   const result=await open({checkpoint:async name=>{if(name==='broadcast'){crashed=true;throw Error('qualification post-broadcast interruption');}}}).resume(mint.requestId,stage).catch(error=>{if(error.message!=='qualification post-broadcast interruption')throw error;return null;});
   assert.ok(crashed||result?.reason==='submitted');
   let resumed;const until=Date.now()+90000;
   while(Date.now()<until){resumed=await open().resume(mint.requestId,stage);if(resumed.status==='complete')break;if(resumed.status==='attention')throw Error('Setup qualification needs attention: '+resumed.reason);await sleep(500);}
   assert.equal(resumed.status,'complete');assert.equal(resumed.signature,approved.signature);assert.equal(resumed.evidence.intentHash,provisionIntentHash(intent));
   assert.equal((await open().record(mint.requestId,{stage,block,creatorPacket})).signature,approved.signature);
   reports.push({stage,signature:resumed.signature,packetBytes:tx.serialize().length,postBroadcastRecovery:crashed});log(reports.at(-1));
  }
  const registrar=createProvisionRegistrar({registry,config,loadIntent:async()=>intent,executor:open()});
  const registered=await registrar.register(mint.creator,mint.requestId);assert.equal(registered.status,'registered');assert.equal(registered.workerActivation,false);assert.equal(await registry.campaigns.count(),1);
  const before=await connection.getBalance(new PublicKey(mint.authority),'finalized');
  // A new signature with the same create+fund instructions must fail creation;
  // the second instruction cannot transfer the reserve twice.
  const duplicate=buildProvisionPacket(intent,'create-campaign',await connection.getLatestBlockhash('confirmed'));duplicate.sign([creator]);
  const simulation=await connection.simulateTransaction(duplicate,{sigVerify:true,commitment:'confirmed'});assert.ok(simulation.value.err,'duplicate creation must fail atomically');assert.equal(await connection.getBalance(new PublicKey(mint.authority),'finalized'),before);
  assert.equal(before,300000000);assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM operator_packets')).rows[0].n),2);
  const report={network:'localnet',genesisHash:mint.genesisHash,programId:mint.programId,campaign:mint.campaign,mint:mint.mint,intentHash:provisionIntentHash(intent),authoritySetupLamports:String(before),steps:reports,duplicateCreateAtomic:true,privateRegistryVerified:true,scope:'creator-setup-and-private-registry-not-complete-operating-funding',directory};
  writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2),{mode:0o600});return report;
 }finally{creator.secretKey.fill(0);if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyProvisioning({mintIntentPath:process.env.KIDS_TEST_MINT_INTENT,postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,log:x=>console.log(JSON.stringify(x))}).then(report=>console.log(JSON.stringify(report))).catch(error=>{console.error(error.message);process.exitCode=1;});
