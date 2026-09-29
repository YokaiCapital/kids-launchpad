// Campaign registry (plan section 8): the durable operational record for many campaigns at once. Campaign identity is
// (genesis hash, program id, campaign address); a slug is an alias only. Amounts are decimal strings, slots are integers,
// times are ISO 8601 text. The chain stays authoritative: rows carry the slot and commitment they were projected from.
//
// Two adapters share one SQL text (SQL below, `?` placeholders; toPostgresPlaceholders rewrites them to $n):
//   * SqliteRegistry on node:sqlite (staged option: the API volume, single writer, BEGIN IMMEDIATE transactions);
//   * PostgresRegistry, an asynchronous pooled adapter; production callers await all operations.
// Nothing here talks to the chain or to any campaign file; import-legacy.mjs and read-adapters.mjs do that.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {canonicalJson} from './canonical.mjs';
import {NEVER_GRANTABLE_TAGS} from '../signer-policy.mjs';
import {PostgresRegistry} from './postgres.mjs';
import {operatorPacketsApi} from './operator-packets.mjs';
import {budgetAccounting} from './budget-accounting.mjs';
import {admissionApi} from './admission.mjs';
import {leaseAuthorityApi} from './lease-authority.mjs';
export {PostgresRegistry};
export const REGISTRY_SCHEMA_VERSION=42;
export const MIGRATIONS=Object.freeze([Object.freeze({version:1,name:'p1-registry',file:fileURLToPath(new URL('./schema.sql',import.meta.url))}),Object.freeze({version:2,name:'p3-operations',file:fileURLToPath(new URL('./migration-2-operations.sql',import.meta.url))}),Object.freeze({version:3,name:'wallet-packets',file:fileURLToPath(new URL('./migration-3-wallet.sql',import.meta.url))}),Object.freeze({version:4,name:'shared-wallet-auth',file:fileURLToPath(new URL('./migration-4-auth.sql',import.meta.url))}),Object.freeze({version:5,name:'operator-packets',file:fileURLToPath(new URL('./migration-5-operator-packets.sql',import.meta.url))}),Object.freeze({version:6,name:'budget-operations',file:fileURLToPath(new URL('./migration-6-budget-operations.sql',import.meta.url))}),Object.freeze({version:7,name:'capability-version',file:fileURLToPath(new URL('./migration-7-capability-version.sql',import.meta.url))}),Object.freeze({version:8,name:'upstream-admission',file:fileURLToPath(new URL('./migration-8-admission.sql',import.meta.url))}),Object.freeze({version:9,name:'capability-lookup',file:fileURLToPath(new URL('./migration-9-capability-lookup.sql',import.meta.url))}),Object.freeze({version:10,name:'shared-market',file:fileURLToPath(new URL('./migration-10-market.sql',import.meta.url))}),Object.freeze({version:11,name:'creation-review',file:fileURLToPath(new URL('./migration-11-creation.sql',import.meta.url))}),Object.freeze({version:12,name:'market-identity',file:fileURLToPath(new URL('./migration-12-market-identity.sql',import.meta.url))}),Object.freeze({version:13,name:'issuer-version',file:fileURLToPath(new URL('./migration-13-issuer-version.sql',import.meta.url))}),Object.freeze({version:14,name:'creation-preparation',file:fileURLToPath(new URL('./migration-14-creation-preparation.sql',import.meta.url))}),Object.freeze({version:15,name:'creation-publication',file:fileURLToPath(new URL('./migration-15-publication.sql',import.meta.url))}),Object.freeze({version:16,name:'creator-mint-offers',file:fileURLToPath(new URL('./migration-16-mint-offers.sql',import.meta.url))}),Object.freeze({version:17,name:'private-artwork',file:fileURLToPath(new URL('./migration-17-private-artwork.sql',import.meta.url))}),Object.freeze({version:18,name:'creator-provision-plans',file:fileURLToPath(new URL('./migration-18-provision-plans.sql',import.meta.url))}),Object.freeze({version:19,name:'creator-provision-offers',file:fileURLToPath(new URL('./migration-19-provision-offers.sql',import.meta.url))}),Object.freeze({version:20,name:'creator-provision-revisions',file:fileURLToPath(new URL('./migration-20-provision-revisions.sql',import.meta.url))}),Object.freeze({version:21,name:'native-setup-revisions',file:fileURLToPath(new URL('./migration-21-native-setup-revisions.sql',import.meta.url))}),Object.freeze({version:22,name:'mint-retries',file:fileURLToPath(new URL('./migration-22-mint-retries.sql',import.meta.url))}),Object.freeze({version:23,name:'operating-holds',file:fileURLToPath(new URL('./migration-23-operating-holds.sql',import.meta.url))}),Object.freeze({version:24,name:'operating-message-identity',file:fileURLToPath(new URL('./migration-24-operating-message.sql',import.meta.url))}),Object.freeze({version:25,name:'standard-fee-activation',file:fileURLToPath(new URL('./migration-25-fee-activation.sql',import.meta.url))}),Object.freeze({version:26,name:'standard-lifecycle',file:fileURLToPath(new URL('./migration-26-lifecycle.sql',import.meta.url))}),Object.freeze({version:27,name:'worker-observation',file:fileURLToPath(new URL('./migration-27-observation.sql',import.meta.url))}),Object.freeze({version:28,name:'signer-ownership',file:fileURLToPath(new URL('./migration-28-signer-ownership.sql',import.meta.url))}),Object.freeze({version:29,name:'fee-projection',file:fileURLToPath(new URL('./migration-29-fee-projection.sql',import.meta.url))}),Object.freeze({version:30,name:'public-activity',file:fileURLToPath(new URL('./migration-30-public-activity.sql',import.meta.url))}),Object.freeze({version:31,name:'creator-directory',file:fileURLToPath(new URL('./migration-31-creator-directory.sql',import.meta.url))}),Object.freeze({version:32,name:'position-discovery',file:fileURLToPath(new URL('./migration-32-position-discovery.sql',import.meta.url))}),Object.freeze({version:33,name:'directory-order',file:fileURLToPath(new URL('./migration-33-directory-order.sql',import.meta.url))}),Object.freeze({version:34,name:'campaign-projection',file:fileURLToPath(new URL('./migration-34-campaign-projection.sql',import.meta.url))}),Object.freeze({version:35,name:'profile-media',file:fileURLToPath(new URL('./migration-35-profile-media.sql',import.meta.url))}),Object.freeze({version:36,name:'video-media',file:fileURLToPath(new URL('./migration-36-video-media.sql',import.meta.url))}),Object.freeze({version:37,name:'worker-presence',file:fileURLToPath(new URL('./migration-37-worker-presence.sql',import.meta.url))}),Object.freeze({version:38,name:'audited-job-recovery',file:fileURLToPath(new URL('./migration-38-job-recovery.sql',import.meta.url))}),Object.freeze({version:39,name:'operating-refills',file:fileURLToPath(new URL('./migration-39-operating-refills.sql',import.meta.url))}),Object.freeze({version:40,name:'creation-work',file:fileURLToPath(new URL('./migration-40-creation-work.sql',import.meta.url))}),Object.freeze({version:41,name:'lookup-table-plans',file:fileURLToPath(new URL('./migration-41-lookup-table-plans.sql',import.meta.url))}),Object.freeze({version:42,name:'publication-seal',file:fileURLToPath(new URL('./migration-42-publication-seal.sql',import.meta.url))})]);
export const MODES=Object.freeze(['family','standard']);
/** Where the record comes from today; higher rank wins when several sources describe one campaign. */
export const REGISTRY_STATUSES=Object.freeze(['historical','planned','archived','active']);
/** Phase last read from the chain (activeAmounts wording) plus 'scheduled' (coin made, campaign not yet created). */
export const CHAIN_STATUSES=Object.freeze(['scheduled','open','awaiting-launch','launched','failed']);
export const JOB_STATES=Object.freeze(['queued','leased','done','failed']);
/** Mint lease states (plan section 9): reserved -> signed-pending -> consumed; released only when proven never signed and absent on chain. */
export const MINT_LEASE_STATES=Object.freeze(['reserved','releasing','signed-pending','consumed','quarantined','released']);
export function assertMintTransition(from,to){
 const allowed={reserved:['signed-pending','releasing','quarantined'],releasing:['released','signed-pending','quarantined'],'signed-pending':['signed-pending','consumed','quarantined'],quarantined:['quarantined'],consumed:[],released:[]};
 if(!allowed[from]?.includes(to))throw Error('Mint lease transition is not permitted');
}
export const CAPABILITY_KINDS=Object.freeze(['keeper','fee-setup','operating-return']);
export const EVENT_STATUSES=Object.freeze(['confirmed','finalized','failed','dropped']);
export const DEFAULT_PAGE=50,MAX_PAGE=200,MAX_SOURCE_PATHS=64;
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{64,90}$/,DECIMAL=/^\d{1,40}$/,PATH=/^\d{1,4}(\.\d{1,4})*$/,KEY=/^[A-Za-z0-9_.:-]{1,128}$/,SLUG=/^[a-z0-9][a-z0-9-]{0,62}$/,HEX64=/^[a-f0-9]{64}$/;
const isoNow=(now)=>new Date(now()).toISOString();
export const isAddress=v=>typeof v==='string'&&ADDRESS.test(v);
/** Splits a migration file into statements: every statement ends with a semicolon at the end of its line; comment lines are dropped. */
export function splitStatements(sql){
 const lines=sql.split('\n').filter(l=>!/^\s*--/.test(l));
 return lines.join('\n').split(/;\s*\n/).map(s=>s.trim()).filter(Boolean).map(s=>s.endsWith(';')?s.slice(0,-1):s);
}
/** `?` placeholders become $1..$n for a PostgreSQL driver; string literals are not present in this module's SQL. */
export function toPostgresPlaceholders(sql){let n=0;return sql.replace(/\?/g,()=>'$'+(++n));}
/** Validates and normalizes a campaign identity {genesisHash, programId, campaign}. */
export function campaignIdentity(x){
 if(!x||!isAddress(x.genesisHash)||!isAddress(x.programId)||!isAddress(x.campaign))throw Error('Campaign identity needs genesisHash, programId and campaign addresses');
 return {genesisHash:x.genesisHash,programId:x.programId,campaign:x.campaign};
}
export const campaignId=identity=>{const i=campaignIdentity(identity);return i.genesisHash+':'+i.programId+':'+i.campaign;};
/** Accepts a campaign address or `genesis:program:campaign`; returns {campaign} or a full identity, null when malformed. */
export function parseCampaignId(text){
 if(typeof text!=='string'||text.length>140)return null;
 const parts=text.split(':');
 if(parts.length===1)return isAddress(parts[0])?{campaign:parts[0]}:null;
 if(parts.length!==3||!parts.every(isAddress))return null;
 return {genesisHash:parts[0],programId:parts[1],campaign:parts[2]};
}
export const encodeCursor=c=>Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeCursor(text){
 if(text==null)return null;if(typeof text!=='string'||!text||text.length>200||!/^[A-Za-z0-9_-]+$/.test(text))throw Error('Invalid cursor');
 let c;try{c=JSON.parse(Buffer.from(text,'base64url').toString('utf8'));}catch{throw Error('Invalid cursor');}
 if(!c||!Number.isSafeInteger(c.o)||c.o<1)throw Error('Invalid cursor');return c;
}
/** Shared keyset ordering. Sort is an allow-list, never interpolated input. */
export function campaignOrdering(sort='newest',cursor=null){
 if(!['newest','closing','name'].includes(sort))throw Error('Invalid directory sort');
 const c=decodeCursor(cursor);if(c&&(c.s??'newest')!==sort)throw Error('Cursor sort mismatch');
 const before=c?.o??null;
 if(sort==='newest')return {tail:' AND (CAST(? AS BIGINT) IS NULL OR ordinal<?) ORDER BY ordinal DESC LIMIT ?',params:[before,before],cursor:row=>encodeCursor({o:row.ordinal,s:sort})};
 const expression=sort==='closing'?'COALESCE(deadline_unix,9007199254740991)':"LOWER(COALESCE(name,''))";
 const anchor='(SELECT '+expression+' FROM campaigns WHERE ordinal=?)';
 return {tail:' AND (CAST(? AS BIGINT) IS NULL OR '+expression+'>'+anchor+' OR ('+expression+'='+anchor+' AND ordinal<?)) ORDER BY '+expression+' ASC,ordinal DESC LIMIT ?',params:[before,before,before,before],cursor:row=>encodeCursor({o:row.ordinal,s:sort})};
}
const CAMPAIGN_COLUMNS=['genesis_hash','program_id','campaign','ordinal','slug','network','mode','campaign_version','terms_hash','terms_json','registry_status','chain_status','source_slot','source_commitment','legacy_adapter_version','source_paths','creator','nonce','mint','pool','name','symbol','dev','treasury','parent_mints','opens_at','deadline_unix','launch_deadline_unix','soft_cap_lamports','hard_cap_lamports','supply_raw','launch_signature','launched_at','created_at','updated_at'];
/** Sealed terms never change after the first non-null value: a different value from another source is reported, not applied. */
export const SEALED_FIELDS=Object.freeze(['mode','campaignVersion','creator','nonce','mint','dev','treasury','parentMints','deadlineUnix','launchDeadlineUnix','softCapLamports','hardCapLamports','supplyRaw','termsHash']);
const camel=s=>s.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
export const SQL=Object.freeze({
 migrationsApplied:'SELECT version FROM schema_migrations ORDER BY version ASC',
 migrationApply:'INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)',
 campaignGet:'SELECT * FROM campaigns WHERE genesis_hash=? AND program_id=? AND campaign=?',
 campaignByAddress:'SELECT * FROM campaigns WHERE campaign=? ORDER BY ordinal ASC',
 campaignBySlug:'SELECT * FROM campaigns WHERE slug=?',
 campaignNextOrdinal:'SELECT COALESCE(MAX(ordinal),0)+1 AS next FROM campaigns',
 campaignInsert:'INSERT INTO campaigns('+CAMPAIGN_COLUMNS.join(',')+') VALUES('+CAMPAIGN_COLUMNS.map(()=>'?').join(',')+')',
 campaignUpdate:'UPDATE campaigns SET '+CAMPAIGN_COLUMNS.filter(c=>!['genesis_hash','program_id','campaign','ordinal','created_at'].includes(c)).map(c=>c+'=?').join(',')+' WHERE genesis_hash=? AND program_id=? AND campaign=?',
 campaignList:"SELECT * FROM campaigns WHERE (CAST(? AS TEXT) IS NULL OR chain_status=?) AND (CAST(? AS INTEGER) IS NULL OR chain_status IS NULL) AND (CAST(? AS TEXT) IS NULL OR mode=?) AND (CAST(? AS TEXT) IS NULL OR registry_status=?) AND (CAST(? AS TEXT) IS NULL OR creator=?) AND (CAST(? AS TEXT) IS NULL OR LOWER(name) LIKE ? ESCAPE '!' OR LOWER(symbol) LIKE ? ESCAPE '!' OR campaign=?) AND (CAST(? AS BIGINT) IS NULL OR ordinal<?) ORDER BY ordinal DESC LIMIT ?",
 campaignCount:'SELECT COUNT(*) AS n FROM campaigns',
 intentInsert:'INSERT INTO transaction_intents(intent_id,genesis_hash,program_id,campaign,wallet,action,idempotency_key,message_digest,params_json,status,signature,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(genesis_hash,program_id,campaign,wallet,action,idempotency_key) DO NOTHING',
 intentByKey:'SELECT * FROM transaction_intents WHERE genesis_hash=? AND program_id=? AND campaign=? AND wallet=? AND action=? AND idempotency_key=?',
 intentGet:'SELECT * FROM transaction_intents WHERE intent_id=?',
 intentProgress:'UPDATE transaction_intents SET status=?,signature=COALESCE(?,signature),message_digest=COALESCE(message_digest,?),updated_at=? WHERE intent_id=?',
 jobInsert:'INSERT INTO jobs(job_id,genesis_hash,program_id,campaign,operation_key,job_class,state,payload_json,result_json,retry_count,lease_owner,lease_expires_at,fencing_token,created_at,updated_at,not_before,deadline_at) VALUES(?,?,?,?,?,?,?,?,NULL,0,NULL,NULL,0,?,?,?,?) ON CONFLICT(genesis_hash,program_id,campaign,operation_key) DO NOTHING',
 jobByKey:'SELECT * FROM jobs WHERE genesis_hash=? AND program_id=? AND campaign=? AND operation_key=?',
 jobGet:'SELECT * FROM jobs WHERE job_id=?',
 jobNext:"SELECT * FROM jobs WHERE (state='queued' OR (state='leased' AND lease_expires_at<=?)) AND (not_before IS NULL OR not_before<=?) AND (CAST(? AS TEXT) IS NULL OR job_class=?) ORDER BY created_at ASC, job_id ASC LIMIT 1",
 jobDue:"SELECT * FROM jobs WHERE (state='queued' OR (state='leased' AND lease_expires_at<=?)) AND (not_before IS NULL OR not_before<=?) ORDER BY created_at ASC, job_id ASC LIMIT ?",
 jobHolds:"SELECT 1 AS held FROM jobs WHERE job_id=? AND fencing_token=? AND state='leased' AND lease_owner=? AND lease_expires_at>?",
 jobRequeue:"UPDATE jobs SET state='queued',result_json=?,not_before=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=? AND fencing_token=? AND state='leased' AND lease_expires_at>?",
 jobListCampaign:'SELECT * FROM jobs WHERE genesis_hash=? AND program_id=? AND campaign=? ORDER BY created_at ASC, job_id ASC LIMIT ?',
 capabilityInsert:'INSERT INTO signer_capabilities(capability_id,genesis_hash,program_id,campaign,kind,tags_json,recipients_json,limits_json,expires_at,revoked_at,created_at,program_version) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?)',
 capabilityList:'SELECT * FROM signer_capabilities WHERE revoked_at IS NULL AND expires_at>? ORDER BY created_at ASC, capability_id ASC',
 capabilityAll:'SELECT * FROM signer_capabilities ORDER BY created_at ASC, capability_id ASC',
 capabilityLatest:'SELECT created_at FROM signer_capabilities WHERE genesis_hash=? AND program_id=? AND campaign=? ORDER BY created_at DESC,capability_id DESC LIMIT 1',
 capabilityForCampaign:'SELECT * FROM signer_capabilities WHERE genesis_hash=? AND program_id=? AND campaign=? ORDER BY created_at DESC,capability_id DESC LIMIT 1',
 capabilityRevoke:'UPDATE signer_capabilities SET revoked_at=? WHERE capability_id=? AND revoked_at IS NULL',
 budgetGet:'SELECT * FROM operational_budgets WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=?',
 budgetInsert:'INSERT INTO operational_budgets(genesis_hash,program_id,campaign,payer,reserved_lamports,spent_lamports,returned_lamports,policy,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
 budgetUpdate:'UPDATE operational_budgets SET reserved_lamports=?,spent_lamports=?,returned_lamports=?,policy=?,updated_at=? WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=?',
 leaseInsert:'INSERT INTO mint_leases(lease_id,mint,genesis_hash,program_id,campaign,creator,state,signer_ref,created_at,updated_at,network,draft_id,idempotency_key,message_digest,signature,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)',
 leaseGet:'SELECT * FROM mint_leases WHERE lease_id=?',
 leaseByBinding:'SELECT * FROM mint_leases WHERE creator=? AND idempotency_key=?',
 leaseByMint:'SELECT * FROM mint_leases WHERE mint=?',
 leaseUpdate:'UPDATE mint_leases SET state=?,message_digest=?,signature=?,reason=?,updated_at=? WHERE lease_id=? AND state=?',
 leaseRebind:"UPDATE mint_leases SET lease_id=?,genesis_hash=?,program_id=?,campaign=?,creator=?,state='reserved',signer_ref=?,updated_at=?,network=?,draft_id=?,idempotency_key=?,message_digest=NULL,signature=NULL,reason=? WHERE lease_id=? AND state='released'",
 leaseCounts:'SELECT state, COUNT(*) AS n FROM mint_leases GROUP BY state',
 leaseList:'SELECT * FROM mint_leases WHERE state=? ORDER BY created_at ASC, lease_id ASC LIMIT ?',
 jobLease:"UPDATE jobs SET state='leased',lease_owner=?,lease_expires_at=?,fencing_token=fencing_token+1,retry_count=retry_count+?,updated_at=? WHERE job_id=? AND fencing_token=? AND (state='queued' OR (state='leased' AND lease_expires_at<=?))",
 jobRenew:"UPDATE jobs SET lease_expires_at=?,updated_at=? WHERE job_id=? AND fencing_token=? AND state='leased' AND lease_owner=? AND lease_expires_at>?",
 jobComplete:"UPDATE jobs SET state='done',result_json=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=? AND fencing_token=? AND state='leased' AND lease_expires_at>?",
 jobFail:"UPDATE jobs SET state=?,result_json=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=? AND fencing_token=? AND state='leased' AND lease_expires_at>?",
 eventGet:'SELECT * FROM chain_events WHERE genesis_hash=? AND signature=? AND instruction_path=? AND kind=?',
 eventInsert:"INSERT INTO chain_events(genesis_hash,signature,instruction_path,kind,program_id,campaign,slot,block_time,status,asset_json,payload_json,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(genesis_hash,signature,instruction_path,kind) DO UPDATE SET status=CASE WHEN excluded.status='finalized' THEN 'finalized' ELSE chain_events.status END, block_time=COALESCE(chain_events.block_time,excluded.block_time)",
 eventList:'SELECT * FROM chain_events WHERE genesis_hash=? AND program_id=? AND campaign=? ORDER BY slot DESC, signature DESC, instruction_path DESC LIMIT ?',
});
const parseJson=(text,fallback)=>{if(text==null)return fallback;try{return JSON.parse(text);}catch{return fallback;}};
function rowToCampaign(r){
 if(!r)return null;const out={};
 for(const [k,v] of Object.entries(r)){const key=camel(k);out[key]=v;}
 out.sourcePaths=parseJson(r.source_paths,[]);out.parentMints=parseJson(r.parent_mints,null);out.terms=parseJson(r.terms_json,null);delete out.termsJson;
 for(const k of ['ordinal','campaignVersion','sourceSlot','deadlineUnix','launchDeadlineUnix'])if(out[k]!=null)out[k]=Number(out[k]);
 return out;
}
const rowToIntent=r=>r?{intentId:r.intent_id,genesisHash:r.genesis_hash,programId:r.program_id,campaign:r.campaign,wallet:r.wallet,action:r.action,idempotencyKey:r.idempotency_key,messageDigest:r.message_digest,params:parseJson(r.params_json,null),status:r.status,signature:r.signature,createdAt:r.created_at,updatedAt:r.updated_at}:null;
const rowToJob=r=>r?{jobId:r.job_id,genesisHash:r.genesis_hash,programId:r.program_id,campaign:r.campaign,operationKey:r.operation_key,jobClass:r.job_class,state:r.state,payload:parseJson(r.payload_json,null),result:parseJson(r.result_json,null),retryCount:Number(r.retry_count),leaseOwner:r.lease_owner,leaseExpiresAt:r.lease_expires_at,fencingToken:Number(r.fencing_token),createdAt:r.created_at,updatedAt:r.updated_at,notBefore:r.not_before??null,deadlineAt:r.deadline_at??null}:null;
const rowToCapability=r=>r?{capabilityId:r.capability_id,genesisHash:r.genesis_hash,programId:r.program_id,campaign:r.campaign,kind:r.kind,programVersion:Number(r.program_version),tags:parseJson(r.tags_json,[]),recipients:parseJson(r.recipients_json,[]),limits:parseJson(r.limits_json,{}),expiresAt:r.expires_at,revokedAt:r.revoked_at,createdAt:r.created_at}:null;
const rowToBudget=r=>r?{genesisHash:r.genesis_hash,programId:r.program_id,campaign:r.campaign,payer:r.payer,reservedLamports:r.reserved_lamports,spentLamports:r.spent_lamports,returnedLamports:r.returned_lamports,policy:r.policy,updatedAt:r.updated_at}:null;
const rowToLease=r=>r?{leaseId:r.lease_id,mint:r.mint,genesisHash:r.genesis_hash,programId:r.program_id,campaign:r.campaign,creator:r.creator,state:r.state,signerRef:r.signer_ref,network:r.network,draftId:r.draft_id,idempotencyKey:r.idempotency_key,messageDigest:r.message_digest,signature:r.signature,reason:r.reason,createdAt:r.created_at,updatedAt:r.updated_at}:null;
const rowToEvent=r=>r?{genesisHash:r.genesis_hash,signature:r.signature,instructionPath:r.instruction_path,kind:r.kind,programId:r.program_id,campaign:r.campaign,slot:Number(r.slot),blockTime:r.block_time==null?null:Number(r.block_time),status:r.status,asset:parseJson(r.asset_json,null),payload:parseJson(r.payload_json,null),observedAt:r.observed_at}:null;
const optAddress=(v,name)=>{if(v==null)return null;if(!isAddress(v))throw Error('Invalid address for '+name);return v;};
const optDecimal=(v,name)=>{if(v==null)return null;const s=typeof v==='bigint'?v.toString():v;if(typeof s!=='string'||!DECIMAL.test(s))throw Error('Amount for '+name+' must be a decimal string');return s;};
const optInt=(v,name)=>{if(v==null)return null;if(!Number.isSafeInteger(v)||v<0)throw Error(name+' must be a non-negative integer');return v;};
const optText=(v,name,max=400)=>{if(v==null)return null;if(typeof v!=='string'||v.length>max)throw Error(name+' must be text of at most '+max+' characters');return v;};
const optIso=(v,name)=>{if(v==null)return null;if(typeof v!=='string'||Number.isNaN(Date.parse(v)))throw Error(name+' must be an ISO time');return v;};
/** Normalizes and validates a campaign row for upsert; every optional field null when absent. */
export function normalizeCampaign(input){
 const id=campaignIdentity(input);
 if(!MODES.includes(input.mode))throw Error('Campaign mode must be one of '+MODES.join(', '));
 if(!Number.isInteger(input.campaignVersion)||input.campaignVersion<1)throw Error('campaignVersion must be a positive integer');
 if(!REGISTRY_STATUSES.includes(input.registryStatus))throw Error('registryStatus must be one of '+REGISTRY_STATUSES.join(', '));
 if(input.chainStatus!=null&&!CHAIN_STATUSES.includes(input.chainStatus))throw Error('chainStatus must be one of '+CHAIN_STATUSES.join(', '));
 const sourcePaths=input.sourcePaths??[];if(!Array.isArray(sourcePaths)||sourcePaths.length>MAX_SOURCE_PATHS||sourcePaths.some(p=>typeof p!=='string'||!p||p.length>400))throw Error('sourcePaths must be a short list of paths');
 const parentMints=input.parentMints==null?null:input.parentMints;if(parentMints!==null&&(!Array.isArray(parentMints)||parentMints.some(m=>!isAddress(m))))throw Error('parentMints must be addresses');
 if(input.slug!=null&&!SLUG.test(input.slug))throw Error('slug must be lowercase letters, digits and dashes');
 if(input.termsHash!=null&&!HEX64.test(input.termsHash))throw Error('termsHash must be a sha256 hex');
 if(input.terms!=null&&(typeof input.terms!=='object'||Array.isArray(input.terms)))throw Error('terms must be an object');
 if(input.network!=null&&!['localnet','devnet','mainnet'].includes(input.network))throw Error('network must be localnet, devnet or mainnet');
 return {...id,slug:input.slug??null,network:input.network??null,mode:input.mode,campaignVersion:input.campaignVersion,termsHash:input.termsHash??null,terms:input.terms??null,registryStatus:input.registryStatus,chainStatus:input.chainStatus??null,sourceSlot:optInt(input.sourceSlot,'sourceSlot'),sourceCommitment:optText(input.sourceCommitment,'sourceCommitment',20),legacyAdapterVersion:optText(input.legacyAdapterVersion,'legacyAdapterVersion',40),sourcePaths:[...new Set(sourcePaths)],creator:optAddress(input.creator,'creator'),nonce:optDecimal(input.nonce,'nonce'),mint:optAddress(input.mint,'mint'),pool:optAddress(input.pool,'pool'),name:optText(input.name,'name',80),symbol:optText(input.symbol,'symbol',20),dev:optAddress(input.dev,'dev'),treasury:optAddress(input.treasury,'treasury'),parentMints,opensAt:optIso(input.opensAt,'opensAt'),deadlineUnix:optInt(input.deadlineUnix,'deadlineUnix'),launchDeadlineUnix:optInt(input.launchDeadlineUnix,'launchDeadlineUnix'),softCapLamports:optDecimal(input.softCapLamports,'softCapLamports'),hardCapLamports:optDecimal(input.hardCapLamports,'hardCapLamports'),supplyRaw:optDecimal(input.supplyRaw,'supplyRaw'),launchSignature:input.launchSignature==null?null:(SIGNATURE.test(input.launchSignature)?input.launchSignature:(()=>{throw Error('Invalid launch signature');})()),launchedAt:optIso(input.launchedAt,'launchedAt')};
}
const same=(a,b)=>canonicalJson(a??null)===canonicalJson(b??null);
/** Merges a normalized row into an existing one: nulls never overwrite, sealed fields keep their first value (conflicts reported),
 * registry status takes the higher rank, chain projections move forward only with a slot at least as new, source paths union. */
export function mergeCampaign(existing,next){
 const conflicts=[],merged={...existing};
 for(const [k,v] of Object.entries(next)){
  if(['genesisHash','programId','campaign','ordinal','createdAt','updatedAt'].includes(k))continue;
  if(v==null)continue;
  if(SEALED_FIELDS.includes(k)){if(existing[k]==null)merged[k]=v;else if(!same(existing[k],v))conflicts.push(k);continue;}
  if(k==='registryStatus'){if(REGISTRY_STATUSES.indexOf(v)>=REGISTRY_STATUSES.indexOf(existing.registryStatus))merged[k]=v;continue;}
  if(k==='sourcePaths'){merged[k]=[...new Set([...(existing.sourcePaths||[]),...v])].slice(0,MAX_SOURCE_PATHS);continue;}
  if(k==='terms'){const t={...(existing.terms||{})};for(const [tk,tv] of Object.entries(v))if(tv!=null)t[tk]=tv;merged[k]=t;continue;}
  if(k==='chainStatus'||k==='sourceSlot'||k==='sourceCommitment'){
   const newer=next.sourceSlot==null?existing.sourceSlot==null:(existing.sourceSlot==null||next.sourceSlot>=existing.sourceSlot);
   if(newer)merged[k]=v;continue;
  }
  merged[k]=v;
 }
 return {merged,conflicts};
}
function campaignValues(c,ordinal,createdAt,updatedAt){
 const parentMints=c.parentMints==null?null:JSON.stringify(c.parentMints),terms=c.terms==null?null:canonicalJson(c.terms);
 return [c.genesisHash,c.programId,c.campaign,ordinal,c.slug,c.network,c.mode,c.campaignVersion,c.termsHash,terms,c.registryStatus,c.chainStatus,c.sourceSlot,c.sourceCommitment,c.legacyAdapterVersion,JSON.stringify(c.sourcePaths),c.creator,c.nonce,c.mint,c.pool,c.name,c.symbol,c.dev,c.treasury,parentMints,c.opensAt,c.deadlineUnix,c.launchDeadlineUnix,c.softCapLamports,c.hardCapLamports,c.supplyRaw,c.launchSignature,c.launchedAt,createdAt,updatedAt];
}
/** Builds the adapter API over a driver exposing get/all/run(sql,params) and transaction(fn); the SQL is identical for every engine. */
export function registryApi(driver,{now=Date.now}={}){
 const {get,all,run,transaction}=driver;
 const campaigns={
  /** Inserts or merges; returns {inserted, updated, conflicts, campaign}. A rerun with the same data changes nothing. */
  upsert(input){
   const next=normalizeCampaign(input);
   return transaction(()=>{
    const existing=rowToCampaign(get(SQL.campaignGet,[next.genesisHash,next.programId,next.campaign]));
    const at=isoNow(now);
    if(!existing){
     const ordinal=Number(get(SQL.campaignNextOrdinal,[]).next);
     run(SQL.campaignInsert,campaignValues(next,ordinal,at,at));
     return {inserted:true,updated:false,conflicts:[],campaign:rowToCampaign(get(SQL.campaignGet,[next.genesisHash,next.programId,next.campaign]))};
    }
    const {merged,conflicts}=mergeCampaign(existing,next);
    const before=campaignValues(existing,existing.ordinal,existing.createdAt,''),after=campaignValues(merged,existing.ordinal,existing.createdAt,'');
    if(before.join('\u0000')===after.join('\u0000'))return {inserted:false,updated:false,conflicts,campaign:existing};
    const values=campaignValues(merged,existing.ordinal,existing.createdAt,at);
    run(SQL.campaignUpdate,[...values.slice(4,33),at,merged.genesisHash,merged.programId,merged.campaign]);
    return {inserted:false,updated:true,conflicts,campaign:rowToCampaign(get(SQL.campaignGet,[next.genesisHash,next.programId,next.campaign]))};
   });
  },
  /** Full identity, or a bare campaign address (unique across genesis and program, else an error asking for the full id). */
  get(ref){
   const id=typeof ref==='string'?parseCampaignId(ref):ref;if(!id)return null;
   if(id.genesisHash)return rowToCampaign(get(SQL.campaignGet,[id.genesisHash,id.programId,id.campaign]));
   const rows=all(SQL.campaignByAddress,[id.campaign]);
   if(rows.length>1){const e=Error('Campaign address is ambiguous across ledgers; use genesis:program:campaign');e.code='AMBIGUOUS';throw e;}
   return rowToCampaign(rows[0]);
  },
  bySlug(slug){if(typeof slug!=='string'||!SLUG.test(slug))return null;return rowToCampaign(get(SQL.campaignBySlug,[slug]));},
  /** Newest first by ordinal; filters: status (a chain status or 'unknown'), mode, registryStatus; cursor from the previous page. */
  list({status=null,mode=null,registryStatus=null,creator=null,query=null,sort='newest',cursor=null,limit=DEFAULT_PAGE}={}){
   if(status!=null&&status!=='unknown'&&!CHAIN_STATUSES.includes(status))throw Error('Unknown status filter');
   if(mode!=null&&!MODES.includes(mode))throw Error('Unknown mode filter');
   if(registryStatus!=null&&!REGISTRY_STATUSES.includes(registryStatus))throw Error('Unknown registryStatus filter');
   if(!Number.isInteger(limit)||limit<1||limit>MAX_PAGE)throw Error('limit must be 1..'+MAX_PAGE);
   if(creator!=null&&!isAddress(creator))throw Error('Invalid creator filter');
   if(query!=null&&(typeof query!=='string'||query.length>100))throw Error('Invalid search');
   const search=query? '%'+query.toLowerCase().replace(/[!%_]/g,'!$&')+'%':null;
   const ordering=campaignOrdering(sort,cursor),chain=status==='unknown'?null:status,unknown=status==='unknown'?1:null;
   const rows=all(SQL.campaignList.split(' AND (CAST(? AS BIGINT)')[0]+ordering.tail,[chain,chain,unknown,mode,mode,registryStatus,registryStatus,creator,creator,search,search,search,query,...ordering.params,limit+1]).map(rowToCampaign);
   const page=rows.slice(0,limit);
   return {campaigns:page,nextCursor:rows.length>limit?ordering.cursor(page[page.length-1]):null};
  },
  count(){return Number(get(SQL.campaignCount,[]).n);},
 };
 const intents={
  /** Idempotent on (campaign, wallet, action, idempotencyKey): the same key returns the same intent; the same key with
   * different financial parameters is refused. Returns {intent, created}. */
  create({genesisHash,programId,campaign,wallet,action,idempotencyKey,params,messageDigest=null,status='prepared'}){
   const id=campaignIdentity({genesisHash,programId,campaign});
   if(!isAddress(wallet))throw Error('Invalid wallet');if(typeof action!=='string'||!KEY.test(action))throw Error('Invalid action');if(typeof idempotencyKey!=='string'||!KEY.test(idempotencyKey))throw Error('Invalid idempotency key');
   if(messageDigest!=null&&!HEX64.test(messageDigest))throw Error('messageDigest must be a sha256 hex');
   const paramsJson=canonicalJson(params??{});
   return transaction(()=>{
    const at=isoNow(now);
    const inserted=Number(run(SQL.intentInsert,[randomUUID(),id.genesisHash,id.programId,id.campaign,wallet,action,idempotencyKey,messageDigest,paramsJson,status,null,at,at]).changes)===1;
    const intent=rowToIntent(get(SQL.intentByKey,[id.genesisHash,id.programId,id.campaign,wallet,action,idempotencyKey]));
    if(!inserted&&canonicalJson(intent.params)!==paramsJson){const e=Error('Idempotency key reused with different parameters');e.code='IDEMPOTENCY_CONFLICT';throw e;}
    if(!inserted&&messageDigest&&intent.messageDigest&&intent.messageDigest!==messageDigest){const e=Error('Idempotency key reused with a different approved message');e.code='IDEMPOTENCY_CONFLICT';throw e;}
    return {intent,created:inserted};
   });
  },
  get(intentId){return rowToIntent(get(SQL.intentGet,[intentId]));},
  /** Moves an intent forward (prepared, signed, submitted, confirmed, failed); the digest is set once, the signature kept once known. */
  progress({intentId,status,signature=null,messageDigest=null}){
   if(typeof status!=='string'||!KEY.test(status))throw Error('Invalid status');if(signature!=null&&!SIGNATURE.test(signature))throw Error('Invalid signature');
   return Number(run(SQL.intentProgress,[status,signature,messageDigest,isoNow(now),intentId]).changes)===1;
  },
 };
 const jobs={
  /** One job per (campaign, operationKey); a repeat enqueue returns the existing job. */
  enqueue({genesisHash,programId,campaign,operationKey,jobClass,payload={},deadlineAt=null,notBefore=null}){
   const id=campaignIdentity({genesisHash,programId,campaign});
   if(typeof operationKey!=='string'||!KEY.test(operationKey))throw Error('Invalid operation key');if(typeof jobClass!=='string'||!KEY.test(jobClass))throw Error('Invalid job class');
   optIso(deadlineAt,'deadlineAt');optIso(notBefore,'notBefore');
   return transaction(()=>{
    const at=isoNow(now);
    const created=Number(run(SQL.jobInsert,[randomUUID(),id.genesisHash,id.programId,id.campaign,operationKey,jobClass,'queued',canonicalJson(payload),at,at,notBefore,deadlineAt]).changes)===1;
    return {job:rowToJob(get(SQL.jobByKey,[id.genesisHash,id.programId,id.campaign,operationKey])),created};
   });
  },
  /** Leases the oldest queued job (or one whose lease expired); the fencing token grows by one on every lease. Returns null when nothing is due. */
  lease({owner,ttlMs=30000,jobClass=null}){
   if(typeof owner!=='string'||!KEY.test(owner))throw Error('Invalid lease owner');if(!Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>3600000)throw Error('ttlMs must be 1 s..1 h');
   return transaction(()=>{
    for(let attempt=0;attempt<5;attempt++){
     const t=now(),at=new Date(t).toISOString(),expires=new Date(t+ttlMs).toISOString();
     const row=get(SQL.jobNext,[at,at,jobClass,jobClass]);if(!row)return null;
     const retry=row.state==='leased'?1:0;
     if(Number(run(SQL.jobLease,[owner,expires,retry,at,row.job_id,row.fencing_token,at]).changes)===1)return rowToJob(get(SQL.jobGet,[row.job_id]));
    }
    return null;
   });
  },
  renew({jobId,token,owner,ttlMs=30000}){if(!Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>3600000)throw Error('Invalid lease duration');const t=now();return Number(run(SQL.jobRenew,[new Date(t+ttlMs).toISOString(),new Date(t).toISOString(),jobId,token,owner,new Date(t).toISOString()]).changes)===1;},
  /** Publishes a result only with the current fencing token; a stale holder gets an error and changes nothing. */
  complete({jobId,token,result={}}){
   if(Number(run(SQL.jobComplete,[canonicalJson(result),isoNow(now),jobId,token,isoNow(now)]).changes)!==1){const e=Error('Stale or unknown lease for job '+jobId);e.code='STALE_LEASE';throw e;}
   return rowToJob(get(SQL.jobGet,[jobId]));
  },
  /** Fails with the current token: requeue=true puts it back in the queue (retry counted at the next lease), else state 'failed'. */
  fail({jobId,token,error,requeue=false,result={}}){
   if(Number(run(SQL.jobFail,[requeue?'queued':'failed',canonicalJson({...result,error:String(error??'').slice(0,400)}),isoNow(now),jobId,token,isoNow(now)]).changes)!==1){const e=Error('Stale or unknown lease for job '+jobId);e.code='STALE_LEASE';throw e;}
   return rowToJob(get(SQL.jobGet,[jobId]));
  },
  get(jobId){return rowToJob(get(SQL.jobGet,[jobId]));},
  /** Every job that could be leased now (queued, or leased with an expired lease, and past its not-before time), oldest first. */
  due({limit=100}={}){if(!Number.isInteger(limit)||limit<1||limit>1000)throw Error('limit must be 1..1000');const at=isoNow(now);return all(SQL.jobDue,[at,at,limit]).map(rowToJob);},
  /** Leases one specific job by id with the token the caller saw; null when another process got there first. */
  leaseById({jobId,token,owner,ttlMs=30000}){
   if(typeof owner!=='string'||!KEY.test(owner))throw Error('Invalid lease owner');if(!Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>3600000)throw Error('ttlMs must be 1 s..1 h');
   return transaction(()=>{
    const row=get(SQL.jobGet,[jobId]);if(!row||Number(row.fencing_token)!==token)return null;
    const t=now(),at=new Date(t).toISOString(),expires=new Date(t+ttlMs).toISOString();
    const retry=row.state==='leased'?1:0;
    if(Number(run(SQL.jobLease,[owner,expires,retry,at,jobId,token,at]).changes)!==1)return null;
    return rowToJob(get(SQL.jobGet,[jobId]));
   });
  },
  /** True while this owner holds the current lease (token and owner match, not expired). Side effects check it first. */
  holds({jobId,token,owner}){return !!get(SQL.jobHolds,[jobId,token,owner,isoNow(now)]);},
  /** Puts a leased job back in the queue with the current token, a result (outcome, attempts, reconcile facts) and a not-before time. */
  requeue({jobId,token,result={},notBefore=null}){
   optIso(notBefore,'notBefore');
   if(Number(run(SQL.jobRequeue,[canonicalJson(result),notBefore,isoNow(now),jobId,token,isoNow(now)]).changes)!==1){const e=Error('Stale or unknown lease for job '+jobId);e.code='STALE_LEASE';throw e;}
   return rowToJob(get(SQL.jobGet,[jobId]));
  },
  listForCampaign({genesisHash,programId,campaign,limit=DEFAULT_PAGE}){const id=campaignIdentity({genesisHash,programId,campaign});if(!Number.isInteger(limit)||limit<1||limit>1000)throw Error('limit must be 1..1000');return all(SQL.jobListCampaign,[id.genesisHash,id.programId,id.campaign,limit]).map(rowToJob);},
 };
 const capabilities={
  /** Grants a signer capability to one campaign. tags: launch-program instruction tags; recipients: addresses whose token
   * accounts the keeper may sponsor (empty for the keeper kind); limits: overrides of the signer's DEFAULT_LIMITS. */
  grant({genesisHash,programId,campaign,kind='keeper',programVersion=1,tags,recipients=[],limits={},expiresAt}){
   const id=campaignIdentity({genesisHash,programId,campaign});
   if(!CAPABILITY_KINDS.includes(kind))throw Error('kind must be one of '+CAPABILITY_KINDS.join(', '));
   if(![1,2,3].includes(programVersion))throw Error('Unknown capability program version');
   if(!Array.isArray(tags)||(!tags.length&&kind!=='operating-return')||tags.some(t=>!Number.isInteger(t)||t<0||t>255))throw Error('tags must be a list of instruction tags 0..255');
   for(const t of tags)if(NEVER_GRANTABLE_TAGS.has(t))throw Error('Tag '+t+' can never be granted: it sets recipients, authorities or parents, or is user-signed');
   if(!Array.isArray(recipients)||recipients.some(r=>!isAddress(r)))throw Error('recipients must be addresses');
   if(kind==='keeper'&&recipients.length)throw Error('a keeper capability carries no recipients');
   if(kind==='fee-setup'&&(programVersion!==3||tags.length!==1||tags[0]!==20||recipients.length<1||recipients.length>2||new Set(recipients).size!==recipients.length))throw Error('Fee setup requires v3, tag 20 and sealed recipients');
   if(kind==='operating-return'&&(programVersion!==3||tags.length!==0||recipients.length!==1))throw Error('Operating return requires v3, no tags and exactly one recipient (the sealed creator)');
   if(!limits||typeof limits!=='object'||Array.isArray(limits)||Object.values(limits).some(v=>!Number.isSafeInteger(v)||v<0))throw Error('limits must be non-negative integers');
   if(typeof expiresAt!=='string'||Number.isNaN(Date.parse(expiresAt)))throw Error('expiresAt must be an ISO time');
   return transaction(()=>{
    const prior=get(SQL.capabilityLatest,[id.genesisHash,id.programId,id.campaign]);
    const at=new Date(Math.max(now(),prior?Date.parse(prior.created_at)+1:0)).toISOString(),capabilityId=randomUUID();
    run(SQL.capabilityInsert,[capabilityId,id.genesisHash,id.programId,id.campaign,kind,JSON.stringify([...new Set(tags)].sort((a,b)=>a-b)),JSON.stringify(recipients),canonicalJson(limits),new Date(Date.parse(expiresAt)).toISOString(),at,programVersion]);
    return rowToCapability(get('SELECT * FROM signer_capabilities WHERE capability_id=?',[capabilityId]));
   });
  },
  /** Live grants (not revoked, not expired) unless includeExpired. */
  list({includeExpired=false}={}){return (includeExpired?all(SQL.capabilityAll,[]):all(SQL.capabilityList,[isoNow(now)])).map(rowToCapability);},
  latest(identity){const id=campaignIdentity(identity);return rowToCapability(get(SQL.capabilityForCampaign,[id.genesisHash,id.programId,id.campaign]));},
  revoke(capabilityId){return Number(run(SQL.capabilityRevoke,[isoNow(now),capabilityId]).changes)===1;},
 };
 const budgets={
  get({genesisHash,programId,campaign,payer}){const id=campaignIdentity({genesisHash,programId,campaign});if(!isAddress(payer))throw Error('Invalid payer');return rowToBudget(get(SQL.budgetGet,[id.genesisHash,id.programId,id.campaign,payer]));},
  /** Writes the three counters of one (campaign, payer) row; the caller computes them inside a transaction. */
  put({genesisHash,programId,campaign,payer,reservedLamports,spentLamports,returnedLamports,policy}){
   const id=campaignIdentity({genesisHash,programId,campaign});if(!isAddress(payer))throw Error('Invalid payer');
   const r=optDecimal(reservedLamports,'reservedLamports'),s=optDecimal(spentLamports,'spentLamports'),b=optDecimal(returnedLamports,'returnedLamports');if(r==null||s==null||b==null)throw Error('Budget counters are required');
   if(typeof policy!=='string'||!KEY.test(policy))throw Error('Invalid budget policy');
   if(BigInt(s)+BigInt(b)>BigInt(r))throw Error('Budget spends and returns exceed reservation');
   return transaction(()=>{
    const at=isoNow(now);
    if(get(SQL.budgetGet,[id.genesisHash,id.programId,id.campaign,payer]))run(SQL.budgetUpdate,[r,s,b,policy,at,id.genesisHash,id.programId,id.campaign,payer]);
    else run(SQL.budgetInsert,[id.genesisHash,id.programId,id.campaign,payer,r,s,b,policy,at]);
    return rowToBudget(get(SQL.budgetGet,[id.genesisHash,id.programId,id.campaign,payer]));
   });
  },
 };
 const mintLeases={
  /** Inserts a reserved lease. UNIQUE(mint) and UNIQUE(creator, idempotency_key) make a double reservation impossible. */
  insert({mint,genesisHash=null,programId=null,campaign=null,creator,network,draftId,idempotencyKey,signerRef=null}){
   if(!isAddress(mint))throw Error('Invalid mint');if(!isAddress(creator))throw Error('Invalid creator');optAddress(genesisHash,'genesisHash');optAddress(programId,'programId');optAddress(campaign,'campaign');
   if(!['localnet','devnet','mainnet'].includes(network))throw Error('network must be localnet, devnet or mainnet');
   if(typeof draftId!=='string'||!KEY.test(draftId))throw Error('Invalid draft id');if(typeof idempotencyKey!=='string'||!KEY.test(idempotencyKey))throw Error('Invalid idempotency key');
   optText(signerRef,'signerRef',200);
   return transaction(()=>{const at=isoNow(now),leaseId=randomUUID();run(SQL.leaseInsert,[leaseId,mint,genesisHash,programId,campaign,creator,'reserved',signerRef,at,at,network,draftId,idempotencyKey]);return rowToLease(get(SQL.leaseGet,[leaseId]));});
  },
  get(leaseId){return rowToLease(get(SQL.leaseGet,[leaseId]));},
  byBinding({creator,idempotencyKey}){return rowToLease(get(SQL.leaseByBinding,[creator,idempotencyKey]));},
  byMint(mint){return rowToLease(get(SQL.leaseByMint,[mint]));},
  /** Compare-and-set on the state: the row moves from `from` to `to` (fields kept unless given) or the call returns null. */
  transition({leaseId,from,to,messageDigest,signature,reason}){
   if(!MINT_LEASE_STATES.includes(from)||!MINT_LEASE_STATES.includes(to))throw Error('Unknown lease state');
   assertMintTransition(from,to);
   return transaction(()=>{
    const row=rowToLease(get(SQL.leaseGet,[leaseId]));if(!row||row.state!==from)return null;
    if(row.messageDigest!=null&&messageDigest!==undefined&&messageDigest!==row.messageDigest)return null;
    if(row.signature!=null&&signature!==undefined&&signature!==row.signature)return null;
    const digest=messageDigest===undefined?row.messageDigest:messageDigest,sig=signature===undefined?row.signature:signature,why=reason===undefined?row.reason:reason;
    if(digest!=null&&!HEX64.test(digest))throw Error('messageDigest must be a sha256 hex');if(sig!=null&&!SIGNATURE.test(sig))throw Error('Invalid signature');optText(why,'reason',200);
    if(Number(run(SQL.leaseUpdate,[to,digest,sig,why,isoNow(now),leaseId,from]).changes)!==1)return null;
    return rowToLease(get(SQL.leaseGet,[leaseId]));
   });
  },
  /** A released mint goes back to stock; when the inventory hands it out again the same row is rebound to the new binding
   * (UNIQUE(mint) keeps one row per mint). Only a released row can be rebound. The reason records the previous lease. */
  rebind({leaseId,mint,genesisHash=null,programId=null,campaign=null,creator,network,draftId,idempotencyKey,signerRef=null}){
   if(!isAddress(mint))throw Error('Invalid mint');if(!isAddress(creator))throw Error('Invalid creator');optAddress(genesisHash,'genesisHash');optAddress(programId,'programId');optAddress(campaign,'campaign');
   if(!['localnet','devnet','mainnet'].includes(network))throw Error('network must be localnet, devnet or mainnet');
   if(typeof draftId!=='string'||!KEY.test(draftId))throw Error('Invalid draft id');if(typeof idempotencyKey!=='string'||!KEY.test(idempotencyKey))throw Error('Invalid idempotency key');
   return transaction(()=>{
    const row=rowToLease(get(SQL.leaseGet,[leaseId]));if(!row||row.state!=='released'||row.mint!==mint)return null;
    const nextId=randomUUID();const reason=('rebound; previous lease '+row.leaseId).slice(0,200);
    if(Number(run(SQL.leaseRebind,[nextId,genesisHash,programId,campaign,creator,signerRef,isoNow(now),network,draftId,idempotencyKey,reason,leaseId]).changes)!==1)return null;
    return rowToLease(get(SQL.leaseGet,[nextId]));
   });
  },
  counts(){const out={};for(const s of MINT_LEASE_STATES)out[s]=0;for(const r of all(SQL.leaseCounts,[]))out[r.state]=Number(r.n);return out;},
  list({state,limit=DEFAULT_PAGE}){if(!MINT_LEASE_STATES.includes(state))throw Error('Unknown lease state');if(!Number.isInteger(limit)||limit<1||limit>1000)throw Error('limit must be 1..1000');return all(SQL.leaseList,[state,limit]).map(rowToLease);},
 };
 const chainEvents={
  /** Idempotent on (genesis, signature, instruction path, kind): a repeat changes nothing except a finalized status or a late block time. */
  record({genesisHash,signature,instructionPath,kind,programId=null,campaign=null,slot,blockTime=null,status='confirmed',asset=null,payload=null}){
   if(!isAddress(genesisHash))throw Error('Invalid genesis hash');if(!SIGNATURE.test(signature||''))throw Error('Invalid signature');if(!PATH.test(instructionPath||''))throw Error('Invalid instruction path');
   if(typeof kind!=='string'||!KEY.test(kind))throw Error('Invalid event kind');if(!Number.isSafeInteger(slot)||slot<0)throw Error('Invalid slot');
   if(blockTime!=null&&(!Number.isSafeInteger(blockTime)||blockTime<=0))throw Error('Invalid block time');if(!EVENT_STATUSES.includes(status))throw Error('Invalid event status');
   optAddress(programId,'programId');optAddress(campaign,'campaign');
   return transaction(()=>{
    const before=get(SQL.eventGet,[genesisHash,signature,instructionPath,kind]);
    run(SQL.eventInsert,[genesisHash,signature,instructionPath,kind,programId,campaign,slot,blockTime,status,asset==null?null:canonicalJson(asset),payload==null?null:canonicalJson(payload),isoNow(now)]);
    return {inserted:!before,event:rowToEvent(get(SQL.eventGet,[genesisHash,signature,instructionPath,kind]))};
   });
  },
  list({genesisHash,programId,campaign,limit=DEFAULT_PAGE}){const id=campaignIdentity({genesisHash,programId,campaign});if(!Number.isInteger(limit)||limit<1||limit>MAX_PAGE)throw Error('limit must be 1..'+MAX_PAGE);return all(SQL.eventList,[id.genesisHash,id.programId,id.campaign,limit]).map(rowToEvent);},
 };
 const draftRow=r=>r?{id:r.draft_id,creator:r.creator,revision:r.revision,status:r.status,body:JSON.parse(r.body_json),createdAt:r.created_at,updatedAt:r.updated_at}:null;
 const drafts={
  get(creator,id){if(!isAddress(creator)||!KEY.test(id||''))throw Error('Invalid draft identity');return draftRow(get('SELECT * FROM creator_drafts WHERE creator=? AND draft_id=?',[creator,id]));},
  list(creator){if(!isAddress(creator))throw Error('Invalid creator');return all('SELECT * FROM creator_drafts WHERE creator=? ORDER BY updated_at DESC LIMIT 100',[creator]).map(draftRow);},
  save({creator,id,revision,body}){
   if(!isAddress(creator)||!KEY.test(id||''))throw Error('Invalid draft identity');
   if(!Number.isSafeInteger(revision)||revision<0)throw Error('Draft revision required');
   const json=canonicalJson(body);if(Buffer.byteLength(json)>100000)throw Error('Draft too large');
   return transaction(()=>{
    const prior=drafts.get(creator,id);
    if((prior?.revision||0)!==revision){const e=Error('Draft changed in another tab. Reload before saving.');e.code='REVISION_CONFLICT';throw e;}
    if(prior&&prior.status!=='draft')throw Error('A published draft cannot be edited');
    if(!prior&&drafts.list(creator).length>=100)throw Error('Draft limit reached');
    const at=isoNow(now);
    if(prior)run('UPDATE creator_drafts SET body_json=?,revision=?,updated_at=? WHERE creator=? AND draft_id=? AND revision=?',[json,revision+1,at,creator,id,revision]);
    else run('INSERT INTO creator_drafts(creator,draft_id,revision,status,body_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',[creator,id,1,'draft',json,at,at]);
    return drafts.get(creator,id);
   });
  },
 };
 const packetRow=r=>r?{id:r.id,owner:r.owner,campaignId:r.campaign_id,requestKey:r.request_key,descriptor:r.descriptor,prepared:JSON.parse(r.prepared_json),signedBase64:r.signed_base64,signature:r.signature,status:r.status,error:r.error,createdAt:r.created_at}:null;
 const walletPackets={
  get(id){return packetRow(get('SELECT * FROM wallet_packets WHERE id=?',[id]));},
  list(owner){if(!isAddress(owner))throw Error('Invalid wallet');return all('SELECT * FROM wallet_packets WHERE owner=? ORDER BY updated_at DESC LIMIT 50',[owner]).map(packetRow);},
  pending(owner){if(!isAddress(owner))throw Error('Invalid wallet');return all("SELECT * FROM wallet_packets WHERE owner=? AND status NOT IN ('confirmed','finalized','failed','expired','cancelled') ORDER BY created_at ASC LIMIT 50",[owner]).map(packetRow);},
  find(owner,campaignId,key){return packetRow(get('SELECT * FROM wallet_packets WHERE owner=? AND campaign_id=? AND request_key=?',[owner,campaignId,key]));},
  prepare({owner,campaignId,requestKey,descriptor,prepared}){
   if(!isAddress(owner)||!KEY.test(requestKey||'')||typeof campaignId!=='string'||campaignId.length>160)throw Error('Invalid transaction identity');
   return transaction(()=>{
    const prior=walletPackets.find(owner,campaignId,requestKey);
    if(prior){if(prior.descriptor!==descriptor){const e=Error('Request ID already belongs to different parameters');e.code='IDEMPOTENCY_CONFLICT';throw e;}return prior;}
    if(walletPackets.pending(owner).length>=16)throw Object.assign(Error('Resolve pending transactions before starting another'),{publicMessage:'Resolve pending transactions before starting another'});
    const id=randomUUID(),at=isoNow(now);
    run('INSERT INTO wallet_packets(id,owner,campaign_id,request_key,descriptor,prepared_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',[id,owner,campaignId,requestKey,descriptor,canonicalJson(prepared),'prepared',at,at]);
    return walletPackets.get(id);
   });
  },
  sign({id,owner,signedBase64,signature}){
   return transaction(()=>{const p=walletPackets.get(id);if(!p||p.owner!==owner)throw Error('Transaction not found');
    if(p.signedBase64){if(p.signedBase64!==signedBase64||p.signature!==signature)throw Error('Transaction was already signed differently');return p;}
    if(p.status!=='prepared')throw Error('Transaction is no longer signable');
    run('UPDATE wallet_packets SET signed_base64=?,signature=?,status=?,updated_at=? WHERE id=? AND signed_base64 IS NULL',[signedBase64,signature,'signed',isoNow(now),id]);return walletPackets.get(id);
   });
  },
  cancel(id,owner){
   run("UPDATE wallet_packets SET status='cancelled',updated_at=? WHERE id=? AND owner=? AND status='prepared' AND signed_base64 IS NULL",[isoNow(now),id,owner]);return walletPackets.get(id);
  },
  progress(id,status,error=null,{expectedStatus=null}={}){
   if(!['submitted','unknown','confirmed','finalized','failed','expired'].includes(status))throw Error('Invalid packet state');
   // Never downgrade known success, or change the packet/signature during retries.
   run("UPDATE wallet_packets SET status=?,error=?,updated_at=? WHERE id=? AND status NOT IN ('finalized','cancelled') AND (status<>'confirmed' OR ?='finalized') AND (CAST(? AS TEXT) IS NULL OR status=?)",[status,error,isoNow(now),id,status,expectedStatus,expectedStatus]);
   return walletPackets.get(id);
  },
 };
 return {campaigns,intents,jobs,chainEvents,capabilities,budgets,mintLeases,drafts,walletPackets};
}
/** node:sqlite adapter. `path` ':memory:' for tests; on the API volume otherwise (directory created 0700). */
export class SqliteRegistry{
 constructor({path=':memory:',now=Date.now}={}){
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
  this.driver='sqlite';this.path=path;this.db=new DatabaseSync(path);
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  this.statements=new Map();this.depth=0;
  const prepare=sql=>{let s=this.statements.get(sql);if(!s){s=this.db.prepare(sql);this.statements.set(sql,s);}return s;};
  const driver={get:(sql,params)=>prepare(sql).get(...params),all:(sql,params)=>prepare(sql).all(...params),run:(sql,params)=>prepare(sql).run(...params),transaction:fn=>this.transaction(fn)};
  Object.assign(this,registryApi(driver,{now}));
  this.operatorPackets=operatorPacketsApi(driver,{now});
  this.admission=admissionApi(driver,{now});
  this.capabilities.authorizeLease=leaseAuthorityApi(driver,{now});
  this.budgets.apply=budgetAccounting(driver,this.budgets,{now});
 }
 transaction(fn){
  if(this.depth>0)return fn();
  this.db.exec('BEGIN IMMEDIATE');this.depth++;
  try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.depth--;}
 }
 /** Applies every migration not yet recorded, each in its own transaction; returns the versions applied now. */
 migrate(){
  this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done=new Set(this.db.prepare(SQL.migrationsApplied).all().map(r=>Number(r.version)));const applied=[];
  for(const m of MIGRATIONS){
   if(done.has(m.version))continue;
   const statements=splitStatements(readFileSync(m.file,'utf8'));
   this.transaction(()=>{for(const s of statements)this.db.exec(s);this.db.prepare(SQL.migrationApply).run(m.version,m.name,new Date().toISOString());});
   applied.push(m.version);
  }
  return applied;
 }
 schemaVersion(){try{const rows=this.db.prepare(SQL.migrationsApplied).all();return rows.length?Number(rows[rows.length-1].version):0;}catch{return 0;}}
 close(){this.db.close();}
}
export function openRegistry({driver='sqlite',path=':memory:',now=Date.now}={}){
 if(driver==='sqlite')return new SqliteRegistry({path,now});
 if(driver==='postgres')return new PostgresRegistry({path,now});
 throw Error('Unknown registry driver '+driver);
}

// Shared validation and row codecs for the asynchronous production adapter.
export { isoNow, ADDRESS, SIGNATURE, DECIMAL, PATH, KEY, SLUG, HEX64, parseJson, rowToCampaign, rowToIntent, rowToJob, rowToCapability, rowToBudget, rowToLease, rowToEvent, optAddress, optDecimal, optInt, optText, optIso, campaignValues };
