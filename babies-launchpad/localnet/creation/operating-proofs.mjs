// Read-only finalized-chain proof boundary for campaign operating accounting.
// Callers supply durable, reviewed packet loaders, never client-supplied receipts.
// This does not select the funding policy, sign, send or activate any worker.
import {PublicKey,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {canonicalHash} from '../registry/canonical.mjs';
import {verifySignature,encodeBase58} from '../../shared/solana.mjs';
import {packetStatus} from '../protocol-v2/durable-send.mjs';
import {operatingCostModel,reconcileOperatingCost,packetAccountKeys} from './operating-costs.mjs';
import {resolvePinnedLookups} from '../signer/lookup-resolution.mjs';
const MEMO=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const fields=['genesisHash','programId','campaign','payer','policy'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const decimal=n=>{if(!Number.isSafeInteger(n)||n<0)throw Error('RPC balance or fee is not an exact safe integer');return BigInt(n);};
function fundingTerms(x){
 for(const k of ['genesisHash','programId','campaign','payer','creator'])if(new PublicKey(x[k]).toBase58()!==x[k])throw Error('Invalid funding identity');
 if(x.creator===x.payer||!/^[A-Za-z0-9_.:-]{1,128}$/.test(x.policy??'')||typeof x.lamports!=='string'||!/^[1-9][0-9]{0,15}$/.test(x.lamports)||BigInt(x.lamports)>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid operating funding terms');
 return Object.fromEntries([...fields,'creator','lamports'].map(k=>[k,x[k]]));
}
export function buildOperatingFundingPacket(intent,block){
 const terms=fundingTerms(intent),creator=new PublicKey(terms.creator);
 if(!Number.isSafeInteger(block?.lastValidBlockHeight)||block.lastValidBlockHeight<1||new PublicKey(block.blockhash).toBase58()!==block.blockhash)throw Error('Invalid funding block');
 return new VersionedTransaction(new TransactionMessage({payerKey:creator,recentBlockhash:block.blockhash,instructions:[
  SystemProgram.transfer({fromPubkey:creator,toPubkey:new PublicKey(terms.payer),lamports:BigInt(terms.lamports)}),
  new TransactionInstruction({programId:MEMO,keys:[],data:Buffer.from('KIDS operating:'+canonicalHash(terms))}),
 ]}).compileToV0Message());
}
function approved(row){
 if(typeof row?.transactionBase64!=='string'||row.transactionBase64.length>1644)throw Error('Durable signed packet unavailable');
 const raw=Buffer.from(row.transactionBase64,'base64'),tx=VersionedTransaction.deserialize(raw),bytes=tx.message.serialize();
 if(raw.toString('base64')!==row.transactionBase64||!Buffer.from(tx.serialize()).equals(raw)||raw.length>1232||tx.version!==0||(row.block?.lookups==null&&tx.message.addressTableLookups.length)||!Number.isSafeInteger(row.block?.lastValidBlockHeight)||row.block.lastValidBlockHeight<1||row.block.blockhash!==tx.message.recentBlockhash)throw Error('Unsupported operating packet');
 if(tx.signatures.length!==tx.message.header.numRequiredSignatures||encodeBase58(tx.signatures[0])!==row.signature||tx.signatures.some((s,i)=>!verifySignature(tx.message.staticAccountKeys[i].toBase58(),bytes,s)))throw Error('Invalid durable operating signature');
 // A lookup-table packet resolves only through the resolution pinned into its durable block (signer/lookup-resolution.mjs).
 const tables=row.block?.lookups!=null?resolvePinnedLookups(tx.message,row.block.lookups).tables:[];
 return {tx,bytes,messageHash:hash(bytes),tables};
}
function landed(reply,row,packet){
 if(!reply?.meta||!Number.isSafeInteger(reply.slot)||reply.slot<1||!Buffer.from(reply.transaction?.message?.serialize()??[]).equals(Buffer.from(packet.bytes))||reply.transaction.signatures?.length!==packet.tx.signatures.length||reply.transaction.signatures.some((s,i)=>s!==encodeBase58(packet.tx.signatures[i])))throw Error('Finalized transaction differs from its signed packet');
 if(!Object.hasOwn(reply.meta,'err')||(reply.meta.err!==null&&!(typeof reply.meta.err==='string'&&reply.meta.err.length)&&!(reply.meta.err&&typeof reply.meta.err==='object'&&!Array.isArray(reply.meta.err))))throw Error('Finalized execution status unavailable');
 const pre=reply.meta.preBalances,post=reply.meta.postBalances;
 // Balances cover the complete loaded key list (static, lookup writable, lookup readonly); for a lookup-table packet the
 // ledger's loaded addresses must be exactly the pinned resolution in that order.
 const keys=packetAccountKeys(packet);
 if(!Array.isArray(pre)||!Array.isArray(post)||pre.length!==keys.length||post.length!==pre.length)throw Error('Finalized balance evidence unavailable');
 if(packet.tables.length){
  const resolved=packet.tx.message.getAccountKeys({addressLookupTableAccounts:packet.tables}).accountKeysFromLookups,loaded=reply.meta.loadedAddresses;
  const same=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((k,i)=>String(k)===String(b[i]));
  if(!loaded||!same(loaded.writable,resolved.writable)||!same(loaded.readonly,resolved.readonly))throw Error('Landed lookup addresses differ from the pinned resolution');
 }
 for(const n of [...pre,...post])decimal(n);decimal(reply.meta.fee);
 return {pre,post,fee:BigInt(reply.meta.fee)};
}
export function createOperatingProofReader({connection,genesisHash,loadFundingPacket,loadSpendPacket,timeoutMs=12000,treasury=null}){
 // The pinned platform treasury a fee-setup cost row is checked against; the outcome reader carries it, never the payer.
 const platformTreasury=treasury==null?null:new PublicKey(treasury).toBase58();
 if(new PublicKey(genesisHash).toBase58()!==genesisHash||typeof loadFundingPacket!=='function'||typeof loadSpendPacket!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw Error('Pinned ledger and durable packet readers required');
 async function bounded(fn){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Operating proof read timed out')),timeoutMs);})]);}finally{clearTimeout(timer);}}
 const rpc=new Proxy(connection,{get(target,key){const value=target[key];return typeof value==='function'?(...args)=>bounded(()=>value.apply(target,args)):value;}});
 async function network(x){if(x.genesisHash!==genesisHash||await rpc.getGenesisHash()!==genesisHash)throw Error('Operating proof ledger changed');}
 const bound=(x,row)=>{if(!row?.binding||fields.some(k=>row.binding[k]!==x[k]))throw Error('Operating packet belongs to another budget');};
 return {
  async verifyFunding(input){
   const x=structuredClone(input);await network(x);const row=await bounded(()=>loadFundingPacket(x));bound(x,row);if(row.signature!==x.signature)throw Error('Funding signature changed');
   const terms=fundingTerms(row.binding),packet=approved(row),creation=row.kind==='creation';
   if(creation){
    // One creation transaction (28 September 2026): the reserve transfer rides in the creation packet. The packet itself
    // was proven by the mint journal; here the exact system transfer creator to payer for the sealed amount must be in it.
    const keys=packet.tx.message.staticAccountKeys.map(k=>k.toBase58()),payerIndex=keys.indexOf(terms.payer),systemIndex=keys.indexOf(SystemProgram.programId.toBase58());
    const transfer=ix=>{const d=Buffer.from(ix.data);return ix.programIdIndex===systemIndex&&ix.accountKeyIndexes.length===2&&ix.accountKeyIndexes[0]===0&&ix.accountKeyIndexes[1]===payerIndex&&d.length===12&&d.readUInt32LE(0)===2&&d.readBigUInt64LE(4)===BigInt(terms.lamports);};
    if(keys[0]!==terms.creator||payerIndex<1||systemIndex<0||packet.tx.message.compiledInstructions.filter(transfer).length!==1)throw Error('Creation packet carries no matching reserve transfer');
   }else{
    const expected=buildOperatingFundingPacket(terms,row.block);
    if(!Buffer.from(expected.message.serialize()).equals(Buffer.from(packet.bytes)))throw Error('Funding packet does not match the reviewed transfer');
   }
   const reply=await rpc.getTransaction(row.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!reply)throw Error('Funding transaction is not finalized or history is unavailable');
   const {pre,post,fee}=landed(reply,row,packet);if(reply.meta.err!==null)throw Error('Funding transaction failed');
   const index=packet.tx.message.staticAccountKeys.findIndex(k=>k.toBase58()===x.payer),n=BigInt(terms.lamports);
   if(index<1||BigInt(post[index])-BigInt(pre[index])!==n||(!creation&&BigInt(pre[0])-BigInt(post[0])!==n+fee))throw Error('Funding balances do not reconcile');
   await network(x);return {...Object.fromEntries(fields.map(k=>[k,x[k]])),signature:row.signature,source:terms.creator,lamports:terms.lamports,finalized:true,slot:reply.slot,messageHash:packet.messageHash};
  },
  async verifyOutcome(input){
   const x=structuredClone(input);await network(x);const row=await bounded(()=>loadSpendPacket(x));bound(x,row);const packet=approved(row);
   if(row.operationId!==x.operationId||packet.messageHash!==x.messageHash||row.maximumLamports!==x.maximumLamports||packet.tx.message.staticAccountKeys[0].toBase58()!==x.payer)throw Error('Spend packet differs from its held exposure');
   const costModel=operatingCostModel(row,packet,platformTreasury?{...x,treasury:platformTreasury}:x);
   const reply=await rpc.getTransaction(row.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
   const base={...Object.fromEntries(fields.map(k=>[k,x[k]])),operationId:x.operationId,messageHash:x.messageHash};
   if(reply){
    const evidence=landed(reply,row,packet),spent=reconcileOperatingCost(costModel,{...evidence,failed:reply.meta.err!==null});
    if(spent>BigInt(x.maximumLamports))throw Error('Operating cost does not reconcile within its reserve');
    await network(x);return {...base,status:'finalized',signature:row.signature,slot:reply.slot,actualLamports:String(spent),executionFailed:reply.meta.err!==null,...(costModel.kind==='v3-operating-return'?{returnedLamports:String(reply.meta.err===null?costModel.returnLamports:0n)}:{})};
   }
   let expirySlot=null;const status=await packetStatus({getSignatureStatuses:(...args)=>rpc.getSignatureStatuses(...args),getFirstAvailableBlock:()=>rpc.getFirstAvailableBlock(),getEpochInfo:async(...args)=>{const r=await rpc.getEpochInfo(...args);expirySlot=r.absoluteSlot;return r;}},row.signature,row.block);
   await network(x);
   if(status.status!=='expired'||!Number.isSafeInteger(expirySlot)||expirySlot<1)return {status:'unknown'};
   return {...base,status:'expired',slot:expirySlot,actualLamports:'0',lastValidBlockHeight:row.block.lastValidBlockHeight,finalizedBlockHeight:status.blockHeight};
  },
 };
}
