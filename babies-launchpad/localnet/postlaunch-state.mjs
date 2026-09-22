import {feeAddresses} from './atomic-fees.mjs';
import {networkProfile,scopeFor} from './network.mjs';
const PROFILE=networkProfile();
import {fileURLToPath as _furl} from 'node:url';
const feeJournalPath=_furl(new URL('./.runtime/active-fee-operator.json',import.meta.url));
/** Confirmed fee operations for this campaign, newest first, public fields only. */
export function readFeeEvents(campaign,path=feeJournalPath){
 if(!existsSync(path))return [];let j;try{j=JSON.parse(readFileSync(path,'utf8'));}catch{return [];}
 if(j?.identity?.campaign!==campaign||!Array.isArray(j.history))return [];
 return j.history.slice(-60).reverse().map(e=>({id:e.id,kind:e.kind,index:e.index??null,amount:e.amount??null,signature:e.signature,at:e.at,delta:e.delta||null}));
}
import {resolvePostlaunchCampaign} from './postlaunch-campaign.mjs';
// Read-only view of the latest qualified local fixture. Never selects the public campaign.
import {readFileSync,existsSync} from 'node:fs';
import {PublicKey} from '@solana/web3.js';
import {NATIVE_MINT,TOKEN_PROGRAM_ID,unpackAccount,unpackMint} from '@solana/spl-token';
import {atomicContext,readCampaign,CPMM,AMM_CONFIG} from './atomic-launch.mjs';
import {poolAddresses,decodePool} from './cpmm.mjs';
import {singleFlight} from '../shared/single-flight.mjs';
async function readPostlaunchState(scope='active'){
 const selected=await resolvePostlaunchCampaign(scope);
 if(!selected)return {configured:false,network:PROFILE.network,scope:scopeFor(PROFILE,scope==='active'),claims:null};
 const {ctx,state:campaign,signature}=selected;
 const p=poolAddresses(CPMM,AMM_CONFIG,campaign.mint,NATIVE_MINT);
 if(!p.pool.equals(campaign.pool))throw Error('Pool identity mismatch');
 const {context,value}=await ctx.connection.getMultipleAccountsInfoAndContext([p.pool,p.vault0,p.vault1,campaign.mint],{commitment:'confirmed'});
 const pool=decodePool(value[0],CPMM,p);
 if(!pool.config.equals(AMM_CONFIG)||pool.creatorFeesEnabled)throw Error('Pool policy mismatch');
 const vaults=[unpackAccount(p.vault0,value[1],TOKEN_PROGRAM_ID),unpackAccount(p.vault1,value[2],TOKEN_PROGRAM_ID)],mint=unpackMint(campaign.mint,value[3],TOKEN_PROGRAM_ID),data=value[0].data;
 for(let i=0;i<2;i++)if(!vaults[i].owner.equals(p.authority)||!vaults[i].mint.equals(i?p.mint1:p.mint0))throw Error('Pool vault identity mismatch');
 const reserve0=vaults[0].amount-data.readBigUInt64LE(341)-data.readBigUInt64LE(357)-data.readBigUInt64LE(397);
 const reserve1=vaults[1].amount-data.readBigUInt64LE(349)-data.readBigUInt64LE(365)-data.readBigUInt64LE(405);
 if(reserve0<=0n||reserve1<=0n)throw Error('Pool reserves unavailable');
 const childFirst=p.mint0.equals(campaign.mint);
 const feeAddress=feeAddresses(ctx,selected.campaign,campaign.mint).state,feeAccount=await ctx.connection.getAccountInfo(feeAddress,'confirmed');let fees=null;
 if(feeAccount){const d=feeAccount.data;if(!feeAccount.owner.equals(ctx.programId)||d.length!==128||d.subarray(0,8).toString()!=='KIDSFEE1'||!d.subarray(8,40).equals(selected.campaign.toBuffer()))throw Error('Fee account identity mismatch');fees=Object.fromEntries(['childPending','totalSol','treasuryPaid','devPaid','parentAAllocated','parentBAllocated','parentASpent','parentBSpent','parentABurned','parentBBurned'].map((name,i)=>[name,d.readBigUInt64LE(40+i*8).toString()]));}

 const feeEvents=readFeeEvents(selected.campaign.toBase58());

 return {configured:true,network:PROFILE.network,explorerUrl:PROFILE.explorerUrl,explorerCluster:PROFILE.explorerCluster,scope:selected.scope,genesisHash:ctx.manifest.genesisHash,programId:ctx.programId.toBase58(),campaign:selected.campaign.toBase58(),mint:campaign.mint.toBase58(),pool:campaign.pool.toBase58(),launchSignature:signature,feeEvents,receiptHistoryAvailable:selected.receiptHistoryAvailable,launchedAt:campaign.launchedAt,baseReserveRaw:(childFirst?reserve0:reserve1).toString(),quoteReserveLamports:(childFirst?reserve1:reserve0).toString(),supplyRaw:mint.supply.toString(),decimals:mint.decimals,tradeFeeBps:200,mintAuthorityRevoked:mint.mintAuthority===null,freezeAuthorityRevoked:mint.freezeAuthority===null,fees,liquidityLocked:null,liquidityLockQualified:true,claims:null,observedSlot:context.slot,observedAt:new Date().toISOString(),notice:selected.scope==='active-localnet'?'Active Shartcoin campaign launched on isolated localnet. No mainnet funds.':'Separate localnet rehearsal coin. This is not the active Shartcoin campaign. Liquidity lock was verified at qualification; balances are read from the local chain.'};
}

const active=singleFlight(()=>readPostlaunchState('active'),{ttlMs:2000}),rehearsal=singleFlight(()=>readPostlaunchState('rehearsal'),{ttlMs:2000});
/** SOL and coin balances of the signed-in wallet on this ledger (strings), read at confirmed commitment. */
export async function walletBalances(connection,owner,mint){
 const {PublicKey}=await import('@solana/web3.js');const {getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID}=await import('@solana/spl-token');
 const wallet=new PublicKey(owner),ata=getAssociatedTokenAddressSync(new PublicKey(mint),wallet,false,TOKEN_PROGRAM_ID);
 const [sol,coin]=await Promise.all([connection.getBalance(wallet,'confirmed'),connection.getTokenAccountBalance(ata,'confirmed').catch(()=>null)]);
 return {owner,solLamports:String(sol),coinRaw:String(coin?.value?.amount||'0'),coinDecimals:6,feeReserveLamports:'10000000'};
}
export const postlaunchState=(scope='active')=>scope==='rehearsal'?rehearsal():active();
