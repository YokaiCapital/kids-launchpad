// Explicit isolated localnet qualification, not a production mint/signing endpoint.
// Exercises the reused generator and encrypted asset signer without exporting
// a mint private key. All mutable data lives under a new private temporary directory.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {Connection,Keypair,PublicKey,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {createInitializeMint2Instruction,createAssociatedTokenAccountIdempotentInstruction,createMintToInstruction,createSetAuthorityInstruction,AuthorityType,getMint,getAccount} from '@solana/spl-token';
import {campaignAddress,launchAuthority,associatedTokenAddress,TOKEN_PROGRAM} from '../protocol-v2/client.mjs';
import {openRegistry} from '../registry/registry.mjs';import {createMintLeases,validateKidsMint} from './leases.mjs';
import {canonicalHash} from '../registry/canonical.mjs';import {encodeBase58} from '../../shared/solana.mjs';
import {createMintIntent,buildMintPacket,verifyMintApproval} from '../creation/mint-packet.mjs';
import {createMintApprovalJournal} from '../creation/mint-approval.mjs';
import {createMintExecutor} from '../creation/mint-execution.mjs';
import {createMintWalletService} from '../creation/mint-wallet.mjs';
import {createMintRecovery} from '../creation/mint-recovery.mjs';
import {metadataAddress,METADATA_PROGRAM} from '../token-metadata.mjs';
import {SqliteVanityMintInventory} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/mint-inventory.js';
import {SqliteLaunchExecutionStore} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/sqlite-execution-store.js';
import {runParallelMintRefill} from '../../kids-mint-worker/vendor/mint-refill-parallel.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function qualifyInventory({processes=4,timeoutMs=600000,log=()=>{},programVersion=2,registry:sharedRegistry=null,prepare=null,mintPlan=null,retryGenerations=0}={}){
 if(!Number.isInteger(retryGenerations)||retryGenerations<0||retryGenerations>2||retryGenerations&&(!sharedRegistry||programVersion!==3))throw Error('Retry qualification needs shared v3 registry');
 if(![2,3].includes(programVersion))throw Error('Explicit local program version required');
 const manifest=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v'+programVersion+'-program.json',import.meta.url),'utf8'));
 if(manifest.rpcUrl!=='http://127.0.0.1:19199')throw Error('Qualification requires the isolated v2 local ledger');
 const connection=new Connection(manifest.rpcUrl,'confirmed'),genesisHash=await connection.getGenesisHash();
 if(genesisHash!==manifest.genesisHash)throw Error('Qualification ledger identity mismatch');
 const programId=new PublicKey(manifest.programId);
 if(!(await connection.getAccountInfo(programId))?.executable)throw Error('Qualification program unavailable');
 const creator=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(manifest.adminKeyFile,'utf8'))));
 const dir=mkdtempSync(join(tmpdir(),'kids-mint-qualification-')),encryptionKey=randomBytes(32);
 const save=(name,value)=>writeFileSync(join(dir,name),JSON.stringify(value),{mode:0o600,flag:'wx'});
 save('encryption.json',{key:encryptionKey.toString('hex')}); // private recovery only; never printed or exported
 const records=new SqliteLaunchExecutionStore(join(dir,'executions.sqlite'));
 const open=()=>new SqliteVanityMintInventory({databasePath:join(dir,'inventory.sqlite'),executionStore:records,keyId:'local-qualification',encryptionKey,fallbackToOrdinaryMint:false});
 let inventory=open();const registry=sharedRegistry??openRegistry({path:join(dir,'leases.sqlite')});await registry.migrate();
 const started=Date.now(),abort=new AbortController();let timer,poll;
 try{
  timer=setTimeout(()=>abort.abort(),timeoutMs);
  poll=setInterval(()=>{if(inventory.counts().available>0)abort.abort();},100);
  await runParallelMintRefill({inventory,signal:abort.signal,processes,webParent:false,report:r=>log({event:'qualification-grinding',...r})});
  clearTimeout(timer);clearInterval(poll);
  if(inventory.counts().available<1)throw Error('No kids mint found within the qualification bound');
  const prepared=prepare?await prepare({registry,inventory,manifest,connection,creator:creator.publicKey.toBase58()}):null;
  const nonce=prepared?BigInt(prepared.nonce):randomBytes(8).readBigUInt64LE(),campaign=campaignAddress(programId,creator.publicKey,nonce),authority=launchAuthority(programId,campaign);
  if(prepared){assert.equal(prepared.campaign,campaign.toBase58());assert.equal(prepared.authority,authority.toBase58());assert.equal(prepared.state,'reserved');}
  const binding={creator:creator.publicKey.toBase58(),draftId:'asset:'+(prepared?.requestId??randomUUID())};binding.idempotencyKey=binding.draftId;
  let leases=createMintLeases({registry,inventory});
  const reserved=await leases.reserve({network:'localnet',genesisHash,programId:programId.toBase58(),campaign:campaign.toBase58(),...binding});
  assert.equal(reserved.outcome,prepared?'existing':'reserved');const lease=reserved.lease,mint=new PublicKey(validateKidsMint(lease.mint));
  if(prepared){assert.equal(lease.leaseId,prepared.leaseId);assert.equal(lease.mint,prepared.mint);}
  const reservation=inventory.findReservation(binding);assert.equal(reservation.mintAddress,lease.mint);
  assert.equal((await leases.reserve({network:'localnet',genesisHash,programId:programId.toBase58(),campaign:campaign.toBase58(),...binding})).lease.leaseId,lease.leaseId);
  const child=associatedTokenAddress(authority,mint),supply=1000000000000000n,rent=await connection.getMinimumBalanceForRentExemption(82);
  if(await connection.getBalance(creator.publicKey)<1000000000){const s=await connection.requestAirdrop(creator.publicKey,2000000000);await connection.confirmTransaction(s,'confirmed');}
  const withMetadata=programVersion===3;
  const sealed=mintPlan?await mintPlan.seal(prepared.requestId):null;
  if(sealed)assert.equal(sealed.status,'sealed');
  let block=await connection.getLatestBlockhash('confirmed');
  const intent=sealed?.intent??(withMetadata?createMintIntent({preparation:prepared??{programVersion:3,state:'reserved',fundingEnabled:false,requestId:binding.draftId.slice(6),leaseId:lease.leaseId,genesisHash,programId:programId.toBase58(),nonce:String(nonce),campaign:campaign.toBase58(),authority:authority.toBase58(),mint:mint.toBase58()},creator:binding.creator,rentLamports:String(rent),metadata:{name:'KIDS local rehearsal',symbol:'LocalTest',uri:'https://kids.fun/rehearsal/'+mint.toBase58()+'.json',documentHash:canonicalHash({scope:'local-metadata-fixture-not-published',name:'KIDS local rehearsal',symbol:'LocalTest'})}}):{genesisHash,programId:programId.toBase58(),creator:binding.creator,mint:mint.toBase58(),campaign:campaign.toBase58(),authority:authority.toBase58(),child:child.toBase58(),supply:String(supply),rent,block});
  save('intent.json',intent);
  // Independently reconstruct from the persisted trusted plan; caller supplies only
  // a reservation binding. The mint signer never accepts caller transaction bytes.
  const rebuild=p=>new TransactionMessage({payerKey:new PublicKey(p.creator),recentBlockhash:p.block.blockhash,instructions:[
   SystemProgram.createAccount({fromPubkey:new PublicKey(p.creator),newAccountPubkey:new PublicKey(p.mint),lamports:p.rent,space:82,programId:TOKEN_PROGRAM}),
   createInitializeMint2Instruction(new PublicKey(p.mint),6,new PublicKey(p.creator),null),
   createAssociatedTokenAccountIdempotentInstruction(new PublicKey(p.creator),new PublicKey(p.child),new PublicKey(p.authority),new PublicKey(p.mint)),
   createMintToInstruction(new PublicKey(p.mint),new PublicKey(p.child),new PublicKey(p.creator),BigInt(p.supply)),
   createSetAuthorityInstruction(new PublicKey(p.mint),new PublicKey(p.creator),AuthorityType.MintTokens,null)
  ]}).compileToV0Message();
  const journalConfig={mode:'localnet-rehearsal',programVersion:3,rpcUrl:manifest.rpcUrl,genesisHash,programId:programId.toBase58(),pilotCreator:binding.creator};
  const loadIntent=mintPlan?id=>mintPlan.load(id):async()=>JSON.parse(readFileSync(join(dir,'intent.json'),'utf8'));
  const openApprovals=()=>withMetadata&&registry.driver==='postgres'?createMintApprovalJournal({registry,mintLeases:leases,connection,config:journalConfig,loadIntent}):null;
  let approvals=openApprovals();
  const wallet=()=>mintPlan?createMintWalletService({registry,connection,config:journalConfig,plans:mintPlan,approvals}):null;
  const offer=mintPlan?await wallet().prepare(binding.creator,{requestId:intent.requestId}):null;
  if(offer){assert.equal(offer.action,'sign-mint');block=offer.block;}
  save('attempt.json',block);
  const packet=offer?VersionedTransaction.deserialize(Buffer.from(offer.transactionBase64,'base64')):withMetadata?buildMintPacket(intent,block):new VersionedTransaction(rebuild(intent));packet.sign([creator]);
  save('creator-approved.json',{packet:Buffer.from(packet.serialize()).toString('base64')});
  const digest=hash(packet.message.serialize());
  if(offer){const result=await wallet().submit(binding.creator,{requestId:intent.requestId,offerId:offer.offerId,transactionBase64:Buffer.from(packet.serialize()).toString('base64')});assert.equal(result.action,'resume');}
  else if(approvals)await approvals.record(intent.requestId,{block,creatorPacket:Buffer.from(packet.serialize()).toString('base64')});
  else assert.equal((await leases.recordSigningIntent({leaseId:lease.leaseId,messageDigest:digest})).outcome,'recorded');
  const authorize=async input=>{
   assert.equal(input.creator,binding.creator);assert.equal(input.draftId,binding.draftId);assert.equal(input.idempotencyKey,binding.idempotencyKey);assert.equal(input.reservationId,reservation.reservationId);
   if(approvals)return approvals.authorize(input);
   const stored=JSON.parse(readFileSync(join(dir,'intent.json'),'utf8')),approved=JSON.parse(readFileSync(join(dir,'creator-approved.json'),'utf8'));
   assert.equal(await connection.getGenesisHash(),stored.genesisHash);
   if(withMetadata)return verifyMintApproval(stored,JSON.parse(readFileSync(join(dir,'attempt.json'),'utf8')),approved.packet);
   return {creator:stored.creator,mint:stored.mint,intentHash:canonicalHash(stored),packet:approved.packet,message:rebuild(stored).serialize(),lookupTables:[]};
  };
  const input={...binding,reservationId:reservation.reservationId};
  const first=await inventory.assetMintSigner(authorize)(input);
  await assert.rejects(inventory.assetMintSigner(authorize)({...input,reservationId:randomUUID()}));
  inventory.close();inventory=open();leases=createMintLeases({registry,inventory});approvals=openApprovals();
  const second=await inventory.assetMintSigner(authorize)(input);
  assert.equal(second.transactionBase64,first.transactionBase64,'inventory restart retains the identical mint signature');
  const wrong=async x=>({...await authorize(x),message:Uint8Array.from([1,2,3])});
  await assert.rejects(inventory.assetMintSigner(wrong)(input),/independently rebuilt/);
  const release=inventory.releaseUnsignedReservation(binding,{reservationId:reservation.reservationId});assert.equal(release.released,false);
  let wire=Buffer.from(first.transactionBase64,'base64'),signed=VersionedTransaction.deserialize(wire),signature=encodeBase58(signed.signatures[0]);
  if(approvals){const saved=await approvals.captureSigned(intent.requestId,first.transactionBase64);assert.equal(saved.signature,signature);assert.equal((await approvals.read(intent.requestId)).signedBase64,first.transactionBase64);}
  else assert.equal((await leases.recordSignature({leaseId:lease.leaseId,messageDigest:digest,signature})).outcome,'recorded');
  save('signed-packet.json',{signature,packet:first.transactionBase64,block}); // durable before broadcast
  const retired=[];
  for(let generation=1;generation<=retryGenerations;generation++){
   const oldRow=await approvals.read(intent.requestId),oldSignature=signature;
   log({event:'qualification-wait-finalized-expiry',generation,mint:mint.toBase58(),signature});
   const until=Date.now()+180000;
   while((await connection.getEpochInfo('finalized')).blockHeight<=block.lastValidBlockHeight){if(Date.now()>until)throw Error('Qualification expiry deadline');await new Promise(r=>setTimeout(r,1000));}
   const recovery=createMintRecovery({registry,connection,config:journalConfig,plans:{load:loadIntent},approvals});
   const recovered=await recovery.recover(binding.creator,{requestId:intent.requestId,expectedSignature:signature});assert.equal(recovered.generation,generation);assert.equal(recovered.action,'prepare-mint');
   const retryWallet=createMintWalletService({registry,connection,config:journalConfig,plans:{load:loadIntent},approvals,recovery});
   const nextOffer=mintPlan?await retryWallet.prepare(binding.creator,{requestId:intent.requestId}):null;
   if(nextOffer)assert.equal(nextOffer.action,'sign-mint');block=nextOffer?.block??await connection.getLatestBlockhash('confirmed');
   const next=nextOffer?VersionedTransaction.deserialize(Buffer.from(nextOffer.transactionBase64,'base64')):buildMintPacket(intent,block);next.sign([creator]);
   const creatorPacket=Buffer.from(next.serialize()).toString('base64');
   if(nextOffer)await retryWallet.submit(binding.creator,{requestId:intent.requestId,offerId:nextOffer.offerId,transactionBase64:creatorPacket});
   else await approvals.record(intent.requestId,{block,creatorPacket});
   await assert.rejects(approvals.captureSigned(intent.requestId,oldRow.signedBase64),/invalid signed/);
   const retrySigned=await inventory.assetMintSigner(authorize)(input);
   assert.equal((await inventory.assetMintSigner(authorize)(input)).transactionBase64,retrySigned.transactionBase64);
   const captured=await approvals.captureSigned(intent.requestId,retrySigned.transactionBase64);
   wire=Buffer.from(captured.packet,'base64');signed=VersionedTransaction.deserialize(wire);signature=captured.signature;
   assert.notEqual(signature,oldSignature);assert.equal((await approvals.read(intent.requestId)).attempt,generation+1);
   retired.push(oldSignature);log({event:'qualification-retry-signed',generation,mint:mint.toBase58(),signature});
  }
  const sim=await connection.simulateTransaction(signed,{sigVerify:true,commitment:'confirmed'});assert.equal(sim.value.err,null,JSON.stringify(sim.value.err));
  if(approvals){
   const executor=extra=>createMintExecutor({registry,approvals,mintLeases:leases,connection,config:journalConfig,loadIntent,...extra});
   // Simulate process loss after the RPC accepted the persisted bytes, before the
   // worker can report success. The next instance must reconcile, not mint again.
   await assert.rejects(executor({checkpoint:async phase=>{if(phase==='broadcast')throw Error('qualification-broadcast-crash');}}).resume(intent.requestId),/qualification-broadcast-crash/);
   assert.equal((await approvals.read(intent.requestId)).status,'signed');
   assert.equal((await connection.confirmTransaction({signature,...block},'finalized')).value.err,null);
   const recovered=await executor().resume(intent.requestId);assert.equal(recovered.status,'minted');assert.equal(recovered.evidence.immutableMetadata,true);
   assert.equal((await approvals.read(intent.requestId)).status,'finalized');assert.equal((await executor().resume(intent.requestId)).signature,signature);
  }else assert.equal(await connection.sendRawTransaction(wire,{skipPreflight:false,maxRetries:0}),signature);
  assert.equal((await connection.confirmTransaction({signature,...block},'finalized')).value.err,null);
  const mintInfo=await getMint(connection,mint,'finalized'),holding=await getAccount(connection,child,'finalized');
  assert.equal(mintInfo.supply,supply);assert.equal(mintInfo.decimals,6);assert.equal(mintInfo.mintAuthority,null);assert.equal(mintInfo.freezeAuthority,null);assert.equal(holding.amount,supply);assert.ok(holding.owner.equals(authority));
  if(withMetadata){
   const account=await connection.getAccountInfo(metadataAddress(mint),'finalized');assert.ok(account?.owner.equals(METADATA_PROGRAM));
   const d=account.data;assert.equal(d[0],4);assert.ok(new PublicKey(d.subarray(33,65)).equals(mint));
   let offset=65;const string=()=>{const len=d.readUInt32LE(offset);offset+=4;const value=d.subarray(offset,offset+len).toString('utf8').replace(/\0+$/,'');offset+=len;return value;};
   assert.equal(string(),intent.metadata.name);assert.equal(string(),intent.metadata.symbol);assert.equal(string(),intent.metadata.uri);
   assert.equal(d.readUInt16LE(offset),0);offset+=2;assert.equal(d[offset++],0,'no creator royalty records');offset++;assert.equal(d[offset],0,'metadata immutable on chain');
  }
  assert.equal((await leases.markConsumed({leaseId:lease.leaseId,signature})).outcome,'consumed');
  assert.equal((await leases.get(lease.leaseId)).state,'consumed');assert.equal(inventory.findReservation(binding).status,'signed');
  if(offer){assert.equal((await wallet().prepare(binding.creator,{requestId:intent.requestId})).action,'resume');assert.equal((await wallet().status(binding.creator,{requestId:intent.requestId})).state,'finalized');}
  const report={directory:dir,network:'localnet',genesisHash,programId:programId.toBase58(),programVersion,requestId:prepared?.requestId??null,mint:mint.toBase58(),signature,campaign:campaign.toBase58(),custody:child.toBase58(),packetBytes:wire.length,elapsedMs:Date.now()-started,authorityRevoked:true,immutableMetadataVerified:withMetadata,postBroadcastRecoveryVerified:!!approvals,sharedMintPlanVerified:!!mintPlan,walletOfferVerified:!!offer,retryGenerationsVerified:retryGenerations,retiredSignatures:retired,metadataPublished:false,supply:String(supply),leaseState:'consumed',scope:'mint-path-only-no-campaign-created'};
  save('report.json',report);log({event:'qualification-passed',...report});return report;
 }catch(e){log({event:'qualification-failed',recoveryDirectory:dir});throw e;}
 finally{abort.abort();clearTimeout(timer);clearInterval(poll);inventory.close();records.close();if(!sharedRegistry)await registry.close();encryptionKey.fill(0);creator.secretKey.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyInventory({log:event=>console.log(JSON.stringify(event))}).catch(e=>{console.error(e.message);process.exitCode=1;});
