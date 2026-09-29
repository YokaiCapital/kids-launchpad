import {Connection,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {decodeCampaign,campaignAddress,keyHex} from '../protocol-v2/client.mjs';
import {networkProfile} from '../network.mjs';
import {boundedRpcFetch} from '../rpc-transport.mjs';

export function v2View(row,{account,slot,clock,genesisHash,now=Date.now}){
 if(genesisHash!==row.genesisHash)throw Error('Ledger genesis mismatch');
 if(!account||!account.owner.equals(new PublicKey(row.programId)))throw Error('Campaign account owner mismatch');
 const c=decodeCampaign(account.data),t=c.terms,s=c.state;
 if(t.genesis!==keyHex(genesisHash)||!campaignAddress(row.programId,t.creator,t.nonce).equals(new PublicKey(row.campaign)))throw Error('Campaign PDA or genesis mismatch');
 const at=BigInt(clock),live=s.phase===3;
 const failed=!live&&(s.phase===2||(at>=t.deadline&&s.total<t.soft)||at>=t.launchDeadline);
 const phase=live?'launched':failed?'failed':at<t.opensAt?'scheduled':at<t.deadline?'open':'awaiting-launch';
 return {available:true,phase,source:{kind:'chain',slot,commitment:'confirmed',chainTimeUnix:Number(at)},
  terms:{softCapLamports:String(t.soft),hardCapLamports:String(t.hard),opensAtUnix:Number(t.opensAt),deadlineUnix:Number(t.deadline),launchDeadlineUnix:Number(t.launchDeadline),
   supplyRaw:String(t.supply),decimals:t.decimals,splitBps:t.splitBps,vesting:t.vesting,tradeFeeBps:Number(t.ammTradeFeeRate)/100,creatorFeeEnabled:!!t.creatorFeeEnabled,
   feeWeights:t.feeWeights,ammConfig:t.ammConfig.toBase58(),lockProgram:t.lockProgram.toBase58(),mint:t.childMint.toBase58(),creator:t.creator.toBase58(),dev:t.dev.toBase58(),treasury:t.treasury.toBase58()},
  totals:{totalLamports:String(s.total),refundedLamports:String(s.refunded),refundableLamports:live?String(s.total-s.settledAccepted-s.refunded):failed?String(s.total-s.refunded):null,settledAcceptedLamports:(live||at>=t.deadline)&&s.receiptCount>0n&&s.settledCount===s.receiptCount?String(s.settledAccepted):null,receiptCount:String(s.receiptCount),settledReceiptCount:String(s.settledCount)},
  pool:live?s.pool.toBase58():null,launchedAtUnix:live?Number(s.launchTime):null,readAt:new Date(now()).toISOString()};
}
export async function readV2CampaignView(row,{connection=null,now=Date.now}={}){
 const profile=connection?null:networkProfile();
 const rpc=connection||new Connection(profile.rpcUrl,{commitment:'confirmed',fetch:boundedRpcFetch()});
 const genesisHash=await rpc.getGenesisHash();if(genesisHash!==row.genesisHash)throw Error('Ledger genesis mismatch');
 const result=await rpc.getMultipleAccountsInfoAndContext([new PublicKey(row.campaign),SYSVAR_CLOCK_PUBKEY],{commitment:'confirmed'});
 const [account,clockAccount]=result.value;
 if(!clockAccount||clockAccount.data.length<40)throw Error('Chain clock unavailable');
 const view=v2View(row,{account,slot:result.context.slot,clock:clockAccount.data.readBigInt64LE(32),genesisHash,now});
 const decoded=decodeCampaign(account.data),t=decoded.terms;
 // Display the actual pool config, not a stale marketing constant or only the sealed expectation.
 view.terms.tradeFeeBps=null;if(view.pool)view.terms.creatorFeeEnabled=null;
 try{const {decodeConfig}=await import('../cpmm.mjs');const config=decodeConfig(await rpc.getAccountInfo(t.ammConfig,'confirmed'),t.ammProgram);view.terms.tradeFeeBps=Number(config.trade)/100;
  if(view.pool){const p=await rpc.getAccountInfo(decoded.state.pool,'confirmed');if(p?.owner.equals(t.ammProgram)&&p.data.length===637&&new PublicKey(p.data.subarray(8,40)).equals(t.ammConfig))view.terms.creatorFeeEnabled=p.data[390]!==0;}
 }catch{/* Unread current fees remain unknown. */}
 return view;
}
