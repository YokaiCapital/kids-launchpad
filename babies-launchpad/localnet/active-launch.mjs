import {escrowIntentRetry} from './escrow-intent-retry.mjs';
import {acceptedProgramHash} from './program-lineage.mjs';
import {createIntentRetention,intentHistorySize,summarizeIntents} from '../shared/intent-retention.mjs';
import {reconcileSignedIntents} from './chain-reconcile.mjs';
import {createOperatorSender} from './operator-journal.mjs';
import {operatorSigner} from './operator-signer.mjs';
import {writeDurableJson} from '../shared/durable-json.mjs';
// Long-lived v3 localnet service. Isolated from the public v1 campaign and API.
// Transaction intent lifecycle reused from escrow.mjs: exact-message binding,
// persisted signed bytes, and same-ID renewal only after definitive finalized failure.
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {PublicKey,Transaction,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {atomicContext,readCampaign,receiptAddress,commitInstruction,refundInstruction,finalizeInstruction,settleInstruction,PROFILE} from './atomic-launch.mjs';
import {explorerLink,scopeFor} from './network.mjs';
import {singleFlight} from '../shared/single-flight.mjs';
import {validateApprovedMessage} from '../shared/approved-message.mjs';
import {verifySignature} from '../shared/solana.mjs';
import {encodeBase58} from '../shared/solana.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
const runtime=fileURLToPath(new URL('./.runtime/',import.meta.url));
export const activeManifestPath=runtime+'active-launch.json';
const manifestPath=activeManifestPath,intentPath=runtime+'active-launch-intents.json';
export const saveActiveFile=writeDurableJson;
const save=saveActiveFile,read=path=>JSON.parse(readFileSync(path,'utf8'));
export const MAX_HARD_CAP_LAMPORTS=500000000000n,ACTIVE_SUPPLY='1000000000000000',LAUNCH_WINDOW_SECONDS=86400,REFERENCE_SOL_USD=200;
const lamportsField=v=>typeof v==='string'&&/^\d{1,20}$/.test(v)?BigInt(v):null;
/** Soft and hard caps come from the manifest (test terms are configurable); the supply, the 24-hour launch window and the 500 SOL ceiling are fixed. */
export function validCampaignTerms(m){const soft=lamportsField(m.soft),hard=lamportsField(m.hard);return soft!==null&&hard!==null&&soft>0n&&soft<=hard&&hard<=MAX_HARD_CAP_LAMPORTS&&m.supply===ACTIVE_SUPPLY&&Number.isSafeInteger(m.deadline)&&Number.isSafeInteger(m.launchDeadline)&&m.launchDeadline-m.deadline===LAUNCH_WINDOW_SECONDS;}
const poolUsd=lamports=>Number(lamports)/1e9*REFERENCE_SOL_USD*2;
export function validateActiveManifest(ctx,m){
 if(m.network!==PROFILE.network||m.rpcUrl!==PROFILE.rpcLabel||m.genesisHash!==ctx.manifest.genesisHash||m.programId!==ctx.programId.toBase58()||!acceptedProgramHash(ctx.manifest,m.programSha256))throw Error('Active campaign ledger or program changed');
 if(!validCampaignTerms(m))throw Error('Active campaign economics mismatch');
 return m;
}
export async function activeContext(){const ctx=await atomicContext();const wallets=PROFILE.network==='localnet'?Object.fromEntries(['alice','bob'].map(name=>[name,localKey(name).publicKey.toBase58()])):{};return {...ctx,config:{genesisHash:ctx.manifest.genesisHash,wallets}};}
export function activeManifest(ctx){const m=validateActiveManifest(ctx,read(manifestPath));if(m.ready!==true)throw Error('Active campaign provisioning is incomplete');return m;}
export function validateActiveTerms(c,m){
 if(c.soft.toString()!==m.soft||c.hard.toString()!==m.hard||c.deadline!==m.deadline||c.launchDeadline!==m.launchDeadline||c.mint.toBase58()!==m.mint||c.supply.toString()!==m.supply||c.dev.toBase58()!==m.dev||c.treasury.toBase58()!==m.treasury||c.creator.toBase58()!==m.creator)throw Error('Active campaign terms differ from registry');
}
export async function readActiveReceipt(ctx,campaign,owner){
 const address=receiptAddress(ctx.programId,campaign,owner),info=await ctx.connection.getAccountInfo(address);
 if(!info||info.owner.equals(SystemProgram.programId)&&info.data.length===0)return {address,committed:0n,refunded:0n,sequence:0n,settled:false,accepted:0n,claimed:false};
 const d=info.data;if(!info.owner.equals(ctx.programId)||d.length!==112||d.subarray(0,8).toString()!=='KIDSREC3'||!new PublicKey(d.subarray(8,40)).equals(new PublicKey(campaign))||!new PublicKey(d.subarray(40,72)).equals(new PublicKey(owner)))throw Error('Invalid active commitment receipt');
 return {address,committed:d.readBigUInt64LE(72),refunded:d.readBigUInt64LE(80),sequence:d.readBigUInt64LE(88),settled:d[97]===1,accepted:d.readBigUInt64LE(104),claimed:d[98]===1};
}
export function activeAmounts(c,r,now){
 const closed=now>=c.deadline,failed=closed&&(c.total<c.soft||now>=c.launchDeadline&&c.phase!==3);
 const accepted=failed?0n:r.settled?r.accepted:c.total>c.hard?r.committed*c.hard/c.total:r.committed;
 const entitled=closed?r.committed-accepted:0n;
 return {accepted,refundable:entitled>r.refunded?entitled-r.refunded:0n,failed,phase:failed?'failed':c.phase===3?'launched':closed?'awaiting-launch':'open'};
}
/** Planned next launch (no campaign yet): deployment/<network>/launch-schedule.json, owner-edited, public data. */
export function readLaunchSchedule(network=PROFILE.network){
 const path=fileURLToPath(new URL('../deployment/'+network+'/launch-schedule.json',import.meta.url));if(!existsSync(path))return null;
 try{const j=JSON.parse(readFileSync(path,'utf8'));const opensAt=typeof j.opensAt==='string'&&!Number.isNaN(Date.parse(j.opensAt))?j.opensAt:null;return {coin:j.coin||'Shartcoin',opensAt,opensAtUnix:opensAt?Math.floor(Date.parse(opensAt)/1000):null,terms:{soft:String(j.soft||'100000000000'),hard:String(j.hard||'500000000000'),deadlineSeconds:Number(j.deadlineSeconds||86400)},note:typeof j.note==='string'?j.note.slice(0,200):null};}catch{return null;}
}
/** Public campaign state shared by every poll for PUBLIC_READ_TTL_MS; wallet receipts are read per owner and never cached. */
export const PUBLIC_READ_TTL_MS=2000;
export function createPublicCampaignRead(load,{ttlMs=PUBLIC_READ_TTL_MS,now=Date.now}={}){return singleFlight(load,{ttlMs,now});}
async function loadPublicCampaign(){
 const ctx=await activeContext(),m=activeManifest(ctx),c=await readCampaign(ctx,m.address);validateActiveTerms(c,m);
 const info=await ctx.connection.getAccountInfo(c.address);if(info.data[98]!==1)throw Error('Parent snapshots must be configured');
 const now=await chainTime(ctx.connection);return {ctx,m,c,now};
}
const publicCampaign=createPublicCampaignRead(loadPublicCampaign);
export async function readActive(owner){
 if(!existsSync(manifestPath))return {configured:false,network:PROFILE.network,next:readLaunchSchedule(),chainTimeUnix:Math.floor(Date.now()/1000)};
 const {ctx,m,c,now}=await publicCampaign();
 const r=owner?await readActiveReceipt(ctx,c.address,owner):{committed:0n,refunded:0n,sequence:0n},a=activeAmounts(c,r,now);
 return {configured:true,network:PROFILE.network,version:3,scope:scopeFor(PROFILE),next:readLaunchSchedule(),genesisHash:ctx.manifest.genesisHash,programId:ctx.programId.toBase58(),escrowAddress:m.address,mint:m.mint,phase:a.phase,chainTimeUnix:now,deadlineUnix:c.deadline,launchDeadlineUnix:c.launchDeadline,totalLamports:c.total.toString(),softCapLamports:c.soft.toString(),hardCapLamports:c.hard.toString(),refundedLamports:c.refunded.toString(),settledAcceptedLamports:c.settledAccepted.toString(),receiptCount:c.receiptCount.toString(),settledReceiptCount:c.settledReceiptCount.toString(),poolSoftUsd:poolUsd(c.soft),poolHardUsd:poolUsd(c.hard),referenceSolUsd:REFERENCE_SOL_USD,explorerUrl:PROFILE.explorerUrl,explorerCluster:PROFILE.explorerCluster,mintExplorerUrl:explorerLink(PROFILE,'token',m.mint),pool:c.phase===3?c.pool.toBase58():null,user:owner?{owner,committedLamports:r.committed.toString(),acceptedLamports:a.accepted.toString(),refundableLamports:a.refundable.toString(),refundedLamports:r.refunded.toString(),settled:r.settled}:null};
}
let intents=existsSync(intentPath)?read(intentPath):{};
const history=createIntentRetention({file:intentPath,service:'active-launch',intents,persist:()=>save(intentPath,intents),isBusy:key=>sending.has(key),describe:async (i,key,memo)=>{
 const ctx=await memo('context',()=>activeContext());if(i.genesisHash!==ctx.config.genesisHash)return null;
 if(i.programId!==ctx.programId.toBase58()||i.campaign!==activeManifest(ctx).address)return null;
 const signature=i.confirmedSignature||i.submittedSignature||(i.signedTransactionBase64?encodeBase58(VersionedTransaction.deserialize(Buffer.from(i.signedTransactionBase64,'base64')).signatures[0]):null);
 return {connection:ctx.connection,signature,lastValidBlockHeight:i.block?.lastValidBlockHeight};
}});
const messageHash=tx=>createHash('sha256').update(tx.serializeMessage()).digest('hex');
let preparationQueue=Promise.resolve();
export function prepareActive(owner,input){const action=preparationQueue.then(()=>prepareActiveInternal(owner,input));preparationQueue=action.catch(()=>{});return action;}
async function prepareActiveInternal(owner,input){
 if(!['commit','refund'].includes(input.action)||!/^[-a-zA-Z0-9]{16,80}$/.test(input.requestId||''))throw Error('Valid action and request ID required');
 const key=createHash('sha256').update(owner+':'+input.requestId).digest('hex');
 const descriptor=JSON.stringify({owner,action:input.action,amount:input.amountLamports||null});
 const prior=history.lookup(key);
 if(prior){
  const old=prior;if(old.descriptor!==descriptor)throw Error('Request ID already used for different terms');
  const ctx=await activeContext();
  if(old.campaign!==activeManifest(ctx).address)throw Error('Prior request belongs to another campaign');
  if(old.genesisHash!==ctx.config.genesisHash)throw Error('Prior request belongs to another ledger');
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
 const ctx=await activeContext(),m=activeManifest(ctx),campaign=await readCampaign(ctx,m.address),receipt=await readActiveReceipt(ctx,m.address,owner),now=await chainTime(ctx.connection);
 validateActiveTerms(campaign,m);
 const localName=Object.keys(ctx.config.wallets).find(k=>ctx.config.wallets[k]===owner),local=['alice','bob'].includes(localName);
 let ix;
 if(input.action==='commit'){
  if(typeof input.amountLamports!=='string'||!/^\d{1,20}$/.test(input.amountLamports))throw Error('Lamports must be a positive integer');
  const amount=BigInt(input.amountLamports);if(amount<=0n||amount>18446744073709551615n)throw Error('Invalid commitment amount');
  if(now>=campaign.deadline||campaign.phase!==0)throw Error('Commitments are closed');
  await topUpLocalnetWallet(ctx,m,owner,amount);
  ix=commitInstruction(ctx,m.address,owner,amount,receipt.sequence);
 }else{if(activeAmounts(campaign,receipt,now).refundable<=0n)throw Error('No refund is available');ix=refundInstruction(ctx,m.address,owner);}
 const block=await ctx.connection.getLatestBlockhash('confirmed'),tx=new Transaction({feePayer:new PublicKey(owner),...block}).add(ix);
 const intent={campaign:m.address,programId:ctx.programId.toBase58(),intentId:key,descriptor,owner,action:input.action,local,localName:local?localName:null,genesisHash:ctx.config.genesisHash,createdAt:Date.now(),block,messageHash:messageHash(tx),unsignedTransactionBase64:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64')};
 intents[key]=intent;save(intentPath,intents);return publicIntent(intent);
}
/** Private localnet only: the manifest pins the loopback test validator, which has a faucet. A wallet that cannot
 * cover its commitment plus fees is topped up before the unsigned transaction is built, so a human can test the real
 * wallet flow on the hosted test ledger. KIDS_LOCALNET_FAUCET=0 turns it off. Never reached for any other rpcUrl. */
export const LOCALNET_FAUCET_RPC='http://127.0.0.1:19099';
async function topUpLocalnetWallet(ctx,m,owner,amount){
 if(m.rpcUrl!==LOCALNET_FAUCET_RPC||m.network!=='localnet'||process.env.KIDS_LOCALNET_FAUCET==='0')return null;
 const c=ctx.connection,wallet=new PublicKey(owner),needed=amount+10000000n,balance=BigInt(await c.getBalance(wallet,'confirmed'));if(balance>=needed)return null;
 const grant=needed-balance+1000000000n;if(grant>5000000000000n)throw Error('Commitment exceeds the localnet test faucet');
 const signature=await c.requestAirdrop(wallet,Number(grant)),block=await c.getLatestBlockhash('confirmed');
 await c.confirmTransaction({signature,...block},'confirmed');console.log(JSON.stringify({event:'localnet-faucet',owner,lamports:grant.toString(),signature}));return signature;
}
function publicIntent(i){return {intentId:i.intentId,owner:i.owner,campaign:i.campaign,programId:i.programId,genesisHash:i.genesisHash,local:i.local,unsignedTransactionBase64:i.unsignedTransactionBase64};}
const sending=new Map();
export async function submitActive(owner,input){
 const intent=history.lookup(input.intentId);if(!intent||intent.owner!==owner)throw Error('Transaction belongs to another wallet or is unavailable');
 if(sending.has(intent.intentId))return sending.get(intent.intentId);
 const action=(async()=>{
  const ctx=await activeContext();if(intent.campaign!==activeManifest(ctx).address||intent.programId!==ctx.programId.toBase58())throw Error('Transaction belongs to another campaign');if(intent.genesisHash!==ctx.config.genesisHash)throw Error('Transaction belongs to another ledger');
  if(intent.archivedProof&&intent.archivedProof.kind!=='finalized-success')throw Error('Previous transaction failed or expired; prepare a new request');
  if(intent.confirmedSignature)return {signature:intent.confirmedSignature,state:await readActive(owner)};
  if(intent.submittedSignature){const status=(await ctx.connection.getSignatureStatuses([intent.submittedSignature],{searchTransactionHistory:true})).value[0];if(status?.err)throw Error('Previous transaction failed: '+JSON.stringify(status.err));if(status&&['confirmed','finalized'].includes(status.confirmationStatus)){intent.confirmedSignature=intent.submittedSignature;save(intentPath,intents);return {signature:intent.confirmedSignature,state:await readActive(owner)};}}
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
  return {signature,state:await readActive(owner)};
 })();sending.set(intent.intentId,action);try{return await action;}finally{sending.delete(intent.intentId);}
}

let settlementPending;
export function settleActive(){
 if(settlementPending)return settlementPending;
 settlementPending=settleActiveInternal().finally(()=>{settlementPending=null;});return settlementPending;
}
async function settleActiveInternal(){
 const ctx=await activeContext(),m=activeManifest(ctx),admin=await operatorSigner(),c=await readCampaign(ctx,m.address);validateActiveTerms(c,m);
 const now=await chainTime(ctx.connection);if(now<c.deadline)throw Error('Funding is still open');
 const path=runtime+'active-settlement-operator.json';
 const journal=existsSync(path)?read(path):{campaign:m.address,genesisHash:m.genesisHash,programSha256:m.programSha256,attempts:{}};
 if(journal.campaign!==m.address||journal.genesisHash!==m.genesisHash||!acceptedProgramHash(ctx.manifest,journal.programSha256))throw Error('Settlement journal identity mismatch');
 const sender=createOperatorSender({connection:ctx.connection,journal,persist:()=>save(path,journal)});
 const send=(ix,stage='')=>sender(createHash('sha256').update(Buffer.concat([ix.data,...ix.keys.map(k=>k.pubkey.toBuffer())])).update(':phase:'+c.phase+':'+stage).digest('hex'),async(block,operationId)=>{const tx=new Transaction({feePayer:admin.publicKey,...block}).add(ix);await admin.sign(tx,{operationId});return tx;});
 if(c.phase===0||now>=c.launchDeadline&&c.phase===1)await send(finalizeInstruction(ctx,m.address));
 const rows=await ctx.connection.getProgramAccounts(ctx.programId,{filters:[{dataSize:112},{memcmp:{offset:8,bytes:m.address}}]});let settled=0,refunded=0;
 for(const row of rows){if(row.account.data.subarray(0,8).toString()!=='KIDSREC3')throw Error('Unexpected registered receipt');const owner=new PublicKey(row.account.data.subarray(40,72));let r=await readActiveReceipt(ctx,m.address,owner);if(!r.settled){await send(settleInstruction(ctx,m.address,owner));settled++;}r=await readActiveReceipt(ctx,m.address,owner);if(activeAmounts(c,r,await chainTime(ctx.connection)).refundable>0n){await send(refundInstruction(ctx,m.address,owner),'refunded:'+r.refunded);refunded++;}}
 return {settled,refunded,state:await readActive()};
}
/** Startup reconciliation (docs/ENGINEERING-RULES.md): classify every finalized outcome against the chain before writes reopen. */
export async function reconcile(){
 if(!existsSync(manifestPath))return {service:'active-launch',hot:intentHistorySize(intents),signed:0,checked:0,unresolvedSigned:0,complete:true};
 const ctx=await activeContext();const summary=await reconcileSignedIntents({service:'active-launch',intents,connection:ctx.connection,successField:'confirmedSignature',persist:()=>save(intentPath,intents)});await history.compact();return summary;
}
