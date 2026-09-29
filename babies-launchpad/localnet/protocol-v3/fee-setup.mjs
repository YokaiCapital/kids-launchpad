// Explicit v3 Standard, treasury-funded setup. Does not grant capabilities or
// schedule recurring economics; those remain separate activation decisions.
import {PublicKey} from '@solana/web3.js';
import {unpackAccount} from '@solana/spl-token';
import {feeSetupInstructions} from '../creation/operating-costs.mjs';
import {feeStateAddress,decodeFeeState,TOKEN_PROGRAM,WSOL} from '../protocol-v2/client.mjs';
export function createFeeSetupAdapter({connection,chain,feeOperator}){
 if(!connection||typeof chain?.readCampaign!=='function'||typeof chain?.send!=='function')throw Error('Fee setup requires a durable chain adapter');
 const operator=new PublicKey(feeOperator),payer=new PublicKey(chain.keeper),program=new PublicKey(chain.programId);
 async function snapshot(id){
  const campaign=new PublicKey(id.campaign),c=await chain.readCampaign(id);
  // Standard only: since the 28 September program change any signer opens the fee cycle (tag 20) and pays its rent; the
  // operator it names is inert for Standard campaigns, so a hosted keeper needs no treasury key.
  if(c.terms.mode!==0)throw Error('Fee setup supports Standard campaigns only');
  if(c.phase!==3)return {status:'waiting',reason:'awaiting-live'};
  const instructions=feeSetupInstructions({programId:program,campaign,payer,operator,terms:c.terms}),atas=instructions.slice(0,-1);
  let response;
  try{response=await connection.getMultipleAccountsInfoAndContext([feeStateAddress(program,campaign),...atas.map(ix=>ix.keys[1].pubkey)],{commitment:'finalized',minContextSlot:c.slot});}
  catch(error){if(error?.code===-32016)return {status:'waiting',reason:'awaiting-finalized-setup'};throw error;}
  if(!Number.isSafeInteger(response?.context?.slot)||response.context.slot<c.slot||!Array.isArray(response.value)||response.value.length!==atas.length+1)throw Error('Fee setup evidence unavailable');
  const [info,...accounts]=response.value;
  if(!info)return {status:'absent',instructions};
  if(info.executable||!info.owner.equals(program))throw Error('Fee setup custody differs');
  // Whoever opened the cycle (a stranger may, cheaply) named an operator that is inert for Standard campaigns; record it.
  const recorded=decodeFeeState(info.data,campaign).operator;
  // The cycle is open but a custody account is missing (opened by someone else, or closed since): create the missing
  // accounts alone, idempotently, never a second opening.
  if(accounts.some(a=>!a))return {status:'absent',reason:'recipient-account-repair',instructions:atas,operator:String(recorded)};
  for(let i=0;i<atas.length;i++){
   const ix=atas[i],account=accounts[i];
   if(account.executable||!account.owner.equals(TOKEN_PROGRAM)||account.data.length!==165)throw Error('Fee setup token account differs');
   const token=unpackAccount(ix.keys[1].pubkey,account,TOKEN_PROGRAM);
   if(!token.isInitialized||token.isFrozen||!token.owner.equals(ix.keys[2].pubkey)||!token.mint.equals(ix.keys[3].pubkey)||token.delegate!==null||token.delegatedAmount!==0n||token.closeAuthority!==null||token.isNative!==token.mint.equals(WSOL))throw Error('Fee setup token custody differs');
  }
  return {status:'ready',slot:response.context.slot,accounts:atas.length,payer:String(payer),operator:String(recorded),recipients:[...new Set([String(c.terms.treasury),String(c.terms.dev)])].sort(),termsHash:c.termsHash};
 }
 return {
  snapshot,signatureStatus:chain.signatureStatus,
  async setup(id,options){
   const before=await snapshot(id);if(before.status==='ready')return before;
   if(before.status==='waiting')return before;
   const sent=await chain.send(before.instructions,{...options,campaign:id.campaign,computeUnits:400000,label:'fee-setup'});
   if(sent.status!=='confirmed')return sent;
   // A confirmed send is not the finalized custody verification. Retain its
   // durable identity and let the next pass verify it before marking setup done.
   return {status:'waiting',reason:'awaiting-finalized-setup',signature:sent.signature};
  }
 };
}
export function feeSetupHandler({adapter,onReady=null}){
 if(typeof adapter?.setup!=='function')throw Error('Fee setup adapter required');
 return {
  async reconcile(job){return adapter.signatureStatus(job.result.reconcile.signature,job.result.reconcile);},
  async run(job,ctx){
   if(job.jobClass!=='fee-setup'||job.operationKey!=='fee-setup')return {outcome:'failed-permanent',category:'fee-setup-key',reason:'Invalid setup job'};
   const result=await ctx.fenced('fee-setup',()=>adapter.setup(ctx.campaign,{operationId:'fee-setup',operationKey:job.operationKey,fencingToken:ctx.token,signal:ctx.signal,holds:ctx.holds}));
   if(result.status==='ready'||result.status==='verified'){
    if(onReady)await ctx.fenced('schedule-fee-activation',()=>onReady(job,ctx));
    return {outcome:'done',verified:true,slot:result.slot,accounts:result.accounts};
   }
   if(result.status==='waiting')return {outcome:'yield',category:result.reason,delayMs:15000,signature:result.signature??job.result?.signature??null};
   if(result.status==='unknown')return {outcome:'unknown',category:'unresolved',reconcile:{...result.packetRef?{packetRef:result.packetRef}:{},signature:result.signature,blockhash:result.blockhash,lastValidBlockHeight:result.lastValidBlockHeight}};
   if(result.status==='failed')return {outcome:'retry',category:'fee-setup-send',reason:'Fee setup transaction failed; re-read custody before retry'};
   throw Error('Invalid fee setup result');
  }
 };
}
