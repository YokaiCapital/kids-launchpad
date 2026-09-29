import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';
import pg from 'pg';import {Keypair,PublicKey,VersionedTransaction,Transaction,SystemProgram} from '@solana/web3.js';
import * as c from '../protocol-v2/client.mjs';import * as policy from '../protocol-v2/policy.mjs';import {PostgresRegistry} from '../registry/registry.mjs';
import {createPublicWalletService} from '../protocol-v2/public-wallet.mjs';import {createPublicTradeService} from './public-trade.mjs';import {decodeApprovedTrade} from '../../interaction-review/src/trade-signing.mjs';import {discriminator} from '../cpmm.mjs';import {encodeBase58} from '../../shared/solana.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
async function fixture(fn){
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
 const wallet=Keypair.generate(),wrap=Keypair.generate(),program=Keypair.generate().publicKey,genesis=Keypair.generate().publicKey,mint=Keypair.generate().publicKey;
 const vector=JSON.parse(readFileSync(new URL('../protocol-v2/test-vectors.json',import.meta.url))).termsHash.find(v=>v.name==='standard').terms;
 const tier=c.AMM_CONFIG_TIERS[1],t={...vector,genesis:c.keyHex(genesis),creator:c.keyHex(wallet.publicKey),dev:c.keyHex(wallet.publicKey),childMint:c.keyHex(mint),ammProgram:c.keyHex(c.RAYDIUM_CPMM),ammConfig:c.keyHex(tier.address),ammTradeFeeRate:String(tier.tradeFeeRate),ammConfigIndex:tier.index,creatorFeeEnabled:0};
 const campaign=c.campaignAddress(program,wallet.publicKey,t.nonce),a=c.cpmmAddresses(c.RAYDIUM_CPMM,tier.address,mint),data=Buffer.alloc(c.CAMPAIGN_LEN);c.CAMPAIGN_MAGIC.copy(data);policy.encodeTerms(t).copy(data,8);policy.termsHash(data.subarray(8,808)).copy(data,808);data[840]=3;a.pool.toBuffer().copy(data,928);
 const owned=(owner,data)=>({owner,data,lamports:9999999,executable:false});
 const token=(mint,owner,amount)=>{const d=Buffer.alloc(165);mint.toBuffer().copy(d);owner.toBuffer().copy(d,32);d.writeBigUInt64LE(amount,64);d[108]=1;return owned(c.TOKEN_PROGRAM,d);};
 const poolData=Buffer.alloc(637);discriminator('account:PoolState').copy(poolData);for(const[i,k]of [tier.address,c.launchAuthority(program,campaign),a.vault0,a.vault1,a.lpMint,a.mint0,a.mint1,c.TOKEN_PROGRAM,c.TOKEN_PROGRAM,a.observation].entries())k.toBuffer().copy(poolData,8+32*i);
 const config=Buffer.alloc(236);discriminator('account:AmmConfig').copy(config);config.writeUInt16LE(tier.index,10);config.writeBigUInt64LE(tier.tradeFeeRate,12);config.writeBigUInt64LE(120000n,20);config.writeBigUInt64LE(40000n,28);config.writeBigUInt64LE(500n,108);
 const mintData=Buffer.alloc(82);mintData.writeBigUInt64LE(BigInt(t.supply),36);mintData[44]=t.decimals;mintData[45]=1;
 const clock=Buffer.alloc(40);clock.writeBigInt64LE(500n,32);
 const infos=[owned(c.RAYDIUM_CPMM,poolData),owned(c.RAYDIUM_CPMM,config),token(a.mint0,a.authority,a.mint0.equals(c.WSOL)?100000000000n:500000000000000n),token(a.mint1,a.authority,a.mint1.equals(c.WSOL)?100000000000n:500000000000000n),owned(c.TOKEN_PROGRAM,mintData),token(mint,wallet.publicKey,1000000000n),null,{data:clock}];
 const row={genesisHash:String(genesis),programId:String(program),campaign:String(campaign),campaignVersion:3,mode:'standard',registryStatus:'active',termsHash:c.decodeCampaign(data).state.termsHash};await registry.campaigns.upsert(row);const id=[row.genesisHash,row.programId,row.campaign].join(':'),owner=String(wallet.publicKey);let now=Date.now(),sendError=false,status=null,reads=0,sends=0;
 const rpc={getGenesisHash:async()=>String(genesis),getAccountInfoAndContext:async()=>({context:{slot:10},value:owned(program,data)}),getMultipleAccountsInfoAndContext:async()=>{reads++;return {context:{slot:11},value:infos};},getMinimumBalanceForRentExemption:async()=>2039280,getLatestBlockhash:async()=>({blockhash:String(Keypair.generate().publicKey),lastValidBlockHeight:100}),getFeeForMessage:async()=>({value:10000}),getBalance:async()=>10000000000,getSignatureStatuses:async()=>({value:[status]}),getBlockHeight:async()=>10,getFirstAvailableBlock:async()=>1,sendRawTransaction:async wire=>{sends++;const tx=VersionedTransaction.deserialize(wire),signature=encodeBase58(tx.signatures[0]);assert.equal((await registry.walletPackets.list(owner))[0].signature,signature,'packet durable before broadcast');if(sendError)throw Error('Lost acknowledgement');return signature;}};
 const walletService=createPublicWalletService({registry,connection:rpc,genesisHash:String(genesis),programIds:[String(program)],programVersion:3,enabled:true});let admission=0;
 const build=()=>createPublicTradeService({registry,connection:rpc,genesisHash:String(genesis),programId:String(program),walletService,enabled:true,admit:async({cost})=>{admission+=cost;},now:()=>now});
 const request={campaignId:id,side:'buy',amountRaw:'100000000',slippageBps:1000,requestId:'trade-fixture',wrappedAccount:String(wrap.publicKey)};
 await fn({registry,row,rpc,data,infos,owner,wallet,wrap,request,build,get reads(){return reads;},get sends(){return sends;},get admission(){return admission;},setNow:v=>now=v,setError:v=>sendError=v,setStatus:v=>status=v});
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
test('per-campaign buy/sell reuses approved packets and retains exact signed outcomes through a lost acknowledgement',{skip:!url},()=>fixture(async f=>{
 const s=f.build();for(const side of ['buy','sell']){
  const input={...f.request,side,requestId:side},q=await s.prepare(f.owner,input);assert.equal(q.tradeFeeRate,'25000');assert.equal(q.minOutputRaw,String(BigInt(q.outputRaw)*9000n/10000n));assert.ok(f.admission>0);
  const tx=decodeApprovedTrade(Buffer.from(q.unsignedTransactionBase64,'base64'),q,q);tx.sign([f.wallet,f.wrap]);
  const replay=await s.prepare(f.owner,input);assert.equal(replay.intentId,q.intentId);assert.equal(replay.unsignedTransactionBase64,q.unsignedTransactionBase64);
  f.setError(true);const result=await s.submit(f.owner,{intentId:q.intentId,signedTransactionBase64:Buffer.from(tx.serialize()).toString('base64')});assert.equal(result.status,'unknown');assert.ok(result.signature);
  const sent=f.sends,recovered=await f.build().resume(f.owner,{intentId:q.intentId});assert.equal(recovered.signature,result.signature);assert.equal(f.sends,sent+1,'restart rebroadcasts only the stored packet');
  f.setStatus({confirmationStatus:'finalized',err:null});assert.equal((await f.build().status(f.owner,{intentId:q.intentId})).status,'finalized');f.setStatus(null);
 }
}));
test('quote identity, reserves, authority and account mutation fail before a packet or broadcast',{skip:!url},()=>fixture(async f=>{
 const s=f.build();for(const mutate of [()=>{f.data[840]=0;return()=>f.data[840]=3;},()=>{f.infos[4].data.writeUInt32LE(1,46);return()=>f.infos[4].data.writeUInt32LE(0,46);},()=>{f.infos[1].data.writeBigUInt64LE(20000n,12);return()=>f.infos[1].data.writeBigUInt64LE(25000n,12);},()=>{f.infos[6]={};return()=>f.infos[6]=null;},()=>{f.infos[0].data[329]=4;return()=>f.infos[0].data[329]=0;}]){const restore=mutate();await assert.rejects(s.prepare(f.owner,f.request));restore();}
 await assert.rejects(s.prepare(f.owner,{...f.request,side:'sell',amountRaw:'2000000000'}),/Insufficient coin/);assert.equal((await f.registry.walletPackets.list(f.owner)).length,0);assert.equal(f.sends,0);
}));
test('another owner, altered terms, extra transfers, missing signatures and expired quotes cannot send',{skip:!url},()=>fixture(async f=>{
 const s=f.build(),q=await s.prepare(f.owner,f.request);
 await assert.rejects(s.prepare(f.owner,{...f.request,amountRaw:'2'}),/another trade/);
 await assert.rejects(s.status(String(Keypair.generate().publicKey),{intentId:q.intentId}),/not found/);
 await assert.rejects(s.resume(String(Keypair.generate().publicKey),{intentId:q.intentId}),/not found/);
 assert.equal((await s.resume(f.owner,{intentId:q.intentId})).status,'prepared');assert.equal(f.sends,0,'unsigned approval is never sent');
 const tx=Transaction.from(Buffer.from(q.unsignedTransactionBase64,'base64'));tx.add(SystemProgram.transfer({fromPubkey:f.wallet.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));tx.sign(f.wallet,f.wrap);await assert.rejects(s.submit(f.owner,{intentId:q.intentId,signedTransactionBase64:tx.serialize().toString('base64')}));
 const original=VersionedTransaction.deserialize(Buffer.from(q.unsignedTransactionBase64,'base64'));original.sign([f.wallet]);await assert.rejects(s.submit(f.owner,{intentId:q.intentId,signedTransactionBase64:Buffer.from(original.serialize()).toString('base64')}),/must sign/);
 original.sign([f.wrap]);f.setNow(q.expiresAt);await assert.rejects(s.submit(f.owner,{intentId:q.intentId,signedTransactionBase64:Buffer.from(original.serialize()).toString('base64')}),/expired/);assert.equal(f.sends,0);
 assert.equal((await s.cancel(f.owner,{intentId:q.intentId})).status,'cancelled');
}));
