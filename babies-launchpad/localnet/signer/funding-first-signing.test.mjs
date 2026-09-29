// The funding-first launch (tag 42) through the hosted signer path, end to end on a mocked ledger: the creator funds the
// campaign's operating budget, the worker's durable packet (compiled through the campaign's lookup table, mint and fee NFT
// co-signing) is signed by the v3 registry signer with the real budget and the real cost reader holding exactly the reviewed
// rents, and the accounting lane settles the hold from the finalized outcome: unresolved history keeps the hold, a ledger
// whose loaded addresses differ from the pin is refused, a failed launch charges the fee only, a landed launch charges the
// fee plus the eight rents and releases the rest.
import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import {readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import pg from 'pg';
import {Keypair,PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,AddressLookupTableAccount,AddressLookupTableProgram} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import * as c from '../protocol-v2/client.mjs';
import * as policy from '../protocol-v2/policy.mjs';
import {launchFundingFirstInstruction,extAddress,displayHash,OFF_ACCOUNTING_VERSION,ACCOUNTING_VERSION_FUNDING_FIRST,EXT_LEN} from '../protocol-v3/client.mjs';
import {buildOperatingFundingPacket} from '../creation/operating-proofs.mjs';
import {packetAccountKeys,FUNDING_FIRST_LAUNCH_MODEL} from '../creation/operating-costs.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
import {createOperatingSignerBudget} from './operating-budget.mjs';
import {createRegistrySignerService} from './registry-service.mjs';
import {createStandardOperatingCostReader} from './standard-cost-reader.mjs';
import {pinCompiledLookups} from './lookup-resolution.mjs';
import {encodeLookupTableAccount,U64_MAX} from '../test/helpers/lookup-table-account.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=()=>Keypair.generate().publicKey;
const vector=JSON.parse(readFileSync(new URL('../protocol-v2/test-vectors.json',import.meta.url))).termsHash.find(v=>v.name==='standard');
const RENT={82:1461600,165:2039280,256:2672640,607:5115600},FEE=10000000,RENTS=2*RENT[82]+4*RENT[165]+RENT[256]+RENT[607]+FEE;
test('funding-first launch through the hosted signer path: funded hold, durable signature, finalized outcome, hold release',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),dir=await mkdtemp(join(tmpdir(),'kids-ff-signer-'));let pool,service;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const payer=Keypair.generate(),creator=Keypair.generate(),treasury=key(),program=key(),genesis=key(),mint=Keypair.generate(),feeNft=Keypair.generate();
  // A version-2 (funding-first) record: the standard sealed terms with this ledger, creator, treasury and the reserved mint.
  const t0={...vector.terms,genesis:c.keyHex(genesis),creator:c.keyHex(creator.publicKey),treasury:c.keyHex(treasury),childMint:c.keyHex(mint.publicKey)};
  const campaign=c.campaignAddress(program,creator.publicKey,t0.nonce),data=Buffer.alloc(policy.CAMPAIGN_LEN);
  c.CAMPAIGN_MAGIC.copy(data);policy.encodeTerms(t0).copy(data,8);policy.termsHash(data.subarray(8,808)).copy(data,808);data[OFF_ACCOUNTING_VERSION]=ACCOUNTING_VERSION_FUNDING_FIRST;
  const terms=c.decodeCampaign(data).terms,display={name:'Funding First',symbol:'FF',uri:terms.metadataUri};
  const ext=Buffer.alloc(EXT_LEN);Buffer.from('KIDSEXT2').copy(ext);campaign.toBuffer().copy(ext,8);mint.publicKey.toBuffer().copy(ext,72);feeNft.publicKey.toBuffer().copy(ext,104);Buffer.from(displayHash(display),'hex').copy(ext,136);ext[168]=ACCOUNTING_VERSION_FUNDING_FIRST;
  const base={genesisHash:String(genesis),programId:String(program),campaign:String(campaign),payer:String(payer.publicKey),policy:'funding-first-signing-test'};
  await registry.campaigns.upsert({...base,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  await registry.capabilities.grant({...base,programVersion:3,tags:[42],expiresAt:new Date(Date.now()+60000).toISOString()});
  const job=(await registry.jobs.enqueue({...base,jobClass:'settlement',operationKey:'launch'})).job;await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'ff-test',ttlMs:30000});
  // The campaign's lookup table (keeper-owned) holds every non-signer account of the launch.
  const {instruction}=launchFundingFirstInstruction(base.programId,campaign,terms,payer.publicKey,feeNft.publicKey,display);
  const tableKey=key(),entries=[...new Set(instruction.keys.filter(k=>!k.isSigner).map(k=>String(k.pubkey)))].map(x=>new PublicKey(x));
  const table=new AddressLookupTableAccount({key:tableKey,state:{deactivationSlot:U64_MAX,lastExtendedSlot:10,lastExtendedSlotStartIndex:0,authority:payer.publicKey,addresses:entries}});
  const accounts=new Map([[String(campaign),{data,owner:program,executable:false}],[String(extAddress(program,campaign)),{data:ext,owner:program,executable:false}]]);
  const transactions=new Map();let height=50;
  const connection={getGenesisHash:async()=>base.genesisHash,getBlockHeight:async()=>height,getEpochInfo:async()=>({blockHeight:height,absoluteSlot:height+10}),getFirstAvailableBlock:async()=>1,getSignatureStatuses:async()=>({context:{slot:height+10},value:[null]}),getTransaction:async sig=>transactions.get(sig)??null,getAccountInfo:async a=>accounts.get(String(a))??null,getMinimumBalanceForRentExemption:async n=>(n+128)*6960,
   getAccountInfoAndContext:async k=>({context:{slot:1000},value:String(k)===String(tableKey)?{owner:AddressLookupTableProgram.programId,executable:false,lamports:1,data:encodeLookupTableAccount({authority:payer.publicKey,addresses:entries,lastExtendedSlot:10})}:null})};
  // The creator funds the campaign's operating budget (finalized funding transfer to the keeper).
  const block={blockhash:String(key()),lastValidBlockHeight:100,observedSlot:50},fundingTerms={...base,creator:String(creator.publicKey),lamports:'100000000'},fundingTx=buildOperatingFundingPacket(fundingTerms,block);fundingTx.sign([creator]);
  const funding={binding:fundingTerms,block,signature:encodeBase58(fundingTx.signatures[0]),transactionBase64:Buffer.from(fundingTx.serialize()).toString('base64')};
  const landed=(tx,pre,post,fee,meta={})=>({slot:20,transaction:{message:tx.message,signatures:tx.signatures.map(encodeBase58)},meta:{err:null,preBalances:pre,postBalances:post,fee,...meta}});
  {const pre=fundingTx.message.staticAccountKeys.map(()=>0),post=pre.slice();pre[0]=110000000;post[0]=9995000;post[fundingTx.message.staticAccountKeys.findIndex(k=>k.equals(payer.publicKey))]=100000000;transactions.set(funding.signature,landed(fundingTx,pre,post,5000));}
  const reader=createStandardOperatingCostReader({connection,genesisHash:base.genesisHash,programId:base.programId,payer:base.payer,feeOperator:key(),treasury:String(treasury)});
  const budget=createOperatingSignerBudget({registry,connection,...base,treasury:String(treasury),loadFundingPacket:async()=>funding,loadCostIntent:reader});
  await budget.credit({...base,signature:funding.signature});
  const logs=[],token='synthetic-funding-first-signing-token-0';
  service=await createRegistrySignerService({admitRpc:async()=>{},registry,connection,...base,programVersion:3,keypair:payer,token,stateFile:join(dir,'state.json'),operatingBudget:budget,treasury:String(treasury),log:e=>logs.push(e)});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const post=body=>fetch('http://127.0.0.1:'+service.server.address().port+'/sign',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  // The durable packet exactly as the worker prepares it: compiled through the table, mint and fee NFT co-sign, keeper slot empty.
  async function prepare(n,d=display){
   const packetBlock={...block,blockhash:String(key())},stable='launch:'+n,op=canonicalHash({genesisHash:base.genesisHash,programId:base.programId,campaign:base.campaign,operationId:stable});
   const ix=launchFundingFirstInstruction(base.programId,campaign,terms,payer.publicKey,feeNft.publicKey,d).instruction;
   const message=new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:packetBlock.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:400000}),ix]}).compileToV0Message([table]);
   const tx=new VersionedTransaction(message);tx.sign([mint,feeNft]);assert.ok(tx.serialize().length<=1232,'fits through the table');assert.equal(message.header.numRequiredSignatures,3);
   const lookups=pinCompiledLookups(message,{lookups:[{table:String(tableKey),addresses:entries.map(String)}]});
   const descriptor=canonicalJson({...base,operationId:stable,operationKey:'launch',computeUnits:400000,intent:null,lookupTables:[String(tableKey)]});
   await registry.operatorPackets.prepare({operationId:op,descriptor,prepared:{base64:Buffer.from(tx.serialize()).toString('base64'),...packetBlock,lookups,lookupSlot:1000,facts:{}}});
   const messageBase64=Buffer.from(message.serialize()).toString('base64'),operationId='op:'+canonicalHash({operation:op,attempt:1,message:messageBase64});
   return {op,tx,message,ix,input:{message:messageBase64,operationId,campaign:base.campaign,operationKey:'launch',fencingToken:1,packetRef:{operationId:op,attempt:1}}};
  }
  const shadowOf=async op=>{const rows=(await registry.query('SELECT descriptor,status FROM operator_packets WHERE operation_id<>? AND attempt=1',[op])).rows;return rows.map(r=>({...JSON.parse(r.descriptor),status:r.status}));};
  const held=async()=>(await budget.balance(base)).heldLamports,spent=async()=>(await budget.balance(base)).spentLamports;
  const a=await prepare(1);let bindingA;
  await t.test('the real budget holds exactly the reviewed rents and the signature is persisted before the answer',async()=>{
   assert.equal(await held(),'0');
   const r=await post(a.input);assert.equal(r.status,200,JSON.stringify(await r.clone().json()));const {signature}=await r.json();a.tx.addSignature(payer.publicKey,Buffer.from(signature,'base64'));
   const shadows=(await shadowOf(a.op)).filter(s=>s.binding);assert.equal(shadows.length,1);bindingA=shadows[0].binding;
   assert.equal(shadows[0].costModel,FUNDING_FIRST_LAUNCH_MODEL);assert.equal(shadows[0].costIntent.maximumRentLamports,String(RENTS));assert.deepEqual(shadows[0].costIntent.display,display);assert.equal(shadows[0].status,'signed');
   assert.equal(bindingA.maximumLamports,String(15000+RENTS),'three signatures plus the eight rents');assert.equal(await held(),String(15000+RENTS));
   assert.equal((await post(a.input)).status,200,'the same accepted packet answers again');assert.equal(await held(),String(15000+RENTS),'and holds once');
  });
  await t.test('a launch whose display is not the opening commitment is refused deterministically; a reader outage stays retryable',async()=>{
   const bad=await prepare(2,{...display,name:'Other'});const r=await post(bad.input);assert.equal(r.status,409);const body=await r.json();assert.equal(body.signature,undefined);assert.equal(body.category,'signer-packet-refused');assert.match(body.error,/commitment/);
   assert.equal(logs.at(-1).reason,'operating packet refused');assert.equal(logs.at(-1).cause,'commitment');assert.equal(await held(),String(15000+RENTS));
  });
  const keys=packetAccountKeys({tx:a.tx,tables:[table]}),idx=i=>keys.findIndex(k=>k.equals(a.ix.keys[i].pubkey)),loaded=()=>{const l=a.message.getAccountKeys({addressLookupTableAccounts:[table]}).accountKeysFromLookups;return {writable:l.writable.map(String),readonly:l.readonly.map(String)};};
  const balances=()=>{const pre=keys.map(()=>0),post=pre.slice();pre[0]=100000000;for(const [i,size] of [[3,82],[4,165],[5,165],[6,82],[7,165],[8,256],[9,165],[30,607]])post[idx(i)]=RENT[size]+(i===30?FEE:0);post[0]=pre[0]-5000-RENTS;pre[idx(0)]=50000000000;post[idx(0)]=10000000;pre[idx(2)]=100000000;post[idx(2)]=1000000;post[idx(22)]=49000000000;post[idx(23)]=150000000;post[idx(5)]+=990000000;return {pre,post};};
  const sig=encodeBase58(a.tx.signatures[0]);
  await t.test('unresolved history keeps the hold; a ledger whose loaded addresses differ from the pin is refused',async()=>{
   assert.equal((await budget.reconcile(bindingA)).reason,'awaiting-finality');assert.equal(await held(),String(15000+RENTS));
   const {pre,post}=balances(),l=loaded();transactions.set(sig,landed(a.tx,pre,post,5000,{loadedAddresses:{writable:[...l.writable].reverse(),readonly:l.readonly}}));
   await assert.rejects(budget.reconcile(bindingA),/differ from the pinned resolution/);assert.equal(await held(),String(15000+RENTS));
   transactions.set(sig,landed(a.tx,pre.slice(0,a.tx.message.staticAccountKeys.length),post.slice(0,a.tx.message.staticAccountKeys.length),5000,{loadedAddresses:l}));
   await assert.rejects(budget.reconcile(bindingA),/balance evidence/);assert.equal(await held(),String(15000+RENTS));
  });
  await t.test('a landed launch charges the fee plus the eight rents over the complete key list and releases the rest',async()=>{
   const {pre,post}=balances();transactions.set(sig,landed(a.tx,pre,post,5000,{loadedAddresses:loaded()}));
   const outcome=await budget.reconcile(bindingA);assert.equal(outcome.actualLamports,String(5000+RENTS));
   assert.equal(await held(),'0');assert.equal(await spent(),String(5000+RENTS));
   assert.deepEqual((await shadowOf(a.op)).filter(s=>s.binding).map(s=>s.status),['finalized']);
  });
  await t.test('a failed launch charges the network fee only',async()=>{
   const b=await prepare(3);const r=await post(b.input);assert.equal(r.status,200);b.tx.addSignature(payer.publicKey,Buffer.from((await r.json()).signature,'base64'));
   const bindingB=(await shadowOf(b.op)).filter(s=>s.binding&&s.status==='signed')[0].binding;assert.equal(await held(),String(15000+RENTS));
   const pre=keys.map(()=>0);pre[0]=100000000;const postF=pre.slice();postF[0]-=5000;
   transactions.set(encodeBase58(b.tx.signatures[0]),landed(b.tx,pre,postF,5000,{err:{InstructionError:[1,{Custom:12}]},loadedAddresses:loaded()}));
   const failed=await budget.reconcile(bindingB);assert.equal(failed.actualLamports,'5000');
   assert.equal(await held(),'0');assert.equal(await spent(),String(10000+RENTS));
   assert.deepEqual((await shadowOf(b.op)).filter(s=>s.binding&&s.binding.operationId===bindingB.operationId).map(s=>s.status),['failed'],'the accounting shadow records the failed execution');
  });
  await t.test('a reader RPC outage during reservation is unresolved (503), and the same packet signs once the reader can read',async()=>{
   const good=await prepare(6);const readAccounts=connection.getAccountInfo;let outages=0;connection.getAccountInfo=async()=>{outages++;throw Error('rpc down');};
   const down=await post(good.input);assert.equal(down.status,503);assert.equal((await down.json()).category,undefined);assert.equal(await held(),'0');assert.ok(outages>=1);
   connection.getAccountInfo=readAccounts;const up=await post(good.input);assert.equal(up.status,200);
   const bindingGood=(await shadowOf(good.op)).filter(s=>s.binding&&s.status==='signed').at(-1).binding;assert.equal(await held(),String(15000+RENTS));
   assert.equal((await budget.reconcile(bindingGood)).reason,'awaiting-finality');assert.equal(await held(),String(15000+RENTS),'the hold outlives an unresolved outcome');
  });
 }finally{if(service?.server.listening)await service.close();if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();await rm(dir,{recursive:true,force:true});}
});
