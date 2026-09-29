// Imports today's campaigns into the registry without touching their files (plan section 8: "import all existing
// active and archived campaigns with version-specific read adapters; do not generate new empty database records over
// existing liabilities"). Sources, in rank order:
//   active   the runtime manifest localnet/.runtime/active-launch.json (the campaign this API process serves);
//   archived runtime archive folders .runtime/archive/<campaign>/active-launch.json (renew-active-launch.mjs) and the
//            plan archives deployment/mainnet/archive/campaign-plan-<campaign>.json;
//   planned  deployment/mainnet/campaign-plan.json (the plan the operator provisions from);
//   historical deployment/MAINNET-IDENTITIES.json firstCampaign.
// Every row carries legacyAdapterVersion 'v3-family-single' (one Family campaign per process, KIDSESC3 accounts) and the
// paths it came from. Rerunning merges: nulls never overwrite, sealed terms keep their first value, disagreements are
// reported as conflicts. Nothing is written to any source file.
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {join,relative,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MAINNET_GENESIS,DEVNET_GENESIS} from '../network.mjs';
import {isAddress} from './registry.mjs';
export const LEGACY_ADAPTER_VERSION='v3-family-single';
export const LEGACY_CAMPAIGN_VERSION=3;
export const GENESIS_BY_NETWORK=Object.freeze({mainnet:MAINNET_GENESIS,devnet:DEVNET_GENESIS});
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function defaultSources({root=ROOT}={}){
 return {root,runtimeDir:join(root,'localnet','.runtime'),planPath:join(root,'deployment','mainnet','campaign-plan.json'),archiveDir:join(root,'deployment','mainnet','archive'),identitiesPath:join(root,'deployment','MAINNET-IDENTITIES.json')};
}
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
const rel=(root,path)=>{const r=relative(root,resolve(path));return r&&!r.startsWith('..')&&!isAbsolute(r)?r:path;};
const num=v=>Number.isSafeInteger(v)?v:(typeof v==='string'&&/^\d{1,15}$/.test(v)?Number(v):null);
const dec=v=>typeof v==='string'&&/^\d{1,40}$/.test(v)?v:(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?String(v):null);
/** Row from an active-launch manifest (runtime file). Returns null with a reason when the manifest names no campaign yet. */
export function campaignFromManifest(m,path,registryStatus,{root=ROOT}={}){
 if(!m||typeof m!=='object')return {row:null,reason:'not an object'};
 if(!isAddress(m.address))return {row:null,reason:'no campaign address yet (coin made, campaign not created)'};
 if(!isAddress(m.genesisHash)||!isAddress(m.programId))return {row:null,reason:'manifest lacks genesisHash or programId'};
 const parents=Array.isArray(m.parentMints)?m.parentMints.filter(isAddress):null;
 return {row:{genesisHash:m.genesisHash,programId:m.programId,campaign:m.address,network:['localnet','devnet','mainnet'].includes(m.network)?m.network:null,mode:'family',campaignVersion:Number.isInteger(m.version)?m.version:LEGACY_CAMPAIGN_VERSION,registryStatus,chainStatus:m.ready===true?null:'scheduled',legacyAdapterVersion:LEGACY_ADAPTER_VERSION,sourcePaths:[rel(root,path)],creator:isAddress(m.creator)?m.creator:null,nonce:dec(m.nonce),mint:isAddress(m.mint)?m.mint:null,dev:isAddress(m.dev)?m.dev:null,treasury:isAddress(m.treasury)?m.treasury:null,parentMints:parents&&parents.length?parents:null,opensAt:typeof m.opensAt==='string'&&!Number.isNaN(Date.parse(m.opensAt))?m.opensAt:null,deadlineUnix:num(m.deadline),launchDeadlineUnix:num(m.launchDeadline),softCapLamports:dec(m.soft),hardCapLamports:dec(m.hard),supplyRaw:dec(m.supply),terms:{feeNft:isAddress(m.feeNft)?m.feeNft:null,programSha256:typeof m.programSha256==='string'?m.programSha256:null}}};
}
/** Row from a campaign plan (deployment/mainnet/campaign-plan*.json). The genesis comes from the plan's network. */
export function campaignFromPlan(p,path,registryStatus,{root=ROOT,genesisHash=null}={}){
 if(!p||typeof p!=='object')return {row:null,reason:'not an object'};
 const genesis=genesisHash||GENESIS_BY_NETWORK[p.network]||null;
 if(!genesis)return {row:null,reason:'plan network '+p.network+' has no fixed genesis hash; pass genesisHash'};
 if(!isAddress(p.campaign)||!isAddress(p.programId))return {row:null,reason:'plan lacks campaign or programId'};
 const parents=Array.isArray(p.parents)?p.parents.map(x=>x?.mint).filter(isAddress):null;
 const terms={deadlineSeconds:num(p.terms?.deadlineSeconds),plannedAt:typeof p.plannedAt==='string'?p.plannedAt:null,snapshotDirectory:typeof p.snapshotDirectory==='string'?p.snapshotDirectory:null};
 return {row:{genesisHash:genesis,programId:p.programId,campaign:p.campaign,network:p.network,mode:'family',campaignVersion:LEGACY_CAMPAIGN_VERSION,registryStatus,legacyAdapterVersion:LEGACY_ADAPTER_VERSION,sourcePaths:[rel(root,path)],creator:isAddress(p.creator)?p.creator:null,nonce:dec(p.nonce),mint:isAddress(p.mint)?p.mint:null,name:typeof p.token?.name==='string'?p.token.name.slice(0,80):null,symbol:typeof p.token?.symbol==='string'?p.token.symbol.slice(0,20):null,dev:isAddress(p.dev)?p.dev:null,treasury:isAddress(p.treasury)?p.treasury:null,parentMints:parents&&parents.length?parents:null,opensAt:typeof p.opensAt==='string'&&!Number.isNaN(Date.parse(p.opensAt))?p.opensAt:null,softCapLamports:dec(p.terms?.soft),hardCapLamports:dec(p.terms?.hard),terms}};
}
/** Row from deployment/MAINNET-IDENTITIES.json firstCampaign (the historical launched test campaign). */
export function campaignFromIdentities(ident,path,{root=ROOT}={}){
 const f=ident?.firstCampaign;if(!f||!isAddress(f.campaign))return {row:null,reason:'no firstCampaign'};
 if(!isAddress(ident.genesisHash)||!isAddress(ident.program?.programId))return {row:null,reason:'identities lack genesisHash or program.programId'};
 const launched=typeof f.launchSignature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(f.launchSignature);
 return {row:{genesisHash:ident.genesisHash,programId:ident.program.programId,campaign:f.campaign,network:ident.network||'mainnet',mode:'family',campaignVersion:LEGACY_CAMPAIGN_VERSION,registryStatus:'historical',chainStatus:launched?'launched':null,legacyAdapterVersion:LEGACY_ADAPTER_VERSION,sourcePaths:[rel(root,path)],mint:isAddress(f.coinMint)?f.coinMint:null,pool:isAddress(f.pool)?f.pool:null,launchSignature:launched?f.launchSignature:null,launchedAt:typeof f.launchedAt==='string'&&!Number.isNaN(Date.parse(f.launchedAt))?f.launchedAt:null,parentMints:Array.isArray(ident.parents)?ident.parents.map(p=>p?.mint).filter(isAddress):null,dev:isAddress(ident.devWallet?.address)?ident.devWallet.address:null,treasury:isAddress(ident.treasuryWallet?.address)?ident.treasuryWallet.address:null,terms:{note:typeof f.terms==='string'?f.terms.slice(0,200):null}}};
}
/** Collects every source row in rank order (lowest first, so the highest-ranked source lands last and wins the mutable fields). */
export function collectLegacySources(sources){
 const found=[],skipped=[];const add=(kind,path,made)=>{if(made.row)found.push({kind,path,row:made.row});else skipped.push({kind,path,reason:made.reason});};
 const {root}=sources;
 if(sources.identitiesPath&&existsSync(sources.identitiesPath)){try{add('identities',sources.identitiesPath,campaignFromIdentities(readJson(sources.identitiesPath),sources.identitiesPath,{root}));}catch(e){skipped.push({kind:'identities',path:sources.identitiesPath,reason:'unreadable: '+e.message});}}
 if(sources.planPath&&existsSync(sources.planPath)){try{add('plan',sources.planPath,campaignFromPlan(readJson(sources.planPath),sources.planPath,'planned',{root}));}catch(e){skipped.push({kind:'plan',path:sources.planPath,reason:'unreadable: '+e.message});}}
 if(sources.archiveDir&&existsSync(sources.archiveDir)){
  for(const name of readdirSync(sources.archiveDir).filter(n=>/^campaign-plan-.+\.json$/.test(n)).sort()){const path=join(sources.archiveDir,name);try{const made=campaignFromPlan(readJson(path),path,'archived',{root});if(made.row&&name!=='campaign-plan-'+made.row.campaign+'.json')made.reason='archive file name does not match its campaign',made.row=null;add('plan-archive',path,made);}catch(e){skipped.push({kind:'plan-archive',path,reason:'unreadable: '+e.message});}}
 }
 const runtimeArchive=sources.runtimeDir?join(sources.runtimeDir,'archive'):null;
 if(runtimeArchive&&existsSync(runtimeArchive)){
  for(const name of readdirSync(runtimeArchive).filter(n=>ADDRESS.test(n)).sort()){const path=join(runtimeArchive,name,'active-launch.json');if(!existsSync(path)||!statSync(path).isFile())continue;try{const made=campaignFromManifest(readJson(path),path,'archived',{root});if(made.row&&made.row.campaign!==name)made.reason='archive folder name does not match its campaign',made.row=null;add('runtime-archive',path,made);}catch(e){skipped.push({kind:'runtime-archive',path,reason:'unreadable: '+e.message});}}
 }
 const active=sources.runtimeDir?join(sources.runtimeDir,'active-launch.json'):null;
 if(active&&existsSync(active)){try{add('active',active,campaignFromManifest(readJson(active),active,'active',{root}));}catch(e){skipped.push({kind:'active',path:active,reason:'unreadable: '+e.message});}}
 return {found,skipped};
}
/** Imports every source into the registry with one atomic upsert per source; idempotent and resumable. Returns per-campaign results and skips. */
export async function importLegacyCampaigns({registry,sources=defaultSources(),log=null}={}){
 if(!registry)throw Error('importLegacyCampaigns needs a registry');
 const {found,skipped}=collectLegacySources(sources);
 const results=new Map();
  for(const item of found){
   const r=await registry.campaigns.upsert(item.row);
   const key=r.campaign.genesisHash+':'+r.campaign.programId+':'+r.campaign.campaign;
   const entry=results.get(key)||{campaign:r.campaign.campaign,genesisHash:r.campaign.genesisHash,programId:r.campaign.programId,inserted:false,updated:false,conflicts:[],sources:[]};
   entry.inserted=entry.inserted||r.inserted;entry.updated=entry.updated||r.updated;entry.conflicts=[...new Set([...entry.conflicts,...r.conflicts.map(f=>item.kind+':'+f)])];entry.sources.push(item.kind);entry.registryStatus=r.campaign.registryStatus;entry.chainStatus=r.campaign.chainStatus;
   results.set(key,entry);
  }
 const rows=[...results.values()];
 if(log)log({event:'legacy-campaigns-imported',campaigns:rows.length,inserted:rows.filter(r=>r.inserted).length,updated:rows.filter(r=>r.updated).length,conflicts:rows.filter(r=>r.conflicts.length).length,skipped:skipped.length});
 return {rows,skipped,total:await registry.campaigns.count()};
}
