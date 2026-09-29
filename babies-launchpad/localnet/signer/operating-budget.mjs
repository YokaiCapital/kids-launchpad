// Mandatory funding boundary for an explicitly composed v3 registry signer.
// Reuses the durable packet journal; it never receives the signer private key.
// No hosted policy, payment endpoint or worker activation is selected here.
import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {encodeBase58,verifySignature} from '../../shared/solana.mjs';
import {operatingCostModel} from '../creation/operating-costs.mjs';
import {createOperatingProofReader} from '../creation/operating-proofs.mjs';
import {createOperatingLedger} from '../creation/operating-ledger.mjs';
import {resolvePinnedLookups} from './lookup-resolution.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const key=x=>new PublicKey(x).toBase58();
const budgetId=x=>canonicalHash({role:'v3-operating-budget',genesisHash:x.genesisHash,programId:x.programId,campaign:x.campaign,payer:x.payer,operationId:x.operationId});
export function createOperatingSignerBudget({registry,connection,genesisHash,programId,payer,policy,loadFundingPacket,loadCostIntent,timeoutMs=10000,treasury=null}){
 if(registry?.driver!=='postgres'||!registry.operatorPackets||typeof loadFundingPacket!=='function'||typeof loadCostIntent!=='function'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(policy??''))throw Error('Qualified funding policy and reviewed packet readers required');
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw Error('Invalid operating budget timeout');
 const pinned={genesisHash:key(genesisHash),programId:key(programId),payer:key(payer),policy};
 // The sealed platform treasury of the campaigns this budget serves (the release's, on a hosted signer); the payer is the keeper.
 const platformTreasury=key(treasury??payer);
 // A registry or RPC failure inside a bounded call is a dependency outcome (possibly unresolved), never a deterministic refusal.
 // The tag is added to the thrown value when it accepts one; a string, a frozen error or any value that cannot carry it is wrapped.
 const dependent=(error,kind)=>{try{if(error&&typeof error==='object'){if(error.code==='CAPACITY_WAIT'||error.code==='OPERATING_COST_REFUSED')return error;if(!error.dependency)error.dependency=kind;if(error.dependency)return error;}}catch{}return Object.assign(Error('Operating signer dependency failed'),{dependency:kind,cause:error});};
 async function bounded(fn){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(dependent(Error('Operating signer dependency timed out'),'timeout')),timeoutMs);})]);}catch(error){throw dependent(error,'failure');}finally{clearTimeout(timer);}}
 const rpc=new Proxy(connection,{get(target,k){const value=target[k];return typeof value==='function'?(...args)=>bounded(()=>value.apply(target,args)):value;}});
 const scope=input=>{for(const k of Object.keys(pinned))if(input[k]!==pinned[k])throw Error('Operating signer scope changed');if(key(input.campaign)!==input.campaign)throw Error('Invalid operating campaign');};
 async function network(){if(await rpc.getGenesisHash()!==pinned.genesisHash)throw Error('Operating signer ledger changed');}
 function packet(row){
  const raw=Buffer.from(row.prepared.base64,'base64'),tx=VersionedTransaction.deserialize(raw),bytes=Buffer.from(tx.message.serialize());
  if(raw.length>1232||raw.toString('base64')!==row.prepared.base64||!Buffer.from(tx.serialize()).equals(raw)||tx.version!==0||(row.prepared.lookups==null&&tx.message.addressTableLookups.length)||String(tx.message.staticAccountKeys[0])!==pinned.payer||tx.message.recentBlockhash!==row.prepared.blockhash||!Number.isSafeInteger(row.prepared.lastValidBlockHeight)||row.prepared.lastValidBlockHeight<1)throw Error('Unqualified prepared operating packet');
  if(tx.signatures[0].some(b=>b!==0)||tx.signatures.some((s,i)=>i>0&&!verifySignature(String(tx.message.staticAccountKeys[i]),bytes,s)))throw Error('Prepared packet has invalid auxiliary signatures');
  // A lookup-table packet resolves only through the resolution pinned when it was prepared (lookup-resolution.mjs).
  const tables=row.prepared.lookups!=null?resolvePinnedLookups(tx.message,row.prepared.lookups).tables:[];
  return {tx,bytes,messageHash:hash(bytes),tables};
 }
 async function shadow(input){
  scope(input);const row=await bounded(()=>registry.operatorPackets.latest(budgetId(input)));if(!row||row.attempt!==1)throw Error('Operating packet unavailable');
  const d=JSON.parse(row.descriptor);scope(d.binding);
  for(const k of ['campaign','operationId','messageHash','maximumLamports'])if(d.binding[k]!==input[k])throw Error('Operating packet binding differs');
  const p=packet(row);if(p.messageHash!==input.messageHash)throw Error('Operating packet hash differs');
  const cost={costModel:d.costModel,costIntent:d.costIntent,block:row.prepared};operatingCostModel(cost,p,{...input,treasury:platformTreasury});
  return {row,d,p};
 }
 async function signedSpend(input){
  const {row,d}=await shadow(input);
  return {binding:d.binding,operationId:input.operationId,maximumLamports:input.maximumLamports,costModel:d.costModel,costIntent:d.costIntent,block:row.prepared,signature:row.signature,transactionBase64:row.signedBase64};
 }
 const proofs=createOperatingProofReader({connection:rpc,genesisHash:pinned.genesisHash,loadFundingPacket,loadSpendPacket:signedSpend,timeoutMs,treasury:platformTreasury});
 async function signedOutcome(input,row){
  const proof=await proofs.verifyOutcome(input);
  if(['finalized','expired'].includes(proof.status)&&['signed','confirmed'].includes(row.status)){
   const to=proof.status==='expired'?'expired':proof.executionFailed?'failed':'finalized';
   if(row.status==='signed'||to==='finalized')await bounded(()=>registry.operatorPackets.progress({operationId:row.operationId,attempt:row.attempt,from:row.status,to,result:{status:proof.status,slot:proof.slot,executionFailed:proof.executionFailed===true}}));
  }
  return proof;
 }
 async function outcome(input){
  await network();let {row}=await shadow(input);
  if(row.signedBase64)return signedOutcome(input,row);
  // An unsigned shadow can expire only because signatures are saved here BEFORE
  // responding to any caller. The CAS races signature persistence: only one wins.
  // A signature produced but not persisted is never returned by signer-service.
  const epoch=await rpc.getEpochInfo('finalized');
  if(!Number.isSafeInteger(epoch.blockHeight)||!Number.isSafeInteger(epoch.absoluteSlot)||epoch.absoluteSlot<1||epoch.blockHeight<=row.prepared.lastValidBlockHeight)return {status:'unknown'};
  await network();
  if(row.status==='prepared')row=await bounded(()=>registry.operatorPackets.progress({operationId:row.operationId,attempt:1,from:'prepared',to:'expired',result:{unsigned:true,finalizedBlockHeight:epoch.blockHeight,slot:epoch.absoluteSlot}}));
  if(row.signedBase64)return signedOutcome(input,row);
  if(row.status!=='expired'||row.result?.unsigned!==true)throw Error('Unsigned packet expiry not established');
  return {...input,status:'expired',slot:epoch.absoluteSlot,actualLamports:'0',lastValidBlockHeight:row.prepared.lastValidBlockHeight,finalizedBlockHeight:epoch.blockHeight};
 }
 const ledger=createOperatingLedger({registry,verifyFunding:proofs.verifyFunding,verifyOutcome:outcome,onHeld:binding=>registry.jobs.enqueue({...binding,jobClass:'operating-reconcile',operationKey:'operating-reconcile:'+canonicalHash(binding),payload:{binding}})});
 return {
  // Private operator functions; not exposed as unauthenticated HTTP handlers.
  credit:input=>{scope(input);return ledger.credit(input);},
  credited:input=>{scope(input);return ledger.credited(input);},
  balance:input=>{scope(input);return ledger.balance(input);},
  reconcile:input=>{scope(input);return ledger.reconcile(input);},
  // Before any hold: every deterministic check (packet, scope, exact cost template, opening commitment) refuses with one
  // typed code the service answers as a permanent refusal; dependency failures, capacity waits and an expired packet
  // (the worker rebuilds after re-reading the chain) keep their retry path.
  async reserve(input){
   let original,descriptor,p,binding,cost;
   await (async()=>{try{await qualify();}catch(error){if(error?.dependency||error?.code==='CAPACITY_WAIT'||/expired/i.test(String(error?.message)))throw error;throw Object.assign(Error(error?.message??'Operator packet unqualified'),{code:'OPERATING_PACKET_REFUSED',cause:error});}})();
   async function qualify(){
   const x=structuredClone(input),cap=x.capability;
   if(cap?.programVersion!==3||cap.genesisHash!==pinned.genesisHash||cap.programId!==pinned.programId||!x.packetRef||!/^[a-f0-9]{64}$/.test(x.packetRef.operationId??'')||!Number.isSafeInteger(x.packetRef.attempt)||x.packetRef.attempt<1)throw Error('Reviewed v3 operator packet required');
   await network();original=await bounded(()=>registry.operatorPackets.latest(x.packetRef.operationId));
   if(!original||original.attempt!==x.packetRef.attempt||!['prepared','signed'].includes(original.status))throw Error('Operator packet is not current');
   descriptor=JSON.parse(original.descriptor);p=packet(original);
   if(descriptor.genesisHash!==pinned.genesisHash||descriptor.programId!==pinned.programId||descriptor.campaign!==cap.campaign||descriptor.payer!==pinned.payer||descriptor.operationKey!==x.operationKey||x.messageBase64!==p.bytes.toString('base64'))throw Error('Operator request differs from its durable packet');
   if(canonicalHash({genesisHash:pinned.genesisHash,programId:pinned.programId,campaign:cap.campaign,operationId:descriptor.operationId})!==x.packetRef.operationId||'op:'+canonicalHash({operation:x.packetRef.operationId,attempt:original.attempt,message:p.bytes.toString('base64')})!==x.operationId)throw Error('Operator attempt identity changed');
   binding={...pinned,campaign:cap.campaign,operationId:x.operationId,messageHash:p.messageHash,maximumLamports:x.maximumLamports};
   cost=await bounded(()=>loadCostIntent({binding:structuredClone(binding),descriptor:structuredClone(descriptor),packet:original.prepared.base64,lookups:structuredClone(original.prepared.lookups??null)}));
   if(!cost||typeof cost.costModel!=='string')throw Error('Reviewed operating cost unavailable');
   // No client-provided cost classifications are accepted. A trusted reader must
   // select a qualified exact template before any budget is held.
   operatingCostModel({...cost,block:original.prepared},p,{...binding,treasury:platformTreasury});
   if(await rpc.getBlockHeight('finalized')>original.prepared.lastValidBlockHeight)throw Error('Operator packet expired before reservation');
   }
   const id=budgetId(binding),row=await bounded(()=>registry.operatorPackets.prepare({operationId:id,descriptor:canonicalJson({binding,costModel:cost.costModel,costIntent:cost.costIntent??null}),prepared:original.prepared}));
   if(row.status==='expired')throw Error('Operating packet already expired');
   const held=await ledger.hold(binding);return {...held,binding,budgetPacketId:id};
  },
  async recordSignature(held,signatureBase64){
   // Deterministic checks before any write are typed refusals (nothing was persisted); a registry failure or timeout
   // stays an unresolved outcome for the same-operation retry path.
   const refuse=message=>Object.assign(Error(message),{code:'OPERATING_SIGNATURE_REFUSED'});
   if(!held||held.state!=='held'||!held.binding||held.budgetPacketId!==budgetId(held.binding))throw refuse('Invalid operating signature reservation');
   let row,p;try{({row,p}=await shadow(held.binding));}catch(error){throw error?.dependency?error:refuse(error?.message??'Operating packet unavailable');}
   if(!['prepared','signed'].includes(row.status))throw refuse('Operating packet cannot sign after expiry');
   const signature=Buffer.from(signatureBase64,'base64');if(signature.length!==64||signature.toString('base64')!==signatureBase64||!verifySignature(pinned.payer,p.bytes,signature))throw refuse('Operating signature does not match the held packet');
   p.tx.addSignature(new PublicKey(pinned.payer),signature);
   await bounded(()=>registry.operatorPackets.sign({operationId:row.operationId,attempt:1,signature:encodeBase58(signature),signedBase64:Buffer.from(p.tx.serialize()).toString('base64')}));
  },
 };
}
