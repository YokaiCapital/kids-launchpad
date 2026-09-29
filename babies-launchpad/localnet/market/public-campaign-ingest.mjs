import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import * as client from '../protocol-v2/client.mjs';import {v2View} from '../registry/v2-read.mjs';
import {decodeConfig,decodePool,poolAddresses} from '../cpmm.mjs';import {providerFreshness} from './freshness.mjs';
const account=x=>{if(!x)return null;if(x.executable||x.data?.[1]!=='base64')throw Error('Invalid campaign projection account');return {...x,owner:new PublicKey(x.owner),data:Buffer.from(x.data[0],'base64')};};
export function createCampaignIndexHandler({store,rpc,genesisHash,programId,programVersion,intervalMs=10000}){
 if(programVersion!==3||!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>60000)throw Error('Explicit v3 projection scope required');new PublicKey(genesisHash);new PublicKey(programId);
 return {async run(job,ctx){
  const id=ctx.campaign;if(id.genesisHash!==genesisHash||id.programId!==programId||job.jobClass!=='campaign-index'||!/^campaign:(0|[1-9][0-9]{0,14})$/.test(job.operationKey))throw Error('Campaign index scope mismatch');
  const prev=await store.snapshot(id),sequence=BigInt(job.operationKey.split(':')[1]);if(prev.body&&BigInt(prev.body.sequence)>=sequence)return {outcome:'done',replayed:true};if(sequence!==(prev.body?BigInt(prev.body.sequence)+1n:0n))throw Error('Campaign index sequence gap');
  const call=(m,p)=>ctx.fenced('campaign-observation',()=>rpc.call(m,p));
  const hint=await call('getAccountInfo',[id.campaign,{encoding:'base64',commitment:'finalized',...(prev.body?{minContextSlot:prev.body.view.source.slot}:{})}]);
  const initial=account(hint?.value);if(!initial?.owner.equals(new PublicKey(programId)))throw Error('Campaign owner mismatch');
  const {terms:first}=client.decodeCampaign(initial.data);if(first.mode!==0||!first.ammProgram.equals(client.RAYDIUM_CPMM))throw Error('Campaign projection is Standard only');
  const pool=poolAddresses(first.ammProgram,first.ammConfig,first.childMint,client.WSOL);
  if(!Number.isSafeInteger(hint.context?.slot)||hint.context.slot<1)throw Error('Campaign context unavailable');
  const r=await call('getMultipleAccounts',[[id.campaign,String(SYSVAR_CLOCK_PUBKEY),String(first.ammConfig),String(pool.pool)],{encoding:'base64',commitment:'finalized',minContextSlot:Math.max(hint.context.slot,prev.body?.view.source.slot??0)}]);
  if(!Number.isSafeInteger(r?.context?.slot)||r.context.slot<hint.context.slot||r.context.slot<(prev.body?.view.source.slot??0)||!Array.isArray(r.value)||r.value.length!==4)throw Error('Campaign observation context unavailable');
  const a=account(r.value[0]),clock=account(r.value[1]);if(!clock?.owner.equals(new PublicKey('Sysvar1111111111111111111111111111111111111'))||clock.data.length!==40)throw Error('Campaign clock unavailable');
  const time=Number(clock.data.readBigInt64LE(32));if(providerFreshness({slot:r.context.slot,time},ctx.now()).stale)throw Object.assign(Error('Campaign provider stale'),{code:'RPC_UNAVAILABLE'});
  const {terms,state}=client.decodeCampaign(a.data);if(terms.mode!==0||!terms.ammConfig.equals(first.ammConfig)||!terms.childMint.equals(first.childMint)||!terms.ammProgram.equals(first.ammProgram))throw Error('Campaign terms changed during observation');
  const view=v2View(id,{account:a,slot:r.context.slot,clock:time,genesisHash,now:ctx.now});view.source.commitment='finalized';
  // Show the current AMM tier; never replace an unavailable current fee with an expected constant.
  view.terms.tradeFeeBps=null;view.terms.creatorFeeEnabled=null;
  try{const fee=decodeConfig(account(r.value[2]),terms.ammProgram);if(fee.trade<0n||fee.trade>=1000000n)throw Error('Invalid current fee');view.terms.tradeFeeBps=Number(fee.trade)/100;
   if(view.pool){if(view.pool!==String(pool.pool))throw Error('Pool address mismatch');const p=decodePool(account(r.value[3]),terms.ammProgram,pool);if(!p.config.equals(terms.ammConfig))throw Error('Pool config mismatch');view.terms.creatorFeeEnabled=p.creatorFeesEnabled;}
   else view.terms.creatorFeeEnabled=!!terms.creatorFeeEnabled;
  }catch{view.terms.tradeFeeBps=null;view.terms.creatorFeeEnabled=null;}
  const body={sequence:String(sequence),termsHash:state.termsHash,view};
  try{await ctx.fenced('campaign-publish',()=>store.commit({id,job,expectedRevision:prev.revision,body,followup:{jobClass:'campaign-index',operationKey:'campaign:'+(sequence+1n),notBefore:new Date(ctx.now()+intervalMs).toISOString()}}));}catch(e){if(e.code==='CAMPAIGN_CURSOR_CONFLICT')return {outcome:'yield',delayMs:1000};throw e;}
  return {outcome:'done',category:'campaign-index',slot:r.context.slot,phase:view.phase};
 }};
}
