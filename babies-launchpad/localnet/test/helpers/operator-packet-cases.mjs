// Runs the same crash/concurrency protocol against both registry engines. All keys
// are generated synthetic fixtures. RPC simulates packet delivery, not a real chain.
import assert from 'node:assert/strict';
import {Keypair,SystemProgram,VersionedTransaction} from '@solana/web3.js';
import {createLocalSigner} from '../../operator-signer.mjs';
import {createDurableSender,base58} from '../../protocol-v2/durable-send.mjs';

export async function operatorPacketCases(t,journals){
 function fixture(){
  const key=Keypair.generate(),signer=createLocalSigner(key),campaign=Keypair.generate().publicKey.toBase58();
  const stats={built:0,signed:0,broadcast:[],signerIds:[]},statuses=new Map();let height=50,blockNumber=0,held=true;
  const connection={
   async getLatestBlockhash(){blockNumber++;return {blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100+blockNumber};},
   async getLatestBlockhashAndContext(){return {context:{slot:900},value:await this.getLatestBlockhash()};},
   async getFirstAvailableBlock(){return 1;},
   async getBlockHeight(commitment){assert.equal(commitment,'finalized');return height;},
   async getEpochInfo(commitment){assert.equal(commitment,'finalized');return {blockHeight:height,absoluteSlot:1000};},
   async getSignatureStatuses(){return {context:{slot:1000},value:[statuses.get('current')??null]};},
   async sendRawTransaction(wire){stats.broadcast.push(Buffer.from(wire));return base58(VersionedTransaction.deserialize(wire).signatures[0]);},
   async confirmTransaction(){return {context:{slot:99},value:{err:null}};},
  };
  const keeper={publicKey:key.publicKey,async sign(tx,o){stats.signed++;stats.signerIds.push(o.operationId);return signer.sign(tx,o);}};
  const config={connection,keeper,genesisHash:Keypair.generate().publicKey.toBase58(),programId:Keypair.generate().publicKey.toBase58(),calls:{sent:0,unknown:0,confirmed:0}};
  const options={operationId:'launch:'+campaign,campaign,operationKey:'launch',intent:{action:'launch',termsHash:'test-immutable-terms'},holds:async()=>held};
  const build=()=>{stats.built++;const nft=Keypair.generate();return {instructions:[SystemProgram.createAccount({fromPubkey:key.publicKey,newAccountPubkey:nft.publicKey,lamports:1,space:0,programId:SystemProgram.programId})],extraSigners:[nft],facts:{feeNft:nft.publicKey.toBase58()}};};
  const sender=(index=0,checkpoint)=>createDurableSender({...config,journal:journals[index%journals.length],checkpoint});
  return {stats,statuses,connection,config,options,build,sender,setHeight:v=>{height=v;},loseLease:()=>{held=false;}};
 }
 await t.test('job reconciliation closes the exact journal packet before skipping completed chain work',async()=>{
  const {createChainAdapter}=await import('../../protocol-v2/chain-adapter.mjs');
  const f=fixture(),send=createDurableSender({...f.config,journal:journals[0],commitment:'finalized',confirmationWaitMs:0});
  const result=await send(f.build,f.options);
  const chain=createChainAdapter({connection:f.connection,programId:f.config.programId,genesisHash:f.config.genesisHash,signer:f.config.keeper,registry:{operatorPackets:journals[0]},commitment:'finalized'});
  f.statuses.set('current',{confirmationStatus:'confirmed',slot:101,err:null});assert.equal((await chain.signatureStatus(result.signature,result)).status,'unresolved');assert.equal((await journals[0].latest(result.packetRef.operationId)).status,'signed');
  await assert.rejects(chain.signatureStatus('wrong-signature',result),/packet differs/);
  await assert.rejects(chain.signatureStatus(result.signature,{...result,packetRef:{...result.packetRef,attempt:2}}),/packet differs/);
  const foreign=createChainAdapter({connection:f.connection,programId:Keypair.generate().publicKey,genesisHash:f.config.genesisHash,signer:f.config.keeper,registry:{operatorPackets:journals[0]},commitment:'finalized'});
  await assert.rejects(foreign.signatureStatus(result.signature,result),/scope differs/);
  f.statuses.set('current',{confirmationStatus:'finalized',slot:102,err:null});assert.equal((await chain.signatureStatus(result.signature,result)).status,'confirmed');assert.equal((await journals[0].latest(result.packetRef.operationId)).status,'finalized');assert.equal(f.stats.broadcast.length,1);
 });
 await t.test('asynchronous send never starts detached SDK confirmation work',async()=>{
  const f=fixture();f.connection.confirmTransaction=()=>{throw Error('SDK subscription must not start');};
  const send=()=>createDurableSender({...f.config,journal:journals[0],commitment:'finalized',confirmationWaitMs:0});
  const first=await send()(f.build,f.options);assert.equal(first.status,'unknown');assert.equal(f.stats.broadcast.length,1);
  f.statuses.set('current',{confirmationStatus:'finalized',slot:123,err:null});
  const second=await send()(f.build,f.options);assert.equal(second.status,'confirmed');assert.equal(second.signature,first.signature);assert.equal(f.stats.broadcast.length,1);
 });
 await t.test('bounded confirmation frees its slot and retains the exact packet until finalized',async()=>{
  const f=fixture();let aborted=false;
  f.connection.confirmTransaction=async({abortSignal},commitment)=>{assert.equal(commitment,'finalized');return new Promise((_,reject)=>abortSignal.addEventListener('abort',()=>{aborted=true;reject(Error('wait interrupted'));},{once:true}));};
  const send=()=>createDurableSender({...f.config,journal:journals[0],commitment:'finalized',confirmationWaitMs:10});
  const first=await send()(f.build,f.options);assert.equal(first.status,'unknown');assert.equal(aborted,true);
  f.statuses.set('current',{confirmationStatus:'confirmed',slot:123,err:null});
  const waiting=await send()(f.build,f.options);assert.equal(waiting.status,'unknown');assert.equal(waiting.signature,first.signature);
  assert.equal(f.stats.built,1);assert.equal(f.stats.signed,1);assert.equal(f.stats.broadcast.length,1);
  f.statuses.set('current',{confirmationStatus:'finalized',slot:123,err:null});
  assert.equal((await send()(f.build,f.options)).status,'confirmed');assert.equal(f.stats.broadcast.length,1);
 });
 await t.test('a cached confirmed packet never satisfies a finalized caller or permits replacement',async()=>{
  const f=fixture(),first=await f.sender()(f.build,f.options);
  const send=createDurableSender({...f.config,journal:journals[0],commitment:'finalized'});
  f.statuses.set('current',{confirmationStatus:'confirmed',slot:123,err:null});
  assert.equal((await send(f.build,f.options)).status,'unknown');
  f.statuses.clear();f.setHeight(200);
  assert.equal((await send(f.build,f.options)).status,'unknown');assert.equal(f.stats.built,1);
  f.statuses.set('current',{confirmationStatus:'finalized',slot:124,err:null});
  const result=await send(f.build,f.options);assert.equal(result.status,'confirmed');assert.equal(result.signature,first.signature);assert.equal(f.stats.broadcast.length,1);
 });
 await t.test('confirmation waits reject invalid bounds before signing',async()=>{
  const f=fixture();for(const confirmationWaitMs of [-1,30001,1.2,NaN,'100'])assert.throws(()=>createDurableSender({...f.config,journal:journals[0],confirmationWaitMs}),/Invalid operator confirmation wait/);
  assert.equal(f.stats.signed,0);
 });
 for(const crashAt of ['prepared','signed','broadcast'])await t.test('restart after '+crashAt+' keeps exact packet and auxiliary signer',async()=>{
  const f=fixture();let crashed;
  const first=f.sender(0,async(stage,row)=>{if(stage===crashAt){crashed=row;throw Error('synthetic process crash');}});
  await assert.rejects(first(f.build,f.options),/synthetic process crash/);
  assert.equal(f.stats.broadcast.length,crashAt==='broadcast'?1:0);
  const recovered=await f.sender(1)(f.build,f.options);
  assert.equal(recovered.status,'confirmed');assert.equal(recovered.feeNft,crashed.prepared.facts.feeNft);
  assert.equal(f.stats.built,1,'no replacement NFT or blockhash while unresolved');assert.equal(f.stats.signed,1);
  const latest=await journals[1%journals.length].latest(crashed.operationId);
  assert.equal(recovered.signature,latest.signature);
  for(const wire of f.stats.broadcast)assert.equal(wire.toString('base64'),latest.signedBase64);
  const again=await f.sender()(f.build,f.options);assert.equal(again.signature,recovered.signature);
  assert.equal(f.stats.broadcast.length,crashAt==='broadcast'?2:1,'confirmed attempts never resend');
 });
 await t.test('lost broadcast response reconciles landing without a new send',async()=>{
  const f=fixture();f.connection.sendRawTransaction=async wire=>{f.stats.broadcast.push(Buffer.from(wire));f.statuses.set('current',{confirmationStatus:'confirmed',slot:123,err:null});throw Error('network response lost');};
  assert.equal((await f.sender()(f.build,f.options)).status,'unknown');
  assert.equal((await f.sender(1)(f.build,f.options)).status,'confirmed');
  assert.equal(f.stats.broadcast.length,1);assert.equal(f.stats.built,1);
 });
 await t.test('RPC failure or a processed error cannot authorize a fresh packet',async()=>{
  const f=fixture();f.connection.confirmTransaction=async()=>{throw Error('timeout');};
  assert.equal((await f.sender()(f.build,f.options)).status,'unknown');
  const read=f.connection.getSignatureStatuses;f.connection.getSignatureStatuses=async()=>{throw Error('RPC unavailable');};
  assert.equal((await f.sender(1)(f.build,f.options)).status,'unknown');
  f.connection.getSignatureStatuses=read;f.statuses.set('current',{confirmationStatus:'processed',slot:3,err:{InstructionError:[1,{Custom:1}]}});
  f.setHeight(1000);assert.equal((await f.sender()(f.build,f.options)).status,'unknown');
  assert.equal(f.stats.built,1);assert.equal(f.stats.broadcast.length,1);
 });
 await t.test('proven expiry records the old attempt before a later call can rebuild',async()=>{
  const f=fixture();let original;
  await assert.rejects(f.sender(0,async(stage,row)=>{if(stage==='signed'){original=row;throw Error('crash');}})(f.build,f.options),/crash/);
  f.setHeight(200);
  assert.equal((await f.sender(1)(f.build,f.options)).status,'failed');assert.equal(f.stats.built,1);
  assert.equal((await journals[0].latest(original.operationId)).status,'expired');
  f.setHeight(50);const replacement=await f.sender(1)(f.build,f.options);
  assert.equal(replacement.status,'confirmed');assert.notEqual(replacement.signature,original.signature);
  assert.notEqual(replacement.feeNft,original.prepared.facts.feeNft);assert.equal(f.stats.built,2);
  assert.equal((await journals[0].latest(original.operationId)).attempt,2);
  assert.equal(new Set(f.stats.signerIds).size,2);assert.ok(f.stats.signerIds.every(id=>id.length<120));
 });
 await t.test('old job facts reconcile the exact expired attempt after a newer preparation',async()=>{
  const {createChainAdapter}=await import('../../protocol-v2/chain-adapter.mjs');
  const f=fixture();f.connection.confirmTransaction=async()=>{throw Error('timeout');};
  const first=await f.sender()(f.build,f.options);f.setHeight(200);
  assert.equal((await f.sender()(f.build,f.options)).status,'failed');
  f.setHeight(50);await assert.rejects(f.sender(0,async stage=>{if(stage==='prepared')throw Error('stop after new preparation');})(f.build,f.options),/new preparation/);
  const newer=await journals[0].latest(first.packetRef.operationId);assert.equal(newer.attempt,2);assert.equal(newer.status,'prepared');
  const chain=createChainAdapter({connection:{},programId:f.config.programId,genesisHash:f.config.genesisHash,signer:f.config.keeper,registry:{operatorPackets:journals[0]},commitment:'finalized'});
  assert.equal((await chain.signatureStatus(first.signature,first)).status,'expired','Immutable prior evidence survives later attempts and RPC history loss');
  assert.equal((await journals[0].latest(first.packetRef.operationId)).status,'prepared','Reconciliation cannot mutate the newer attempt');
  await assert.rejects(chain.signatureStatus('wrong',first),/packet differs/);
  await assert.rejects(journals[0].get(first.packetRef.operationId,0),/Invalid operator attempt/);
 });
 await t.test('pruned history cannot expire a signed packet or authorize a replacement',async()=>{
  for(const firstAvailable of [901,NaN,-1]){
   const f=fixture();f.connection.confirmTransaction=async()=>{throw Error('timeout');};
   const first=await f.sender()(f.build,f.options);f.setHeight(200);
   f.connection.getFirstAvailableBlock=async()=>firstAvailable;
   const retry=await f.sender()(f.build,f.options);
   assert.equal(retry.status,'unknown');assert.equal(retry.signature,first.signature);assert.equal(f.stats.built,1);assert.equal(f.stats.signed,1);
   assert.equal((await journals[0].latest(first.packetRef.operationId)).status,'signed');
  }
 });
 await t.test('retention is checked again after history lookup races a prune',async()=>{
  const f=fixture();f.connection.confirmTransaction=async()=>{throw Error('timeout');};
  const first=await f.sender()(f.build,f.options);f.setHeight(200);let reads=0;
  f.connection.getFirstAvailableBlock=async()=>++reads===1?1:901;
  assert.equal((await f.sender()(f.build,f.options)).status,'unknown');assert.equal(reads,2);
  assert.equal((await journals[0].latest(first.packetRef.operationId)).status,'signed');assert.equal(f.stats.built,1);
 });
 await t.test('legacy packets without an observed slot cannot be declared expired from missing history',async()=>{
  const {packetStatus}=await import('../../protocol-v2/durable-send.mjs');
  const f=fixture();f.setHeight(200);
  assert.equal((await packetStatus(f.connection,'synthetic',{lastValidBlockHeight:100})).status,'unresolved');
  f.statuses.set('current',{confirmationStatus:'finalized',slot:1000,err:null});
  assert.equal((await packetStatus(f.connection,'synthetic',{lastValidBlockHeight:100})).status,'confirmed');
 });
 await t.test('invalid blockhash observation refuses preparation and signing',async()=>{
  const f=fixture();f.connection.getLatestBlockhashAndContext=async()=>({context:{slot:0},value:await f.connection.getLatestBlockhash()});
  await assert.rejects(f.sender()(f.build,f.options),/observation slot/);assert.equal(f.stats.signed,0);assert.equal(f.stats.broadcast.length,0);
 });
 await t.test('expired unsigned packet cannot be signed by a stale worker',async()=>{
  const f=fixture();let original;
  await assert.rejects(f.sender(0,async(stage,row)=>{if(stage==='prepared'){original=row;throw Error('crash');}})(f.build,f.options),/crash/);
  f.setHeight(200);assert.equal((await f.sender(1)(f.build,f.options)).status,'failed');
  await assert.rejects(journals[0].sign({operationId:original.operationId,attempt:1,signedBase64:original.prepared.base64,signature:'3'.repeat(87)}),{code:'PACKET_CONFLICT'});
  assert.equal(f.stats.signed,0);assert.equal(f.stats.broadcast.length,0);
 });
 await t.test('lease loss after durable signing prevents broadcast',async()=>{
  const f=fixture();let row;
  await assert.rejects(f.sender(0,async(stage,r)=>{if(stage==='signed'){row=r;f.loseLease();}})(f.build,f.options),{code:'STALE_LEASE'});
  assert.equal(f.stats.broadcast.length,0);assert.equal((await journals[0].latest(row.operationId)).status,'signed');
 });
 await t.test('concurrent builds choose one packet and parameter changes are rejected',async()=>{
  const f=fixture();const outcomes=await Promise.all([f.sender(0)(f.build,f.options),f.sender(1)(f.build,f.options)]);
  assert.equal(new Set(outcomes.map(r=>r.signature)).size,1);assert.equal(new Set(outcomes.map(r=>r.feeNft)).size,1);
  assert.equal(new Set(f.stats.broadcast.map(b=>b.toString('base64'))).size,1);
  await assert.rejects(f.sender(1)(f.build,{...f.options,computeUnits:300000}),{code:'IDEMPOTENCY_CONFLICT'});
 });
 await t.test('journal failure prevents sending even when a valid signature exists',async()=>{
  const f=fixture();const broken={...journals[0],async sign(){throw Error('database unavailable');}};
  const send=createDurableSender({...f.config,journal:broken});
  await assert.rejects(send(f.build,f.options),/database unavailable/);
  assert.equal(f.stats.broadcast.length,0);
 });
 await t.test('a lagging RPC history cannot authorize expiry and replacement',async()=>{
  const f=fixture();f.connection.confirmTransaction=async()=>{throw Error('timeout');};
  await f.sender()(f.build,f.options);f.setHeight(200);
  f.connection.getSignatureStatuses=async()=>({context:{slot:900},value:[null]});
  assert.equal((await f.sender(1)(f.build,f.options)).status,'unknown');
  assert.equal(f.stats.built,1);
 });
 await t.test('finalized execution failure permits a later attempt; ambiguous preflight does not',async()=>{
  const f=fixture();f.connection.sendRawTransaction=async()=>{throw Error('Transaction simulation failed');};
  assert.equal((await f.sender()(f.build,f.options)).status,'unknown');
  assert.equal((await f.sender(1)(f.build,f.options)).status,'unknown');assert.equal(f.stats.built,1);
  f.statuses.set('current',{confirmationStatus:'finalized',err:{InstructionError:[1,{Custom:4}]},slot:105});
  const failed=await f.sender()(f.build,f.options);assert.equal(failed.status,'failed');assert.match(failed.error,/custom program error: 0x4/);
  f.statuses.clear();await f.sender(1)(f.build,f.options);assert.equal(f.stats.built,2);
 });
 await t.test('signer changing approved instructions cannot persist or broadcast',async()=>{
  const f=fixture();const keeper={...f.config.keeper,async sign(tx){tx.message.recentBlockhash=Keypair.generate().publicKey.toBase58();}};
  const send=createDurableSender({...f.config,keeper,journal:journals[0]});
  await assert.rejects(send(f.build,f.options),/changed approved message/);assert.equal(f.stats.broadcast.length,0);
 });
}
