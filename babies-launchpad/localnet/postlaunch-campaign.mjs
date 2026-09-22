// Resolve only the registered active campaign or the explicitly qualified rehearsal.
import {networkProfile,scopeFor} from './network.mjs';
const PROFILE=networkProfile();
import {existsSync,readFileSync} from 'node:fs';
import {acceptedProgramHash} from './program-lineage.mjs';
import {PublicKey} from '@solana/web3.js';
import {NATIVE_MINT} from '@solana/spl-token';
import {atomicContext,readCampaign,CPMM,AMM_CONFIG} from './atomic-launch.mjs';
import {validateActiveManifest,activeManifestPath,validateActiveTerms} from './active-launch.mjs';
import {poolAddresses,decodePool,decodeConfig} from './cpmm.mjs';
const reportPath=new URL('./.runtime/atomic-launch-verification.json',import.meta.url);
const journalPath=new URL('./.runtime/active-launch-operator.json',import.meta.url);
const read=file=>JSON.parse(readFileSync(file,'utf8'));
export function verifyLaunchedIdentity(ctx,state,record,{active=false}={}){
 if(!acceptedProgramHash(ctx.manifest,record.programSha256)||record.programId!==ctx.programId.toBase58()||record.genesisHash!==ctx.manifest.genesisHash)throw Error('Launch program or ledger identity changed');
 if(state.phase!==3)throw Error('Campaign has not launched');
 if(state.mint.toBase58()!==record.mint||state.pool.toBase58()!==(record.pool||state.pool.toBase58()))throw Error('Launch mint or pool changed');
 if(active)validateActiveTerms(state,record);
 const addresses=poolAddresses(CPMM,AMM_CONFIG,state.mint,NATIVE_MINT);
 if(!addresses.pool.equals(state.pool))throw Error('Launch pool is not canonical');return addresses;
}
export function createCampaignResolver({context=atomicContext,readState=readCampaign,has=existsSync,readRecord=read}={}){
 async function resolve(scope='active'){
  if(!['active','rehearsal'].includes(scope))throw Error('Unknown postlaunch scope');
  const active=scope==='active',path=active?activeManifestPath:reportPath;if(!has(path))return null;
  const ctx=await context(),record=active?validateActiveManifest(ctx,readRecord(path)):readRecord(path),address=new PublicKey(active?record.address:record.campaign),state=await readState(ctx,address);
  if(active&&record.ready!==true)throw Error('Active campaign registry is incomplete');
  // An active prelaunch is a known unavailable state, never a rehearsal fallback.
  if(active&&state.phase!==3){validateActiveTerms(state,record);return null;}
  const addresses=verifyLaunchedIdentity(ctx,state,record,{active});
  const infos=await ctx.connection.getMultipleAccountsInfo([addresses.pool,AMM_CONFIG],'confirmed');
  const pool=decodePool(infos[0],CPMM,addresses),config=decodeConfig(infos[1],CPMM);
  if(!pool.config.equals(AMM_CONFIG)||pool.creatorFeesEnabled||config.index!==2||config.trade!==20000n||config.protocol!==120000n||config.fund!==40000n)throw Error('Launch pool policy changed');
  let signature=record.launchSignature||record.signature;
  if(active&&!signature&&has(journalPath)){const journal=readRecord(journalPath);if(journal.campaign!==record.address||journal.genesisHash!==record.genesisHash||!acceptedProgramHash(ctx.manifest,journal.programSha256))throw Error('Launch journal identity changed');signature=journal.attempts?.launch?.signature;}
  if(signature!==undefined&&typeof signature!=='string')throw Error('Invalid launch receipt metadata');
  const status=signature?(await ctx.connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0]:null;
  signature=signature||null;
  // Ledger pruning can remove historical signatures. Confirmed program-owned
  // phase3 plus the canonical pool is the live proof; never fabricate receipt history.
  if(status&&(status.err||!['confirmed','finalized'].includes(status.confirmationStatus)))throw Error('Launch receipt is not confirmed');
  return {ctx,campaign:address,state,record,signature,receiptHistoryAvailable:!!status,scope:scopeFor(PROFILE,active)};
 }
 async function byCampaign(expected){
  if(typeof expected!=='string')throw Error('Claim or trade campaign is required');
  // Select by registered address first: an invalid active record never silently
  // redirects a request for that address into the rehearsal pool.
  if(has(activeManifestPath)&&readRecord(activeManifestPath).address===expected){const active=await resolve('active');if(!active)throw Error('Active campaign has not launched');return active;}
  const rehearsal=await resolve('rehearsal');if(!rehearsal||rehearsal.campaign.toBase58()!==expected)throw Error('Campaign is not a registered launched pool');return rehearsal;
 }
 return {resolve,byCampaign};
}
const resolver=createCampaignResolver();
export const resolvePostlaunchCampaign=scope=>resolver.resolve(scope);
// Existing rehearsal verification scripts retain their explicitly local fixture.
export const qualifiedCampaign=async expected=>{const selected=expected?await resolver.byCampaign(expected):await resolver.resolve('rehearsal');if(!selected)throw Error('No qualified local launch is available');return selected;};
