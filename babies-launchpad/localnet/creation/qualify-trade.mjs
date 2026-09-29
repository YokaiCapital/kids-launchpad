// Wallet-signed buy/sell against an existing owned v3 localnet qualification coin.
// Creates only a disposable registry schema. Never uses a hosted RPC or signer.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomUUID,createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';import pg from 'pg';
import {Connection,PublicKey,Keypair,VersionedTransaction} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';import {createAdmissionGuard} from '../jobs/admission.mjs';
import {boundedRpcFetch} from '../rpc-transport.mjs';
import * as client from '../protocol-v2/client.mjs';import {createPublicWalletService} from '../protocol-v2/public-wallet.mjs';import {createPublicTradeService} from '../protocol-v3/public-trade.mjs';import {decodeApprovedTrade} from '../../interaction-review/src/trade-signing.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function qualifyTrade({postgresUrl,campaign,log=()=>{}}){
 if(!postgresUrl||!campaign)throw Error('Explicit local test database and campaign required');
 const m=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v3-program.json',import.meta.url),'utf8'));
 if(m.network!=='localnet'||m.programVersion!==3||m.rpcUrl!=='http://127.0.0.1:19199')throw Error('Owned isolated validator required');
 const connection=new Connection(m.rpcUrl,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:boundedRpcFetch({timeoutMs:8000})});assert.equal(await connection.getGenesisHash(),m.genesisHash);
 const program=await connection.getAccountInfo(new PublicKey(m.programId),'finalized'),binary=await connection.getAccountInfo(new PublicKey(program.data.subarray(4,36)),'finalized');assert.equal(createHash('sha256').update(binary.data.subarray(45,45+m.binarySize)).digest('hex'),m.sha256);
 const account=await connection.getAccountInfo(new PublicKey(campaign),'finalized');assert.equal(String(account.owner),m.programId);const {terms,state}=client.decodeCampaign(account.data);assert.equal(state.phase,3);assert.equal(String(terms.creator),m.pilotCreator);
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1});let pool,wallet;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:postgresUrl,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  wallet=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(m.adminKeyFile,'utf8'))));assert.equal(String(wallet.publicKey),m.pilotCreator);
  const identity={genesisHash:m.genesisHash,programId:m.programId,campaign};await registry.campaigns.upsert({...identity,network:'localnet',mode:'standard',campaignVersion:3,registryStatus:'active',termsHash:state.termsHash});
  const walletService=createPublicWalletService({registry,connection,genesisHash:m.genesisHash,programIds:[m.programId],programVersion:3,enabled:false});
  const admit=createAdmissionGuard({registry,resource:'qualification-wallet-trade',lane:'wallet-trade',policy:{ratePerSecond:60,burst:60,lanes:{'wallet-trade':{ratePerSecond:60,burst:60}}}});
  const build=()=>createPublicTradeService({registry,connection,genesisHash:m.genesisHash,programId:m.programId,walletService,enabled:true,admit});let service=build(),bought=null;const signatures=[];
  for(const side of ['buy','sell']){
   const wrap=Keypair.generate();try{
    const input={campaignId:Object.values(identity).join(':'),requestId:randomUUID(),side,amountRaw:side==='buy'?'1000000':bought,slippageBps:1000,wrappedAccount:String(wrap.publicKey)};
    const quote=await service.prepare(m.pilotCreator,input),tx=decodeApprovedTrade(Buffer.from(quote.unsignedTransactionBase64,'base64'),quote,quote);tx.sign([wallet,wrap]);
    const wire=Buffer.from(tx.serialize()).toString('base64');let result=await service.submit(m.pilotCreator,{intentId:quote.intentId,signedTransactionBase64:wire});service=build();
    log({event:'trade-qualification-submitted',side,signature:result.signature,status:result.status});
    const deadline=Date.now()+600000;while(!['finalized','failed','expired'].includes(result.status)&&Date.now()<deadline){await pause(3000);result=await service.status(m.pilotCreator,{intentId:quote.intentId});}
    assert.equal(result.status,'finalized',`${side} outcome ${result.status}; signature ${result.signature??'unavailable'}. Inspect this signature before another rehearsal; a timeout is not proof of failure.`);assert.ok(result.signature);assert.equal((await service.prepare(m.pilotCreator,input)).signature,result.signature);
    assert.equal(await connection.getAccountInfo(wrap.publicKey,'finalized'),null,'temporary WSOL rent returned and account closed');
    if(side==='buy')bought=quote.minOutputRaw;signatures.push({side,signature:result.signature,inputRaw:quote.inputRaw,minOutputRaw:quote.minOutputRaw,tradeFeeRate:quote.tradeFeeRate});
    log({event:'trade-qualification-finalized',side,signature:result.signature});
   }finally{wrap.secretKey.fill(0);}
  }
  return {network:'localnet',campaign,mint:String(terms.childMint),walletSigned:true,serviceRestart:true,temporaryAccountsClosed:true,signatures,hostedActivation:false};
 }finally{wallet?.secretKey.fill(0);if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyTrade({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,campaign:process.argv[2],log:e=>console.log(JSON.stringify(e))}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(String(e.message));process.exitCode=1;});
