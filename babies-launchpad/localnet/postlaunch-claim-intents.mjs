import {createIntentRetention,intentHistorySize,summarizeIntents} from '../shared/intent-retention.mjs';
import {acceptedProgramHash} from './program-lineage.mjs';
import {fileURLToPath} from 'node:url';
import {writeDurableJson} from '../shared/durable-json.mjs';
// Wallet-signed localnet claims. No server key is used by either endpoint.
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {buildPostlaunchClaim,qualifiedCampaign,postlaunchClaims} from './postlaunch-claims.mjs';
import {validateApprovedMessage} from '../shared/approved-message.mjs';
import {verifySignature,encodeBase58} from '../shared/solana.mjs';
export function claimRequest(owner,input){
 const normalized=new PublicKey(owner).toBase58();if(normalized!==owner)throw Error('Invalid wallet');
 if(!['participant','refund','parentA','parentB','dev'].includes(input.action)||typeof input.requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId))throw Error('Claim action and unique request ID required');
 const campaign=new PublicKey(input.campaign).toBase58();
 return {id:createHash('sha256').update(owner+':'+input.requestId).digest('hex'),descriptor:JSON.stringify([owner,campaign,input.action])};
}
export function validateSignedClaim(raw,approved,owner){
 if(typeof raw!=='string'||raw.length>6000)throw Error('Signed claim transaction required');
 const tx=VersionedTransaction.deserialize(Buffer.from(raw,'base64'));
 validateApprovedMessage(tx.message,VersionedTransaction.deserialize(Buffer.from(approved,'base64')).message);
 if(tx.message.header.numRequiredSignatures!==1||tx.message.staticAccountKeys[0].toBase58()!==owner||!verifySignature(owner,tx.message.serialize(),tx.signatures[0]))throw Error('Invalid claim signature');
 return tx;
}
export function createClaimIntentService({file,build=buildPostlaunchClaim,qualified=qualifiedCampaign,readClaims=postlaunchClaims,now=Date.now}){
 const intents=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};const locks=new Map();
 const save=()=>writeDurableJson(file instanceof URL?fileURLToPath(file):file,intents);
 const publicIntent=i=>Object.fromEntries(['intentId','owner','campaign','action','programId','mint','genesisHash','unsignedTransactionBase64','confirmedSignature'].filter(k=>i[k]!==undefined).map(k=>[k,i[k]]));
 const locked=async(id,fn)=>{if(locks.has(id))return locks.get(id);const promise=fn();locks.set(id,promise);try{return await promise;}finally{locks.delete(id);}};
 const identity=(i,{ctx,campaign,state})=>{if(i.campaign!==campaign.toBase58()||i.mint!==state.mint.toBase58()||i.programId!==ctx.programId.toBase58()||!acceptedProgramHash(ctx.manifest,i.programSha256)||i.genesisHash!==ctx.manifest.genesisHash)throw Error('Claim campaign or localnet identity changed');};
 const history=createIntentRetention({file:file instanceof URL?fileURLToPath(file):file,service:'postlaunch-claims',intents,persist:save,isBusy:key=>locks.has('submit:'+key)||locks.has('prepare:'+key),describe:async (i,key,memo)=>{
  const current=await memo(i.campaign,()=>qualified(i.campaign));identity(i,current);return {connection:current.ctx.connection,signature:i.confirmedSignature||i.signature,lastValidBlockHeight:i.block?.lastValidBlockHeight};
 }});
 let preparationQueue=Promise.resolve();
 const enqueue=work=>{const p=preparationQueue.then(work);preparationQueue=p.catch(()=>{});return p;};
 return {async reconcile(){await history.compact();return summarizeIntents('postlaunch-claims',intents);},
  async prepare(owner,input){
   const {id,descriptor}=claimRequest(owner,input);
   const result=await enqueue(()=>locked('prepare:'+id,async()=>{
    const old=history.lookup(id);if(old){if(old.descriptor!==descriptor)throw Error('Request ID belongs to different claim terms');identity(old,await qualified(old.campaign));if(old.archivedProof&&old.archivedProof.kind!=='finalized-success'||!old.signed&&now()-old.createdAt>180000)throw Error('Unsigned claim expired; refresh and prepare another request');return publicIntent(old);}
    await history.compact();
    if(intentHistorySize(intents)>=10000)throw Error('Claim intent history is full');
    const {ctx,campaign,state,tx}=await build(owner,input.action,input.campaign);const block=await ctx.connection.getLatestBlockhash('confirmed');tx.feePayer=new PublicKey(owner);tx.recentBlockhash=block.blockhash;
    const intent={intentId:id,descriptor,owner,campaign:campaign.toBase58(),action:input.action,programId:ctx.programId.toBase58(),programSha256:ctx.manifest.sha256,mint:state.mint.toBase58(),genesisHash:ctx.manifest.genesisHash,createdAt:now(),block,unsignedTransactionBase64:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64')};
    intents[id]=intent;save();return publicIntent(intent);
   }));
   if(history.lookup(id).descriptor!==descriptor)throw Error('Request ID belongs to different claim terms');return result;
  },
  async submit(owner,input){
   const intent=history.lookup(input.intentId);if(!intent||intent.owner!==owner)throw Error('Claim intent belongs to another wallet or is unavailable');
   if(input.local!==undefined)throw Error('This claim requires a wallet signature');
   return locked('submit:'+intent.intentId,async()=>{
    const current=await qualified(intent.campaign);identity(intent,current);const {connection}=current.ctx;
    const result=async()=>({signature:intent.confirmedSignature,claims:await readClaims(owner,intent.campaign)});
    if(intent.archivedProof&&intent.archivedProof.kind!=='finalized-success')throw Error('Claim failed or expired; prepare another request');
    if(intent.confirmedSignature)return result();
    if(intent.signature){const status=(await connection.getSignatureStatuses([intent.signature],{searchTransactionHistory:true})).value[0];if(status?.err)throw Error('Claim failed on chain; refresh before requesting another intent');if(status&&['confirmed','finalized'].includes(status.confirmationStatus)){intent.confirmedSignature=intent.signature;save();return result();}}
    if(!intent.signed){
     if(now()-intent.createdAt>180000)throw Error('Unsigned claim expired; refresh and prepare another request');
     const tx=validateSignedClaim(input.signedTransactionBase64,intent.unsignedTransactionBase64,owner);
     intent.signed=Buffer.from(tx.serialize()).toString('base64');intent.signature=encodeBase58(tx.signatures[0]);save();
    }
    // Persist before send and always retry exactly these bytes, including restart.
    save();
    const signature=await connection.sendRawTransaction(Buffer.from(intent.signed,'base64'),{skipPreflight:false,maxRetries:3});if(signature!==intent.signature)throw Error('Unexpected claim signature from RPC');
    const confirmation=await connection.confirmTransaction({...intent.block,signature},'confirmed');if(confirmation.value.err)throw Error('Claim rejected on chain');
    intent.confirmedSignature=signature;save();return result();
   });
  },
 };
}
const service=createClaimIntentService({file:new URL('./.runtime/postlaunch-claim-intents.json',import.meta.url)});
export const preparePostlaunchClaim=(owner,input)=>service.prepare(owner,input);
export const submitPostlaunchClaim=(owner,input)=>service.submit(owner,input);
export const reconcilePostlaunchClaims=()=>service.reconcile();
