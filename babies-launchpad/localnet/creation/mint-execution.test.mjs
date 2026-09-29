import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Keypair,PublicKey} from '@solana/web3.js';
import {MintLayout,AccountLayout} from '@solana/spl-token';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {campaignAddress,launchAuthority,TOKEN_PROGRAM} from '../protocol-v2/client.mjs';
import {METADATA_PROGRAM} from '../token-metadata.mjs';
import {createMintIntent,buildMintPacket} from './mint-packet.mjs';
import {verifyMintResult} from './mint-result.mjs';
import {createMintExecutor} from './mint-execution.mjs';
import {encodeBase58} from '../../shared/solana.mjs';

const address=()=>Keypair.generate().publicKey.toBase58();
function fixture(){
 const owner=Keypair.generate(),programId=address(),nonce='123',campaign=campaignAddress(programId,owner.publicKey,nonce).toBase58();
 const intent=createMintIntent({preparation:{programVersion:3,state:'reserved',fundingEnabled:false,requestId:randomUUID(),leaseId:randomUUID(),genesisHash:address(),programId,nonce,campaign,authority:launchAuthority(programId,campaign).toBase58(),mint:'7e2g1HXJQPCMLED6PQZhHwzYw9iGemwPuUc5FAFMkids'},creator:owner.publicKey.toBase58(),metadata:{name:'Local coin',symbol:'LocalCoin',uri:'https://kids.fun/rehearsal/metadata.json',documentHash:'a'.repeat(64)},rentLamports:'1461600'});
 const mint=Buffer.alloc(82),custody=Buffer.alloc(165),zero=PublicKey.default;
 MintLayout.encode({mintAuthorityOption:0,mintAuthority:zero,supply:BigInt(intent.supply),decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:zero},mint);
 AccountLayout.encode({mint:new PublicKey(intent.mint),owner:new PublicKey(intent.authority),amount:BigInt(intent.supply),delegateOption:0,delegate:zero,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:zero},custody);
 const str=s=>{const value=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(value.length);return Buffer.concat([n,value]);};
 const metadata=Buffer.concat([Buffer.from([4]),owner.publicKey.toBuffer(),new PublicKey(intent.mint).toBuffer(),str(intent.metadata.name),str(intent.metadata.symbol),str(intent.metadata.uri),Buffer.alloc(5)]);
 const account=(data,owner)=>({data,owner,executable:false,lamports:2000000});
 return {intent,owner,response:{context:{slot:101},value:[account(mint,TOKEN_PROGRAM),account(custody,TOKEN_PROGRAM),account(metadata,METADATA_PROGRAM)]}};
}
test('mint evidence requires finalized context, exact revoked mint, full custody and immutable metadata',()=>{
 const {intent,response}=fixture();const evidence=verifyMintResult(intent,response,{minSlot:100});
 assert.equal(evidence.supply,intent.supply);assert.equal(evidence.immutableMetadata,true);
 for(const mutate of [r=>r.value[0].data.writeUInt32LE(1,0),r=>r.value[0].data.writeUInt32LE(1,46),r=>r.value[0].data.writeBigUInt64LE(1n,36),r=>r.value[0].data[44]=9,r=>r.value[1].data.writeBigUInt64LE(1n,64),r=>r.value[1].data.writeUInt32LE(1,72),r=>r.value[1].data[108]=2,r=>r.value[1].data.writeUInt32LE(1,129),r=>r.value[1].data[32]^=1,r=>r.value[2].data[1]^=1,r=>r.value[2].data[r.value[2].data.length-1]=1,r=>r.value[2].owner=TOKEN_PROGRAM,r=>r.value[0].data=Buffer.concat([r.value[0].data,Buffer.alloc(100)]),r=>r.value[2].data=r.value[2].data.subarray(0,80)]){
  const copy={context:{...response.context},value:response.value.map(a=>({...a,data:Buffer.from(a.data)}))};mutate(copy);
  assert.throws(()=>verifyMintResult(intent,copy,{minSlot:100}),{code:'MINT_RESULT_MISMATCH'});
 }
 for(const other of [{...response,context:{slot:99}},{...response,value:[null,...response.value.slice(1)]}])assert.throws(()=>verifyMintResult(intent,other,{minSlot:100}),{code:'MINT_RESULT_UNAVAILABLE'});
});

const url=process.env.KIDS_TEST_POSTGRES_URL;
test('mint executor resumes stored transactions across failures without a replacement', {skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});
  const registry=new PostgresRegistry({pool});await registry.migrate();
  async function setup(){
   const {intent,owner,response}=fixture(),operationId=canonicalHash(intent),block={blockhash:address(),lastValidBlockHeight:150,observedSlot:50};
   const tx=buildMintPacket(intent,block);tx.sign([owner]);const creatorPacket=Buffer.from(tx.serialize()).toString('base64');
   // Synthetic signer boundary for orchestration tests only. Real two-signature
   // validation is exercised by mint-approval and the opt-in inventory rehearsal.
   const signature=encodeBase58(tx.signatures[0]);tx.signatures[1].fill(1);const signedBase64=Buffer.from(tx.serialize()).toString('base64');
   await registry.operatorPackets.prepare({operationId,descriptor:JSON.stringify(intent),prepared:{block,creatorPacket}});
   await registry.operatorPackets.sign({operationId,attempt:1,signedBase64,signature});
   const lease={state:'signed-pending',signature};let consumes=0,sends=[],status=null,height=100,genesis=intent.genesisHash,failSend=false,failRead=false,waitRead=false;
   const connection={rpcEndpoint:'http://127.0.0.1:19199',getGenesisHash:async()=>genesis,getFirstAvailableBlock:async()=>1,getSignatureStatuses:async()=>{if(failRead)throw Error('private provider detail');if(waitRead)return new Promise(()=>{});return {context:{slot:110},value:[status]};},getEpochInfo:async()=>({blockHeight:height,absoluteSlot:110}),sendRawTransaction:async bytes=>{sends.push(Buffer.from(bytes).toString('base64'));if(failSend)throw Error('lost response');return signature;},getMultipleAccountsInfoAndContext:async(keys,options)=>{assert.equal(keys.length,3);assert.equal(options.commitment,'finalized');assert.equal(options.minContextSlot,100);return response;}};
   const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:connection.rpcEndpoint,genesisHash:intent.genesisHash,programId:intent.programId,pilotCreator:intent.creator};
   const approvals={read:async()=>registry.operatorPackets.latest(operationId)},mintLeases={markConsumed:async()=>{consumes++;lease.state='consumed';return {outcome:'consumed'};}};
   const executionRegistry={driver:'postgres',operatorPackets:registry.operatorPackets,mintLeases:{get:async()=>lease}};
   const open=extra=>createMintExecutor({registry:executionRegistry,approvals,mintLeases,connection,config,loadIntent:async()=>intent,...extra});
   return {intent,response,operationId,signature,signedBase64,lease,connection,config,open,get sends(){return sends;},get consumes(){return consumes;},set status(v){status=v;},set height(v){height=v;},set genesis(v){genesis=v;},set failSend(v){failSend=v;},set failRead(v){failRead=v;},set waitRead(v){waitRead=v;}};
  }
  await t.test('lost response is pending; a fresh replica finalizes without resending',async()=>{
   const f=await setup();f.failSend=true;
   assert.equal((await f.open().resume(f.intent.requestId)).reason,'submission-unresolved');assert.deepEqual(f.sends,[f.signedBase64]);assert.equal(f.consumes,0);
   f.status={confirmationStatus:'confirmed',slot:100,err:null};assert.equal((await f.open().resume(f.intent.requestId)).reason,'awaiting-finality');assert.equal(f.sends.length,1);
   f.status={confirmationStatus:'finalized',slot:100,err:null};const result=await f.open().resume(f.intent.requestId);assert.equal(result.status,'minted');assert.equal(f.lease.state,'consumed');assert.equal(f.sends.length,1);
   f.failRead=true;assert.equal((await f.open().resume(f.intent.requestId)).status,'minted');assert.equal((await registry.operatorPackets.latest(f.operationId)).result.mintEvidence.immutableMetadata,true);
  });
  await t.test('rebroadcast uses identical bytes and never refreshes the blockhash',async()=>{
   const f=await setup();assert.equal((await f.open().resume(f.intent.requestId)).reason,'submitted');assert.equal((await f.open().resume(f.intent.requestId)).reason,'submitted');assert.deepEqual(f.sends,[f.signedBase64,f.signedBase64]);
  });
  await t.test('provider failure, bounded timeout, changed ledger and cancellation send nothing',async()=>{
   const f=await setup();f.failRead=true;assert.equal((await f.open().resume(f.intent.requestId)).reason,'confirmation-unavailable');
   f.failRead=false;f.waitRead=true;assert.equal((await f.open({timeoutMs:15}).resume(f.intent.requestId)).reason,'confirmation-unavailable');
   f.waitRead=false;f.genesis=address();assert.equal((await f.open().resume(f.intent.requestId)).reason,'network-unavailable');
   f.genesis=f.intent.genesisHash;assert.equal((await f.open().resume(f.intent.requestId,{signal:AbortSignal.abort()})).status,'pending');assert.equal(f.sends.length,0);assert.equal(f.consumes,0);
  });
  await t.test('finalized expiry/failure stops without replacing or consuming the mint',async()=>{
   for(const kind of ['expired','failed']){const f=await setup();if(kind==='expired')f.height=151;else f.status={confirmationStatus:'finalized',slot:100,err:{InstructionError:[1,'Custom']}};
    assert.equal((await f.open().resume(f.intent.requestId)).reason,kind);assert.equal((await registry.operatorPackets.latest(f.operationId)).status,kind);assert.equal(f.sends.length,0);assert.equal(f.consumes,0);
   }
  });
  await t.test('unknown or mismatching finalized accounts never mark the mint usable',async()=>{
   const f=await setup();f.status={confirmationStatus:'finalized',slot:100,err:null};f.response.context.slot=99;assert.equal((await f.open().resume(f.intent.requestId)).reason,'finalized-evidence-unavailable');
   f.response.context.slot=101;f.response.value[0].data.writeUInt32LE(1,0);assert.equal((await f.open().resume(f.intent.requestId)).reason,'account-mismatch');assert.equal(f.consumes,0);assert.equal(f.sends.length,0);
  });
  await t.test('restart after finalized journal write completes lease consumption',async()=>{
   const f=await setup();f.status={confirmationStatus:'finalized',slot:100,err:null};
   await assert.rejects(f.open({checkpoint:async()=>{throw Error('synthetic crash');}}).resume(f.intent.requestId),/synthetic crash/);assert.equal(f.consumes,0);
   const results=await Promise.all(Array.from({length:8},()=>f.open().resume(f.intent.requestId)));assert.ok(results.every(r=>r.status==='minted'));assert.equal(f.sends.length,0);
  });
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
