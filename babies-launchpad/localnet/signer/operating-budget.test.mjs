import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash,createPrivateKey,sign} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {Keypair,PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {settleInstruction} from '../protocol-v2/client.mjs';
import {buildOperatingFundingPacket} from '../creation/operating-proofs.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
import {createOperatingSignerBudget} from './operating-budget.mjs';
import {createRegistrySignerService} from './registry-service.mjs';
import {readSignerKey} from './main.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=()=>Keypair.generate().publicKey.toBase58();
test('v3 signer holds shared campaign funding before signing and journals every released signature',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),dir=await mkdtemp(join(tmpdir(),'kids-budget-signer-'));let pool,service;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const payer=Keypair.generate(),creator=Keypair.generate(),base={genesisHash:key(),programId:key(),campaign:key(),payer:String(payer.publicKey),policy:'local-budget-test'};
  await registry.campaigns.upsert({...base,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  const grant=await registry.capabilities.grant({...base,programVersion:3,tags:[4],expiresAt:new Date(Date.now()+60000).toISOString()}),job=(await registry.jobs.enqueue({...base,jobClass:'settlement',operationKey:'settle'})).job;
  await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'local-test',ttlMs:30000});
  const block={blockhash:key(),lastValidBlockHeight:100,observedSlot:50},fundingTerms={...base,creator:String(creator.publicKey),lamports:'10000'},fundingTx=buildOperatingFundingPacket(fundingTerms,block);fundingTx.sign([creator]);
  const funding={binding:fundingTerms,block,signature:encodeBase58(fundingTx.signatures[0]),transactionBase64:Buffer.from(fundingTx.serialize()).toString('base64')},transactions=new Map();
  function landed(tx,pre,post,fee){return {slot:20,transaction:{message:tx.message,signatures:tx.signatures.map(encodeBase58)},meta:{err:null,preBalances:pre,postBalances:post,fee}};}
  const pre=fundingTx.message.staticAccountKeys.map(()=>0),post=pre.slice();pre[0]=20000;post[0]=5000;post[fundingTx.message.staticAccountKeys.findIndex(k=>k.equals(payer.publicKey))]=10000;transactions.set(funding.signature,landed(fundingTx,pre,post,5000));
  let height=50,lookupFailure=false;const order=[];
  const connection={getGenesisHash:async()=>base.genesisHash,getBlockHeight:async()=>height,getEpochInfo:async()=>({blockHeight:height,absoluteSlot:height+10}),getFirstAvailableBlock:async()=>1,getSignatureStatuses:async()=>({context:{slot:height+10},value:[null]}),getTransaction:async signature=>{if(lookupFailure)throw Error('RPC outage');return transactions.get(signature)??null;}};
  const buildBudget=()=>createOperatingSignerBudget({registry,connection,...base,loadFundingPacket:async()=>funding,loadCostIntent:async()=>({costModel:'network-fee-only'})});
  let budget=buildBudget(),persistFailure=null;const actualReserve=async x=>{order.push('reserve');return budget.reserve(x);},actualRecord=async(...x)=>{order.push('persist');if(persistFailure==='refused')throw Object.assign(Error('Operating signature does not match the held packet'),{code:'OPERATING_SIGNATURE_REFUSED'});if(persistFailure==='dependency')throw Object.assign(Error('read failed'),{dependency:'failure'});if(persistFailure==='before')throw Error('Storage unavailable');await budget.recordSignature(...x);if(persistFailure==='after')throw Error('Lost storage acknowledgement');};
  const lease=registry.capabilities.authorizeLease.bind(registry.capabilities);registry.capabilities.authorizeLease=async x=>{order.push('lease');return lease(x);};
  const token='synthetic-operating-budget-signer-token',logs=[];
  // The service signs with a key loaded from a file exactly as the hosted signer does; its signatures must verify against the payer.
  const keyFile=join(dir,'signer-key.json');writeFileSync(keyFile,JSON.stringify(Array.from(payer.secretKey)),{mode:0o600});
  service=await createRegistrySignerService({admitRpc:async()=>{},registry,connection,...base,programVersion:3,keypair:readSignerKey(keyFile),token,stateFile:join(dir,'state.json'),operatingBudget:{reserve:actualReserve,recordSignature:actualRecord},log:e=>logs.push(e)});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const postSign=body=>fetch('http://127.0.0.1:'+service.server.address().port+'/sign',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  async function prepare(n){
   const packetBlock={...block,blockhash:key()};
   const stable='settle:'+n,op=canonicalHash({genesisHash:base.genesisHash,programId:base.programId,campaign:base.campaign,operationId:stable});
   const ix=settleInstruction(base.programId,base.campaign,creator.publicKey),message=new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:packetBlock.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:60000}),ix]}).compileToV0Message(),tx=new VersionedTransaction(message);
   const descriptor=canonicalJson({...base,operationId:stable,operationKey:'settle',computeUnits:60000,intent:null});
   await registry.operatorPackets.prepare({operationId:op,descriptor,prepared:{base64:Buffer.from(tx.serialize()).toString('base64'),...packetBlock,facts:{}}});
   const messageBase64=Buffer.from(message.serialize()).toString('base64'),operationId='op:'+canonicalHash({operation:op,attempt:1,message:messageBase64});
   const input={message:messageBase64,operationId,campaign:base.campaign,operationKey:'settle',fencingToken:1,packetRef:{operationId:op,attempt:1}},binding={...base,operationId,messageHash:createHash('sha256').update(message.serialize()).digest('hex'),maximumLamports:'5000'};
   return {input,binding,tx};
  }
  const a=await prepare(1),b=await prepare(2),c=await prepare(3);
  await t.test('unfunded, altered and foreign journal references cannot obtain signatures',async()=>{
   const unfunded=await postSign(a.input);assert.equal(unfunded.status,409);const refusal=await unfunded.json();assert.equal(refusal.category,'operating-funding-wait');assert.equal(refusal.signature,undefined);assert.equal((await budget.balance(base)).heldLamports,'0');
   await budget.credit({...base,signature:funding.signature});
   // Deterministic packet, reference and scope mismatches are typed refusals (409 signer-packet-refused), never an unresolved retry.
   for(const change of [{packetRef:null},{packetRef:{...a.input.packetRef,attempt:2}},{operationId:'different-id'},{operationKey:'other'}]){const r=await postSign({...a.input,...change});assert.equal(r.status,409,JSON.stringify(change));assert.equal((await r.json()).category,'signer-packet-refused');}
   assert.equal((await budget.balance(base)).heldLamports,'0');
  });
  let signatureA;
  await t.test('reserve precedes final lease, signature persistence precedes response, duplicate holds do not spend twice',async()=>{
   persistFailure='refused';const typed=await postSign(a.input);assert.equal(typed.status,409,'a deterministic refusal before any write is typed, not an unresolved retry');const typedBody=await typed.json();assert.equal(typedBody.category,'signer-persistence-refused');assert.equal(typedBody.signature,undefined);assert.match(typedBody.error,/signature-mismatch/);
   assert.equal((await budget.balance(base)).heldLamports,'5000');assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM operator_packets WHERE signed_base64 IS NOT NULL')).rows[0].n),0);
   const refusedLog=logs.find(e=>e.event==='signer-persistence-failed');assert.equal(refusedLog?.stage,'refused-before-persist');assert.equal(refusedLog?.cause,'signature-mismatch');
   persistFailure='dependency';const dep=await postSign(a.input);assert.equal(dep.status,503,'a tagged dependency failure stays unresolved');assert.equal((await dep.json()).category,'signer-persistence-unresolved');assert.equal(logs.filter(e=>e.event==='signer-persistence-failed').at(-1)?.cause,'dependency-failure');
   for(const when of ['before','after']){
    persistFailure=when;const refused=await postSign(a.input);assert.equal(refused.status,503);const body=await refused.json();assert.equal(body.signature,undefined,'No signature returned on unresolved persistence');assert.equal(body.category,'signer-persistence-unresolved');assert.equal((await budget.balance(base)).heldLamports,'5000');
    assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM operator_packets WHERE signed_base64 IS NOT NULL')).rows[0].n),when==='before'?0:1);
   }
   const unresolvedLogs=logs.filter(e=>e.event==='signer-persistence-failed'&&e.stage==='unresolved');assert.deepEqual(unresolvedLogs.map(e=>e.cause),['dependency-failure','unknown','unknown']);
   assert.ok(!JSON.stringify(logs).includes('Storage unavailable')&&!JSON.stringify(logs).includes('acknowledgement'),'diagnostics carry classes, never error text');
   persistFailure=null;
   order.length=0;const response=await postSign(a.input);assert.equal(response.status,200);signatureA=(await response.json()).signature;assert.deepEqual(order,['reserve','lease','persist']);
   a.tx.addSignature(payer.publicKey,Buffer.from(signatureA,'base64'));assert.equal((await budget.balance(base)).heldLamports,'5000');
   assert.equal((await postSign(a.input)).status,200);assert.equal((await budget.balance(base)).heldLamports,'5000');
   // A signature by another key over the same held packet is a typed refusal from the real budget and changes nothing.
   const heldA={state:'held',binding:a.binding,budgetPacketId:canonicalHash({role:'v3-operating-budget',genesisHash:base.genesisHash,programId:base.programId,campaign:base.campaign,payer:base.payer,operationId:a.binding.operationId})},foreignKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(creator.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'}),foreignSignature=sign(null,Buffer.from(a.tx.message.serialize()),foreignKey);
   await assert.rejects(budget.recordSignature(heldA,Buffer.from(foreignSignature).toString('base64')),e=>e.code==='OPERATING_SIGNATURE_REFUSED'&&/does not match/.test(e.message));
   // A registry read that rejects with a string or a frozen error is a dependency outcome, never a typed refusal.
   // A registry read that rejects with an error, a string or a frozen error, or that hangs past the bound, is a dependency outcome, never a typed refusal.
   for(const [latest,kind] of [[async()=>{throw Error('read failed');},'failure'],[async()=>{throw 'connection reset';},'failure'],[async()=>{throw Object.freeze(Error('read failed'));},'failure'],[()=>new Promise(()=>{}),'timeout']]){
    const broken=new Proxy(registry,{get(target,k){if(k==='operatorPackets')return {...target.operatorPackets,latest};const v=target[k];return typeof v==='function'?v.bind(target):v;}});
    const flaky=createOperatingSignerBudget({registry:broken,connection,...base,loadFundingPacket:async()=>funding,loadCostIntent:async()=>({costModel:'network-fee-only'}),timeoutMs:kind==='timeout'?10:10000});
    await assert.rejects(flaky.recordSignature(heldA,signatureA),e=>e.dependency===kind&&e.code!=='OPERATING_SIGNATURE_REFUSED');
   }
   const signed=(await registry.query("SELECT * FROM operator_packets WHERE signed_base64 IS NOT NULL")).rows;assert.equal(signed.length,1);assert.equal(signed[0].signed_base64,Buffer.from(a.tx.serialize()).toString('base64'));
  });
  await t.test('two competing packets can reserve only the remaining campaign funding',async()=>{
   const responses=await Promise.all([postSign(b.input),postSign(c.input)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal((await budget.balance(base)).heldLamports,'10000');
  });
  await t.test('restart and ambiguous RPC keep the full hold; finalized evidence charges once',async()=>{
   budget=buildBudget();assert.equal((await budget.reconcile(a.binding)).reason,'awaiting-finality');lookupFailure=true;await assert.rejects(budget.reconcile(a.binding));lookupFailure=false;assert.equal((await budget.balance(base)).heldLamports,'10000');
   const pre=a.tx.message.staticAccountKeys.map(()=>0),post=pre.slice();pre[0]=20000;post[0]=15000;transactions.set(encodeBase58(a.tx.signatures[0]),landed(a.tx,pre,post,5000));
   const results=await Promise.all([budget.reconcile(a.binding),budget.reconcile(a.binding)]);assert.ok(results.every(r=>r.actualLamports==='5000'));assert.equal((await budget.balance(base)).spentLamports,'5000');assert.equal((await budget.balance(base)).heldLamports,'5000');
   assert.equal((await postSign(a.input)).status,409,'settled packets cannot obtain a new approval');
   const terminal=(await registry.query("SELECT status FROM operator_packets WHERE signed_base64 IS NOT NULL AND signature=?",[encodeBase58(a.tx.signatures[0])])).rows;assert.deepEqual(terminal.map(x=>x.status),['finalized'],'Accounting shadow follows verified chain finality');
  });
  await t.test('signed expiry releases only after finalized history; unsigned expiry cannot race a signature out',async()=>{
   height=101;for(const entry of [b,c]){try{await budget.reconcile(entry.binding);}catch(e){if(!/differs from its bound intent/.test(e.message))throw e;}}
   assert.equal((await budget.balance(base)).heldLamports,'0');height=50;
   const d=await prepare(4);await registry.jobs.requeue({jobId:job.jobId,token:1,result:{}});
   assert.equal((await postSign(d.input)).status,409,'lease loss after holding signs nothing');assert.equal((await budget.balance(base)).heldLamports,'5000');
   assert.equal((await budget.reconcile(d.binding)).reason,'awaiting-finality');height=101;
   assert.equal((await budget.reconcile(d.binding)).actualLamports,'0');assert.equal((await budget.balance(base)).heldLamports,'0');
   d.tx.sign([payer]);await assert.rejects(budget.recordSignature({state:'held',binding:d.binding,budgetPacketId:canonicalHash({role:'v3-operating-budget',genesisHash:base.genesisHash,programId:base.programId,campaign:base.campaign,payer:base.payer,operationId:d.binding.operationId})},Buffer.from(d.tx.signatures[0]).toString('base64')),e=>e.code==='OPERATING_SIGNATURE_REFUSED'&&/expiry/.test(e.message));
  });
 }finally{if(service?.server.listening)await service.close();if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();await rm(dir,{recursive:true,force:true});}
});
