import {escrowIntentRetry} from './escrow-intent-retry.mjs';
import {createIntentRetention,intentHistorySize,summarizeIntents} from '../shared/intent-retention.mjs';
import {writeDurableJson} from '../shared/durable-json.mjs';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {Connection,PublicKey,Transaction,VersionedTransaction,TransactionInstruction,SystemProgram,sendAndConfirmTransaction} from '@solana/web3.js';
import {readLocalConfig} from '../interaction-review/server/local-config.mjs';
import {encodeBase58,verifySignature} from '../shared/solana.mjs';
import {validateApprovedMessage} from '../shared/approved-message.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
const runtime=fileURLToPath(new URL('./.runtime/',import.meta.url));
const manifestPath=runtime+'escrow-campaign.json',intentPath=runtime+'escrow-intents.json';
const save=writeDurableJson;
const read=path=>JSON.parse(readFileSync(path,'utf8'));
export function u64(value){const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(value));return b;}
export function campaignAddress(programId,creator,nonce){return PublicKey.findProgramAddressSync([Buffer.from('campaign'),new PublicKey(creator).toBuffer(),u64(nonce)],programId)[0];}
export function receiptAddress(programId,campaign,owner){return PublicKey.findProgramAddressSync([Buffer.from('commitment'),new PublicKey(campaign).toBuffer(),new PublicKey(owner).toBuffer()],programId)[0];}
// The earlier (legacy) escrow exists only on the local validator; on a real network every entry point stands down.
const LEGACY_OFF=(process.env.KIDS_NETWORK||'localnet')!=='localnet';
export async function escrowContext(){
 const config=readLocalConfig();if(config?.network!=='localnet'||config.rpcUrl!=='http://127.0.0.1:18999')throw Error('Escrow requires isolated localnet');
 const connection=new Connection(config.rpcUrl,'confirmed');if(await connection.getGenesisHash()!==config.genesisHash)throw Error('Localnet genesis changed');
 if(!existsSync(runtime+'escrow-program.json'))throw Error('Escrow program is not deployed');
 const deployment=read(runtime+'escrow-program.json');if(deployment.genesisHash!==config.genesisHash)throw Error('Escrow deployment belongs to another ledger');
 const programId=new PublicKey(deployment.programId),program=await connection.getAccountInfo(programId);
 if(!program?.executable||program.owner.toBase58()!=='BPFLoaderUpgradeab1e11111111111111111111111'||program.data.readUInt32LE(0)!==2)throw Error('Escrow program is unavailable');
 const data=await connection.getAccountInfo(new PublicKey(program.data.subarray(4,36)));
 if(!data||!data.owner.equals(program.owner)||data.data.readUInt32LE(0)!==3||data.data[12]!==0)throw Error('Escrow program must have no upgrade authority');
 return {config,connection,programId};
}
export function initInstruction(ctx,creator,{nonce,soft,hard,deadline,launchDeadline}){const owner=new PublicKey(creator),campaign=campaignAddress(ctx.programId,owner,nonce);return new TransactionInstruction({programId:ctx.programId,keys:[{pubkey:owner,isSigner:true,isWritable:true},{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],data:Buffer.concat([Buffer.from([0]),...[nonce,soft,hard,deadline,launchDeadline].map(u64)])});}
export function commitInstruction(ctx,campaign,owner,amount,sequence){owner=new PublicKey(owner);campaign=new PublicKey(campaign);return new TransactionInstruction({programId:ctx.programId,keys:[{pubkey:owner,isSigner:true,isWritable:true},{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:receiptAddress(ctx.programId,campaign,owner),isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],data:Buffer.concat([Buffer.from([1]),u64(amount),u64(sequence)])});}
export function finalizeInstruction(ctx,campaign){return new TransactionInstruction({programId:ctx.programId,keys:[{pubkey:new PublicKey(campaign),isSigner:false,isWritable:true}],data:Buffer.from([2])});}
export function refundInstruction(ctx,campaign,owner,destination=owner){return new TransactionInstruction({programId:ctx.programId,keys:[{pubkey:new PublicKey(campaign),isSigner:false,isWritable:true},{pubkey:receiptAddress(ctx.programId,campaign,owner),isSigner:false,isWritable:true},{pubkey:new PublicKey(destination),isSigner:false,isWritable:true}],data:Buffer.from([3])});}
export async function readCampaign(ctx,address){
 const key=new PublicKey(address),info=await ctx.connection.getAccountInfo(key);if(!info||!info.owner.equals(ctx.programId)||info.data.length!==104||info.data.subarray(0,8).toString()!=='KIDSESC1')throw Error('Campaign account is invalid');
 const d=info.data,creator=new PublicKey(d.subarray(8,40)),nonce=d.readBigUInt64LE(40);
 if(!campaignAddress(ctx.programId,creator,nonce).equals(key))throw Error('Campaign address is invalid');
 return {address:key,creator,nonce,soft:d.readBigUInt64LE(48),hard:d.readBigUInt64LE(56),deadline:Number(d.readBigInt64LE(64)),launchDeadline:Number(d.readBigInt64LE(72)),total:d.readBigUInt64LE(80),refunded:d.readBigUInt64LE(88),phase:d[96],lamports:BigInt(info.lamports)};
}
export async function readReceipt(ctx,campaign,owner){
 const address=receiptAddress(ctx.programId,campaign,owner),info=await ctx.connection.getAccountInfo(address);
 if(!info||info.owner.equals(SystemProgram.programId)&&info.data.length===0)return {address,committed:0n,refunded:0n,sequence:0n};
 if(!info.owner.equals(ctx.programId)||info.data.length!==104||info.data.subarray(0,8).toString()!=='KIDSREC1'||!new PublicKey(info.data.subarray(8,40)).equals(new PublicKey(campaign))||!new PublicKey(info.data.subarray(40,72)).equals(new PublicKey(owner)))throw Error('Commitment account is invalid');
 return {address,committed:info.data.readBigUInt64LE(72),refunded:info.data.readBigUInt64LE(80),sequence:info.data.readBigUInt64LE(88)};
}
export function amounts(c,r,now){
 const closed=now>=c.deadline,failed=closed&&(c.total<c.soft||now>=c.launchDeadline&&c.phase!==3);
 const accepted=failed?0n:c.total>c.hard?r.committed*c.hard/c.total:r.committed;
 const entitled=closed?r.committed-accepted:0n;
 return {accepted,refundable:entitled>r.refunded?entitled-r.refunded:0n,failed,phase:failed?'failed':c.phase===3?'launched':closed?'awaiting-launch':'open'};
}
function activeManifest(ctx){const m=read(manifestPath);if(m.genesisHash!==ctx.config.genesisHash||m.programId!==ctx.programId.toBase58())throw Error('Campaign registry belongs to another ledger');return m;}
export async function prelaunchState(owner){
 if(LEGACY_OFF||!existsSync(manifestPath))return {configured:false};
 const ctx=await escrowContext(),manifest=activeManifest(ctx),c=await readCampaign(ctx,manifest.address),now=await chainTime(ctx.connection);
 // Terms are fixed on-chain. Registry metadata cannot silently change caps or deadlines.
 if(c.soft.toString()!==manifest.soft||c.hard.toString()!==manifest.hard||c.deadline!==manifest.deadline||c.launchDeadline!==manifest.launchDeadline)throw Error('Campaign terms differ from the published local plan');
 const r=owner?await readReceipt(ctx,c.address,owner):{committed:0n,refunded:0n,sequence:0n},a=amounts(c,r,now);
 return {configured:true,network:'localnet',genesisHash:ctx.config.genesisHash,programId:ctx.programId.toBase58(),escrowAddress:c.address.toBase58(),phase:a.phase,chainTimeUnix:now,deadlineUnix:c.deadline,launchDeadlineUnix:c.launchDeadline,totalLamports:c.total.toString(),softCapLamports:c.soft.toString(),hardCapLamports:c.hard.toString(),refundedLamports:c.refunded.toString(),poolSoftUsd:40000,poolHardUsd:200000,referenceSolUsd:200,explorerUrl:null,user:owner?{owner,committedLamports:r.committed.toString(),acceptedLamports:a.accepted.toString(),refundableLamports:a.refundable.toString(),refundedLamports:r.refunded.toString()}:null};
}
export async function provisionEscrow(){
 const ctx=await escrowContext(),admin=localKey('admin');if(admin.publicKey.toBase58()!==ctx.config.admin)throw Error('Wrong local administrator');
 let m;if(existsSync(manifestPath))m=activeManifest(ctx);else{
  const now=await chainTime(ctx.connection),nonce=BigInt('0x'+createHash('sha256').update(randomUUID()).digest('hex').slice(0,16));
  m={version:1,network:'localnet',programId:ctx.programId.toBase58(),genesisHash:ctx.config.genesisHash,creator:admin.publicKey.toBase58(),nonce:nonce.toString(),soft:'100000000000',hard:'500000000000',deadline:now+86400,launchDeadline:now+172800,poolSoftUsd:40000,poolHardUsd:200000,referenceSolUsd:200};m.address=campaignAddress(ctx.programId,admin.publicKey,nonce).toBase58();save(manifestPath,m);
 }
 const existing=await ctx.connection.getAccountInfo(new PublicKey(m.address));
 if(!existing||existing.owner.equals(SystemProgram.programId)&&existing.data.length===0){m.signature=await sendAndConfirmTransaction(ctx.connection,new Transaction().add(initInstruction(ctx,m.creator,m)),[admin],{commitment:'confirmed'});save(manifestPath,m);}
 return prelaunchState();
}
let intents=existsSync(intentPath)?read(intentPath):{};
function validateIntentIdentity(i,ctx){
 if(i.genesisHash!==ctx.config.genesisHash)throw Error('Prior request belongs to another ledger');
 const tx=Transaction.from(Buffer.from(i.unsignedTransactionBase64,'base64')),ix=tx.instructions[0],campaign=activeManifest(ctx).address;
 if(tx.instructions.length!==1||!ix.programId.equals(ctx.programId)||ix.keys[i.action==='commit'?1:0]?.pubkey.toBase58()!==campaign||tx.feePayer?.toBase58()!==i.owner)throw Error('Prior request belongs to another campaign or program');
}
const history=createIntentRetention({file:intentPath,service:'escrow',intents,persist:()=>save(intentPath,intents),isBusy:key=>sending.has(key),describe:async (i,key,memo)=>{
 const ctx=await memo('context',()=>escrowContext());validateIntentIdentity(i,ctx);
 
 const signature=i.confirmedSignature||i.submittedSignature||(i.signedTransactionBase64?encodeBase58(VersionedTransaction.deserialize(Buffer.from(i.signedTransactionBase64,'base64')).signatures[0]):null);
 return {connection:ctx.connection,signature,lastValidBlockHeight:i.block?.lastValidBlockHeight};
}});
const messageHash=tx=>createHash('sha256').update(tx.serializeMessage()).digest('hex');
let preparationQueue=Promise.resolve();
export function preparePrelaunch(owner,input){const action=preparationQueue.then(()=>preparePrelaunchInternal(owner,input));preparationQueue=action.catch(()=>{});return action;}
async function preparePrelaunchInternal(owner,input){
 if(!['commit','refund'].includes(input.action)||!/^[-a-zA-Z0-9]{16,80}$/.test(input.requestId||''))throw Error('Valid action and request ID required');
 const key=createHash('sha256').update(owner+':'+input.requestId).digest('hex');
 const descriptor=JSON.stringify({owner,action:input.action,amount:input.amountLamports||null});
 const prior=history.lookup(key);
 if(prior){
  const old=prior;if(old.descriptor!==descriptor)throw Error('Request ID already used for different terms');
  const ctx=await escrowContext();validateIntentIdentity(old,ctx);
  if(old.confirmedSignature)return publicIntent(old);
  escrowIntentRetry({proof:old.archivedProof});
  const signature=old.submittedSignature||(old.signedTransactionBase64?encodeBase58(VersionedTransaction.deserialize(Buffer.from(old.signedTransactionBase64,'base64')).signatures[0]):null);
  const status=signature?(await ctx.connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0]:null;
  if(status&&!status.err&&['confirmed','finalized'].includes(status.confirmationStatus)){old.confirmedSignature=signature;save(intentPath,intents);return publicIntent(old);}
  const finalizedExpired=!status&&await ctx.connection.getBlockHeight('finalized')>old.block.lastValidBlockHeight;
  if(escrowIntentRetry({proof:old.archivedProof,signature,status,finalizedExpired})!=='renew-failed')return publicIntent(old);
  // Only a conclusively failed signature permits rebuilding the same request ID.
  // Expired or pruned outcomes never silently acquire a new receipt sequence.
  intents[key+':attempt:'+old.createdAt+':'+randomUUID()]={...old,closedReason:'failed'};delete intents[key];save(intentPath,intents);
 }
 await history.compact();
 if(intentHistorySize(intents)>=10000)throw Error('Local transaction history is full; retain receipts before operator maintenance');
 const ctx=await escrowContext(),m=activeManifest(ctx),campaign=await readCampaign(ctx,m.address),receipt=await readReceipt(ctx,m.address,owner),now=await chainTime(ctx.connection);
 const localName=Object.keys(ctx.config.wallets).find(k=>ctx.config.wallets[k]===owner),local=['alice','bob'].includes(localName);
 let ix;
 if(input.action==='commit'){
  if(typeof input.amountLamports!=='string'||!/^\d{1,20}$/.test(input.amountLamports))throw Error('Lamports must be a positive integer');
  const amount=BigInt(input.amountLamports);if(amount<=0n||amount>18446744073709551615n)throw Error('Invalid commitment amount');
  if(now>=campaign.deadline||campaign.phase!==0)throw Error('Commitments are closed');
  ix=commitInstruction(ctx,m.address,owner,amount,receipt.sequence);
 }else{if(amounts(campaign,receipt,now).refundable<=0n)throw Error('No refund is available');ix=refundInstruction(ctx,m.address,owner);}
 const block=await ctx.connection.getLatestBlockhash('confirmed'),tx=new Transaction({feePayer:new PublicKey(owner),...block}).add(ix);
 const intent={intentId:key,descriptor,owner,action:input.action,local,localName:local?localName:null,genesisHash:ctx.config.genesisHash,createdAt:Date.now(),block,messageHash:messageHash(tx),unsignedTransactionBase64:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64')};
 intents[key]=intent;save(intentPath,intents);return publicIntent(intent);
}
function publicIntent(i){return {intentId:i.intentId,owner:i.owner,genesisHash:i.genesisHash,local:i.local,unsignedTransactionBase64:i.unsignedTransactionBase64};}
const sending=new Map();
export async function submitPrelaunch(owner,input){
 const intent=history.lookup(input.intentId);if(!intent||intent.owner!==owner)throw Error('Transaction belongs to another wallet or is unavailable');
 if(sending.has(intent.intentId))return sending.get(intent.intentId);
 const action=(async()=>{
  const ctx=await escrowContext();validateIntentIdentity(intent,ctx);
  if(intent.archivedProof&&intent.archivedProof.kind!=='finalized-success')throw Error('Previous transaction failed or expired; prepare a new request');
  if(intent.confirmedSignature)return {signature:intent.confirmedSignature,state:await prelaunchState(owner)};
  if(intent.submittedSignature){const status=(await ctx.connection.getSignatureStatuses([intent.submittedSignature],{searchTransactionHistory:true})).value[0];if(status?.err)throw Error('Previous transaction failed: '+JSON.stringify(status.err));if(status&&['confirmed','finalized'].includes(status.confirmationStatus)){intent.confirmedSignature=intent.submittedSignature;save(intentPath,intents);return {signature:intent.confirmedSignature,state:await prelaunchState(owner)};}}
  let tx;
  if(intent.signedTransactionBase64)tx=VersionedTransaction.deserialize(Buffer.from(intent.signedTransactionBase64,'base64'));
  else{
   if(Date.now()-intent.createdAt>180000)throw Error('Transaction expired. Start a new request after refreshing escrow');
   if(input.local===true){if(!intent.local)throw Error('External wallets must sign their own transaction');tx=Transaction.from(Buffer.from(intent.unsignedTransactionBase64,'base64'));const signer=localKey(intent.localName);if(signer.publicKey.toBase58()!==owner)throw Error('Local identity changed');tx.sign(signer);tx=VersionedTransaction.deserialize(tx.serialize());}
   else{if(typeof input.signedTransactionBase64!=='string'||input.signedTransactionBase64.length>6000)throw Error('Signed transaction required');tx=VersionedTransaction.deserialize(Buffer.from(input.signedTransactionBase64,'base64'));}
   const approved=VersionedTransaction.deserialize(Buffer.from(intent.unsignedTransactionBase64,'base64'));
   validateApprovedMessage(tx.message,approved.message);
   if(tx.message.header.numRequiredSignatures!==1||tx.message.staticAccountKeys[0].toBase58()!==owner||!verifySignature(owner,tx.message.serialize(),tx.signatures[0]))throw Error('Invalid escrow transaction signature');
   intent.signedTransactionBase64=Buffer.from(tx.serialize()).toString('base64');intent.submittedSignature=encodeBase58(tx.signatures[0]);save(intentPath,intents);
  }
  // Retry persistence too: an earlier failed fsync may have left signed bytes only in memory.
  save(intentPath,intents);
  // Identical signed bytes are retried, never rebuilt after an ambiguous send.
  const signature=await ctx.connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});
  intent.submittedSignature=signature;save(intentPath,intents);
  const result=await ctx.connection.confirmTransaction({...intent.block,signature},'confirmed');if(result.value.err)throw Error('Escrow transaction rejected: '+JSON.stringify(result.value.err));
  intent.confirmedSignature=signature;save(intentPath,intents);
  return {signature,state:await prelaunchState(owner)};
 })();sending.set(intent.intentId,action);try{return await action;}finally{sending.delete(intent.intentId);}
}
export async function runRefundKeeper(){
 if(LEGACY_OFF)return {status:'off'};
 if(!existsSync(manifestPath))return {processed:0};const ctx=await escrowContext(),m=activeManifest(ctx),c=await readCampaign(ctx,m.address),now=await chainTime(ctx.connection);
 if(now<c.deadline)return {processed:0};const admin=localKey('admin');if(admin.publicKey.toBase58()!==ctx.config.admin)throw Error('Keeper identity mismatch');
 if(c.phase===0||now>=c.launchDeadline&&c.phase===1)await sendAndConfirmTransaction(ctx.connection,new Transaction().add(finalizeInstruction(ctx,m.address)),[admin],{commitment:'confirmed'});
 const rows=await ctx.connection.getProgramAccounts(ctx.programId,{filters:[{dataSize:104},{memcmp:{offset:8,bytes:m.address}}]});let processed=0;
 for(const row of rows){if(row.account.data.subarray(0,8).toString()!=='KIDSREC1')continue;const owner=new PublicKey(row.account.data.subarray(40,72)),r=await readReceipt(ctx,m.address,owner);if(amounts(c,r,now).refundable>0n){await sendAndConfirmTransaction(ctx.connection,new Transaction().add(refundInstruction(ctx,m.address,owner)),[admin],{commitment:'confirmed'});processed++;}}
 return {processed};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await provisionEscrow(),null,2));
/** Startup reconciliation (docs/ENGINEERING-RULES.md): classify every finalized outcome against the chain before writes reopen. */
export async function reconcile(){if(LEGACY_OFF)return {service:'escrow',hot:0,signed:0,unresolvedSigned:0,off:true};await history.compact();return summarizeIntents('escrow',intents,'confirmedSignature');}
