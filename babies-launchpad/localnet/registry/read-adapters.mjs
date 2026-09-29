// Campaign-scoped readers over registry rows. Each row is read on its own (no active-campaign singleton in this path):
// the active campaign may use the existing readActive() (manifest + chain, same numbers the site shows today); every
// other row is read from the chain alone with readCampaign() and the row's own program id. Two campaigns can be read
// at once; a failed read is an explicit `available:false` with a category, never an invented number (reliability rules).
import {campaignIdentity,campaignId} from './registry.mjs';
import {LEGACY_ADAPTER_VERSION} from './import-legacy.mjs';
/** Fixed policy of the v3 Family campaigns (programs/atomic-launch build 1 to 5; behaviour map, 24 September 2026). */
export const LEGACY_POLICY=Object.freeze({
 [LEGACY_ADAPTER_VERSION]:Object.freeze({mode:'family',parents:2,supplySplitBps:Object.freeze({participants:4350,liquidity:4350,parentA:500,parentB:500,dev:300}),solFeeRouting:Object.freeze({denominator:168,treasury:98,dev:20,parentA:25,parentB:25}),tokenSideFees:'burn',devVesting:Object.freeze({immediateBps:100,linearBps:200,vestingMonths:3}),launchWindowSeconds:86400,tradeFeeBps:250,hardCapClosesFunding:false,oversubscription:'accepted_i = floor(commit_i * min(T, H) / T)'}),
});
export const CATEGORIES=Object.freeze(['no-adapter','wrong-network','not-found','malformed','network','timeout','rate-limited','upstream','unknown']);
/** Phase from the decoded campaign account and the chain clock, the same rule activeAmounts uses. */
export function chainStatusOf(c,now){
 const closed=now>=c.deadline,failed=closed&&(c.total<c.soft||now>=c.launchDeadline&&c.phase!==3);
 return failed?'failed':c.phase===3?'launched':closed?'awaiting-launch':'open';
}
export function categorize(error){
 const m=String(error?.message||error||'');const code=error?.code;
 if(code==='WRONG_NETWORK'||/ledger mismatch|wrong network|genesis/i.test(m))return 'wrong-network';
 if(/Invalid atomic campaign|PDA mismatch/i.test(m))return 'malformed';
 if(/not found|no account/i.test(m))return 'not-found';
 if(code==='ABORT_ERR'||error?.name==='AbortError'||/timeout|timed out/i.test(m))return 'timeout';
 if(/429|rate limit/i.test(m))return 'rate-limited';
 if(/5\d\d|upstream|unavailable/i.test(m))return 'upstream';
 if(code==='ECONNREFUSED'||code==='ENOTFOUND'||code==='ECONNRESET'||/fetch failed|network/i.test(m))return 'network';
 return 'unknown';
}
const s=v=>v==null?null:typeof v==='bigint'?v.toString():String(v);
const b58=v=>v==null?null:typeof v==='string'?v:v.toBase58();
/** Public terms of a registry row (no chain call): what was sealed, plus the fixed legacy policy for its adapter. */
export function campaignTerms(row){
 const policy=LEGACY_POLICY[row.legacyAdapterVersion]||null;
 return {id:campaignId(row),genesisHash:row.genesisHash,programId:row.programId,campaign:row.campaign,network:row.network,mode:row.mode,campaignVersion:row.campaignVersion,adapter:row.legacyAdapterVersion,termsHash:row.termsHash,softCapLamports:row.softCapLamports,hardCapLamports:row.hardCapLamports,deadlineUnix:row.deadlineUnix,launchDeadlineUnix:row.launchDeadlineUnix,opensAt:row.opensAt,supplyRaw:row.supplyRaw,mint:row.mint,creator:row.creator,dev:row.dev,treasury:row.treasury,parentMints:row.parentMints,policy,sealedOnChain:row.legacyAdapterVersion===LEGACY_ADAPTER_VERSION?'caps, deadlines, mint, supply, dev and treasury are in the campaign account; the split, routing and pool tier are program code of this version':null};
}
function viewFromActive(row,a){
 return {available:true,id:campaignId(row),identity:campaignIdentity(row),adapter:row.legacyAdapterVersion,mode:row.mode,registryStatus:row.registryStatus,source:{kind:'active-manifest',slot:null,commitment:'confirmed',chainTimeUnix:a.chainTimeUnix,clock:'chain'},phase:a.phase,terms:{softCapLamports:a.softCapLamports,hardCapLamports:a.hardCapLamports,deadlineUnix:a.deadlineUnix,launchDeadlineUnix:a.launchDeadlineUnix,supplyRaw:row.supplyRaw,mint:a.mint,creator:row.creator,dev:row.dev,treasury:row.treasury,parentMints:row.parentMints},totals:{totalLamports:a.totalLamports,refundedLamports:a.refundedLamports,settledAcceptedLamports:a.settledAcceptedLamports,receiptCount:a.receiptCount,settledReceiptCount:a.settledReceiptCount,devClaimedRaw:null},pool:a.pool||null,launchedAtUnix:null,distribution:null};
}
function viewFromChain(row,r){
 const c=r.campaign,now=r.chainTimeUnix;
 return {available:true,id:campaignId(row),identity:campaignIdentity(row),adapter:row.legacyAdapterVersion,mode:row.mode,registryStatus:row.registryStatus,source:{kind:'chain',slot:r.slot??null,commitment:r.commitment||'confirmed',chainTimeUnix:now,clock:r.clock||'chain'},phase:chainStatusOf(c,now),terms:{softCapLamports:s(c.soft),hardCapLamports:s(c.hard),deadlineUnix:c.deadline,launchDeadlineUnix:c.launchDeadline,supplyRaw:s(c.supply),mint:b58(c.mint),creator:b58(c.creator),dev:b58(c.dev),treasury:b58(c.treasury),parentMints:row.parentMints},totals:{totalLamports:s(c.total),refundedLamports:s(c.refunded),settledAcceptedLamports:s(c.settledAccepted),receiptCount:s(c.receiptCount),settledReceiptCount:s(c.settledReceiptCount),devClaimedRaw:s(c.devClaimed)},pool:c.phase===3?b58(c.pool):null,launchedAtUnix:c.phase===3&&c.launchedAt?c.launchedAt:null,distribution:c.distributionProgram?{program:b58(c.distributionProgram),activated:c.distributionActivated===true}:null};
}
/** Chain-only reader: a fresh connection for the row's ledger, the row's program id, the account's slot captured from
 * the read. Refuses a ledger whose genesis differs from the row's (never mixes networks). */
export async function defaultChainReader(row,{timeoutMs=8000}={}){
 const [{Connection,PublicKey},{networkProfile},{readCampaign},{boundedRpcFetch}]=await Promise.all([import('@solana/web3.js'),import('../network.mjs'),import('../atomic-launch.mjs'),import('../rpc-transport.mjs')]);
 const profile=networkProfile();
 if(profile.genesisHash&&profile.genesisHash!==row.genesisHash){const e=Error('Campaign belongs to another ledger (genesis '+row.genesisHash+', process on '+profile.network+')');e.code='WRONG_NETWORK';throw e;}
 const connection=new Connection(profile.rpcUrl,{commitment:'confirmed',fetch:boundedRpcFetch()});
 const signal=AbortSignal.timeout(timeoutMs);
 const genesis=await connection.getGenesisHash();if(genesis!==row.genesisHash){const e=Error('Ledger genesis '+genesis+' differs from the campaign genesis');e.code='WRONG_NETWORK';throw e;}
 let slot=null;
 const ctx={programId:new PublicKey(row.programId),connection:{async getAccountInfo(key){const r=await connection.getAccountInfoAndContext(key,{commitment:'confirmed',signal});slot=r.context.slot;return r.value;}}};
 const campaign=await readCampaign(ctx,row.campaign);
 let chainTimeUnix=null,clock='chain';try{chainTimeUnix=await connection.getBlockTime(slot);}catch{chainTimeUnix=null;}
 if(!Number.isSafeInteger(chainTimeUnix)){chainTimeUnix=Math.floor(Date.now()/1000);clock='wall';}
 return {campaign,slot,commitment:'confirmed',chainTimeUnix,clock};
}
/** Reads one row. readers.readActive (optional) serves the active row when its manifest names this campaign; readers.readCampaignChain
 * (default: defaultChainReader) serves everything else. Never throws: an unreadable campaign is {available:false, error}. */
export async function readCampaignView(row,{readers={},now=Date.now}={}){
 const identity=campaignIdentity(row);const base={available:false,id:campaignId(identity),identity,adapter:row.legacyAdapterVersion,mode:row.mode,registryStatus:row.registryStatus,readAt:new Date(now()).toISOString()};
 if([2,3].includes(row.campaignVersion)&&row.mode==='standard'){
  try{const {readV2CampaignView}=await import('./v2-read.mjs');return {...await readV2CampaignView(row,(row.campaignVersion===3?readers.v3:readers.v2)||{}),id:base.id,identity,readAt:base.readAt};}
  catch(e){return {...base,error:{category:categorize(e),message:'Live campaign data unavailable'}};}
 }
 if(!LEGACY_POLICY[row.legacyAdapterVersion])return {...base,error:{category:'no-adapter',message:'No read adapter for '+row.legacyAdapterVersion}};
 if(row.registryStatus==='active'&&typeof readers.readActive==='function'){
  try{const a=await readers.readActive();if(a&&a.configured===true&&a.escrowAddress===row.campaign&&a.genesisHash===row.genesisHash&&a.programId===row.programId)return {...viewFromActive(row,a),readAt:base.readAt};}
  catch(e){/* the manifest read failed or names another campaign: fall through to the chain */}
 }
 const chain=readers.readCampaignChain||defaultChainReader;
 try{const r=await chain(row);return {...viewFromChain(row,r),readAt:base.readAt};}
 catch(e){return {...base,error:{category:categorize(e),message:String(e?.message||e).slice(0,200)}};}
}
/** Reads many rows concurrently (bounded), each on its own; the result keeps the input order. */
export async function readCampaignViews(rows,{concurrency=4,...opts}={}){
 const out=new Array(rows.length);let next=0;
 const worker=async()=>{while(next<rows.length){const i=next++;out[i]=await readCampaignView(rows[i],opts);}};
 await Promise.all(Array.from({length:Math.max(1,Math.min(concurrency,rows.length))},worker));
 return out;
}
/** Writes what a successful chain read proved back to the registry (status, slot, pool, launch time); an unavailable view writes nothing. */
export function projectView(registry,row,view){
 if(!view?.available||view.source.kind!=='chain'||view.source.slot==null)return null;
 return registry.campaigns.upsert({genesisHash:row.genesisHash,programId:row.programId,campaign:row.campaign,mode:row.mode,campaignVersion:row.campaignVersion,registryStatus:row.registryStatus,chainStatus:view.phase,sourceSlot:view.source.slot,sourceCommitment:view.source.commitment,pool:view.pool,launchedAt:view.launchedAtUnix?new Date(view.launchedAtUnix*1000).toISOString():null,softCapLamports:view.terms.softCapLamports,hardCapLamports:view.terms.hardCapLamports,deadlineUnix:view.terms.deadlineUnix,launchDeadlineUnix:view.terms.launchDeadlineUnix,supplyRaw:view.terms.supplyRaw,mint:view.terms.mint,creator:view.terms.creator,dev:view.terms.dev,treasury:view.terms.treasury});
}
