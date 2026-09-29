import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import * as client from '../protocol-v2/client.mjs';import {providerFreshness} from './freshness.mjs';
export function createPositionIndexHandler({store,rpc,genesisHash,programId,programVersion,intervalMs=30000,maxReceipts=10000}){
 if(programVersion!==3)throw Error('Position discovery requires explicit v3 scope');
 const program=new PublicKey(programId);new PublicKey(genesisHash);if(!Number.isInteger(maxReceipts)||maxReceipts<1||maxReceipts>10000||!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>60000)throw Error('Invalid position indexing bounds');
 return {async run(job,ctx){
  const id=ctx.campaign;if(id.genesisHash!==genesisHash||id.programId!==programId||job.jobClass!=='position-index'||!/^positions:(0|[1-9][0-9]{0,14})$/.test(job.operationKey))throw Error('Position worker scope mismatch');
  const previous=await store.snapshot(id),sequence=BigInt(job.operationKey.split(':')[1]);if(previous.body&&BigInt(previous.body.sequence)>=sequence)return {outcome:'done',replayed:true};if(sequence!==(previous.body?BigInt(previous.body.sequence)+1n:0n))throw Error('Position sequence gap');
  const call=(method,params)=>ctx.fenced('position-read',()=>rpc.call(method,params));
  async function observe(minContextSlot){
   const r=await call('getMultipleAccounts',[[id.campaign,String(SYSVAR_CLOCK_PUBKEY)],{encoding:'base64',commitment:'finalized',...(minContextSlot?{minContextSlot}:{})}]);
   if(!Number.isSafeInteger(r?.context?.slot)||r.context.slot<1||minContextSlot&&r.context.slot<minContextSlot||!Array.isArray(r.value)||r.value.length!==2)throw Error('Position observation unavailable');
   const [account,clock]=r.value;if(account?.owner!==programId||account.executable||account.data?.[1]!=='base64'||clock?.data?.[1]!=='base64'||clock.owner!=='Sysvar1111111111111111111111111111111111111'||clock.executable)throw Error('Position account ownership mismatch');
   const bytes=Buffer.from(clock.data[0],'base64');if(bytes.length!==40)throw Error('Position clock unavailable');const chainTime=Number(bytes.readBigInt64LE(32));
   if(providerFreshness({slot:r.context.slot,time:chainTime},ctx.now()).stale)throw Object.assign(Error('Position provider stale'),{code:'RPC_UNAVAILABLE'});
   const decoded=client.decodeCampaign(Buffer.from(account.data[0],'base64')),t=decoded.terms,count=Number(decoded.state.receiptCount);
   if(t.mode!==0||t.genesis!==client.keyHex(genesisHash)||String(client.campaignAddress(program,t.creator,t.nonce))!==id.campaign||!Number.isSafeInteger(count)||count<0||count>maxReceipts)throw Error('Position campaign identity or capacity mismatch');
   return {count,slot:r.context.slot,chainTime};
  }
  let body=await observe(previous.body?.slot),receipts=null;
  if(!previous.body||previous.body.count!==body.count){
   const r=await call('getProgramAccounts',[programId,{encoding:'base64',commitment:'finalized',withContext:true,minContextSlot:body.slot,filters:client.receiptFilters(new PublicKey(id.campaign))}]);
   if(!Number.isSafeInteger(r?.context?.slot)||r.context.slot<body.slot||!Array.isArray(r.value)||r.value.length>maxReceipts)throw Error('Position enumeration unavailable');
   receipts=r.value.map(({pubkey,account})=>{if(account?.owner!==programId||account.executable||account.data?.[1]!=='base64')throw Error('Receipt owner mismatch');const d=client.decodeReceipt(Buffer.from(account.data[0],'base64'));if(String(d.campaign)!==id.campaign||String(client.receiptAddress(program,id.campaign,d.owner))!==pubkey||d.committed<=0n)throw Error('Receipt identity mismatch');return {owner:String(d.owner),receipt:pubkey};});
   const after=await observe(r.context.slot);if(after.count!==receipts.length||body.count!==after.count)throw Object.assign(Error('Receipt enumeration raced a commitment'),{code:'RPC_UNAVAILABLE'});body=after;
  }
  body={...body,sequence:String(sequence)};
  try{await ctx.fenced('position-publish',()=>store.commit({id,expectedRevision:previous.revision,body,receipts,job,followup:{jobClass:'position-index',operationKey:'positions:'+(sequence+1n),notBefore:new Date(ctx.now()+intervalMs).toISOString()}}));}catch(e){if(e.code==='POSITION_CURSOR_CONFLICT')return {outcome:'yield',delayMs:1000};throw e;}
  return {outcome:'done',category:'position-index',slot:body.slot,count:body.count};
 }};
}
