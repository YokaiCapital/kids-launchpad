// Private operator telemetry only. No chain calls, signer access or public route.
// Aggregate labels have fixed cardinality; never export wallets, job payloads,
// transaction packets, grants or credential-bearing driver errors.
import {presencePolicy,observePresence} from './presence.mjs';
import {PublicKey} from '@solana/web3.js';
import {WORKER_LANES} from './lanes.mjs';
import {REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
import {ADMISSION_KINDS,observationResources,observeAdmission} from './observe-admission.mjs';
const targets=Object.freeze({provisioning:60000,lifecycle:5000,recovery:5000,accounting:60000,harvest:60000,economics:300000,indexing:30000,backfill:3600000,maintenance:3600000});
const count=n=>{const x=Number(n);if(!Number.isSafeInteger(x)||x<0)throw Error('Invalid telemetry count');return x;};
const milliseconds=n=>{const x=Number(n??0);if(!Number.isFinite(x))throw Error('Invalid telemetry time');return Math.max(0,Math.round(x));};
const address=x=>new PublicKey(x).toBase58()===x;
import {readPresets} from '../registry/presets.mjs';
/** The default low-reserve threshold is the sealed operating floor (option 1), so the alert fires before any task waits. */
const sealedFloor=()=>{try{const v=readPresets().agreed?.operating?.floorLamports;return typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)?v:'1000000';}catch{return '1000000';}};
export function createWorkerObserver({registry,scope,resources={},minimumReserveLamports=sealedFloor(),requiredWorkers={},unscheduledGraceMs=600000}){
 if(registry?.driver!=='postgres'||!address(scope?.genesisHash)||!address(scope?.programId)||scope.campaignVersion!==3)throw Error('Observer needs exact shared v3 scope');
 const pinned=observationResources(resources);
 if(typeof minimumReserveLamports!=='string'||!(/^[1-9][0-9]{0,18}$/).test(minimumReserveLamports))throw Error('Positive operating reserve threshold required');
 const expectations=presencePolicy(requiredWorkers);
 const id=[scope.genesisHash,scope.programId,scope.campaignVersion];
 return {async read(){
  if(await registry.schemaVersion()!==REGISTRY_SCHEMA_VERSION)throw Error('Observer schema differs from release');
  return registry.transaction(async()=>{
   // Repeatable SERIALIZABLE snapshot with a bounded query budget. Do not hold
   // row locks or call RPC from this transaction. Database time avoids host skew.
   await registry.query("SET LOCAL statement_timeout='3000ms'");
   const at=count((await registry.query('SELECT CAST(EXTRACT(EPOCH FROM transaction_timestamp())*1000 AS BIGINT) ms')).rows[0].ms),iso=new Date(at).toISOString();
   const rows=(await registry.query(`SELECT j.job_class,j.state,
    COALESCE(j.result_json::jsonb->>'outcome','') outcome,
    COALESCE(j.result_json::jsonb->>'category','') category,COALESCE(j.result_json::jsonb->>'capacityKind','') capacity_kind,COUNT(*) n,
    COUNT(*) FILTER(WHERE (j.state='queued' AND COALESCE(j.not_before,j.created_at)<=?) OR (j.state='leased' AND j.lease_expires_at<=?)) due,
    COUNT(*) FILTER(WHERE j.state='leased' AND j.lease_expires_at<=?) expired,
    COUNT(*) FILTER(WHERE j.state='queued' AND j.not_before>? AND j.not_before<=?) scheduled_60,
    COUNT(*) FILTER(WHERE j.state='queued' AND j.not_before>? AND j.not_before<=?) scheduled_300,
    COUNT(*) FILTER(WHERE j.state='queued' AND j.not_before>? AND j.not_before<=?) scheduled_600,
    MAX(CASE WHEN j.state='queued' AND COALESCE(j.not_before,j.created_at)<=? THEN EXTRACT(EPOCH FROM (?::timestamptz-COALESCE(j.not_before,j.created_at)::timestamptz))*1000
     WHEN j.state='leased' AND j.lease_expires_at<=? THEN EXTRACT(EPOCH FROM (?::timestamptz-j.lease_expires_at::timestamptz))*1000 ELSE 0 END) oldest_due_ms,
    MIN(CASE WHEN j.deadline_at IS NOT NULL THEN EXTRACT(EPOCH FROM (j.deadline_at::timestamptz-?::timestamptz))*1000 END) deadline_slack_ms
    FROM jobs j JOIN campaigns c USING(genesis_hash,program_id,campaign)
    WHERE j.genesis_hash=? AND j.program_id=? AND c.campaign_version=? AND j.state IN ('queued','leased','failed')
    GROUP BY j.job_class,j.state,outcome,category,capacity_kind`,[iso,iso,iso,iso,new Date(at+60000).toISOString(),iso,new Date(at+300000).toISOString(),iso,new Date(at+600000).toISOString(),iso,iso,iso,iso,iso,...id])).rows;
   const lanes=Object.fromEntries(Object.keys(WORKER_LANES).map(lane=>[lane,{queued:0,leased:0,failed:0,due:0,expiredLeases:0,unknownTransactions:0,fundingWait:0,capacityWait:0,signerSpendWait:0,oldestDueMs:0,scheduled:{within60s:0,within300s:0,within600s:0},deadlineSlackMs:null,targetMs:targets[lane]}]));
   const laneOf=Object.fromEntries(Object.entries(WORKER_LANES).flatMap(([lane,classes])=>classes.map(c=>[c,lane]))),alerts=[];
   let unassigned=0;
   for(const r of rows){
    const lane=laneOf[r.job_class],n=count(r.n);if(!lane){unassigned+=n;continue;}
    const l=lanes[lane];l[r.state]+=n;l.due+=count(r.due);l.expiredLeases+=count(r.expired);l.oldestDueMs=Math.max(l.oldestDueMs,milliseconds(r.oldest_due_ms));
    for(const [key,field]of [['within60s','scheduled_60'],['within300s','scheduled_300'],['within600s','scheduled_600']])l.scheduled[key]+=count(r[field]);
    if(r.outcome==='unknown')l.unknownTransactions+=n;
    if(r.category==='awaiting-operating-funding')l.fundingWait+=n;
    if(r.category==='capacity')l.capacityWait+=n;
    if(r.category==='capacity'&&r.capacity_kind==='hourly-spend')l.signerSpendWait+=n;
    if(r.deadline_slack_ms!==null){const slack=Number(r.deadline_slack_ms);if(!Number.isFinite(slack))throw Error('Invalid deadline telemetry');l.deadlineSlackMs=l.deadlineSlackMs===null?Math.round(slack):Math.min(l.deadlineSlackMs,Math.round(slack));}
   }
   for(const [lane,l]of Object.entries(lanes)){
    if(l.oldestDueMs>l.targetMs)alerts.push({code:'queue-delay',lane});
    if(l.failed)alerts.push({code:'failed-work',lane});
    if(l.expiredLeases)alerts.push({code:'expired-lease',lane});
    if(l.fundingWait)alerts.push({code:'operating-funding',lane});
    if(l.signerSpendWait)alerts.push({code:'signer-spend-limit',lane});
    if(l.deadlineSlackMs!==null&&l.deadlineSlackMs<60000&&l.due)alerts.push({code:'deadline-risk',lane});
   }
   if(unassigned)alerts.push({code:'unassigned-work',lane:'unassigned'});
   const budgets=(await registry.query(`WITH holds AS (
    SELECT genesis_hash,program_id,campaign,payer,SUM(maximum_lamports::numeric) held FROM operating_spend_holds
    WHERE genesis_hash=? AND program_id=? AND state='held' GROUP BY genesis_hash,program_id,campaign,payer
   ) SELECT COUNT(b.payer) n,COUNT(*) FILTER(WHERE b.payer IS NULL) missing,COUNT(*) FILTER(WHERE b.reserved_lamports::numeric-b.spent_lamports::numeric-b.returned_lamports::numeric-COALESCE(h.held,0)<?::numeric) low,
    COALESCE(SUM(COALESCE(h.held,0)),0)::text held
    FROM campaigns c LEFT JOIN operational_budgets b USING(genesis_hash,program_id,campaign)
    LEFT JOIN holds h ON h.genesis_hash=c.genesis_hash AND h.program_id=c.program_id AND h.campaign=c.campaign AND h.payer=b.payer
    WHERE c.genesis_hash=? AND c.program_id=? AND c.campaign_version=? AND EXISTS(SELECT 1 FROM jobs j WHERE j.genesis_hash=c.genesis_hash AND j.program_id=c.program_id AND j.campaign=c.campaign AND j.state IN ('queued','leased') AND j.job_class IN ('launch','settlement','refunds','fee-setup','fee-harvest','distribution','token-burn'))`,[...id.slice(0,2),minimumReserveLamports,...id])).rows[0];
   const grants=(await registry.query(`SELECT COUNT(*) FILTER(WHERE g.capability_id IS NULL) missing,
    COUNT(*) FILTER(WHERE g.revoked_at IS NOT NULL) revoked,
    COUNT(*) FILTER(WHERE g.expires_at<=?) expired,
    COUNT(*) FILTER(WHERE g.expires_at>? AND g.expires_at<=?) expiring
    FROM campaigns c LEFT JOIN LATERAL (SELECT capability_id,revoked_at,expires_at FROM signer_capabilities s
     WHERE s.genesis_hash=c.genesis_hash AND s.program_id=c.program_id AND s.campaign=c.campaign ORDER BY created_at DESC,capability_id DESC LIMIT 1) g ON true
    WHERE c.genesis_hash=? AND c.program_id=? AND c.campaign_version=? AND EXISTS(SELECT 1 FROM jobs j WHERE j.genesis_hash=c.genesis_hash AND j.program_id=c.program_id AND j.campaign=c.campaign AND j.state IN ('queued','leased') AND j.job_class IN ('launch','settlement','refunds','fee-setup','fee-harvest','distribution','token-burn'))`,[iso,iso,new Date(at+3600000).toISOString(),...id])).rows[0];
   const authority=Object.fromEntries(Object.entries(grants).map(([k,v])=>[k,count(v)]));
   // Capacity advice must not let one unfunded/expired campaign freeze every
   // healthy campaign. These are conservative demand counts, not signing rights:
   // workers and the signer still validate the exact capability and funding.
   const demand=(await registry.query(`WITH eligible AS (
    SELECT j.job_class,j.state,j.not_before,j.created_at,j.lease_expires_at,
     COALESCE(j.result_json::jsonb->>'category','')='awaiting-operating-funding' funding_blocked,
     j.job_class IN ('launch','settlement','lifecycle-control','claims','refunds','fee-setup','fee-activate','fee-harvest','distribution','token-burn','buyback')
      AND (g.capability_id IS NULL OR g.revoked_at IS NOT NULL OR g.expires_at<=?) authority_blocked
    FROM jobs j JOIN campaigns c USING(genesis_hash,program_id,campaign)
    LEFT JOIN LATERAL (SELECT capability_id,revoked_at,expires_at FROM signer_capabilities s
     WHERE s.genesis_hash=j.genesis_hash AND s.program_id=j.program_id AND s.campaign=j.campaign
     ORDER BY created_at DESC,capability_id DESC LIMIT 1) g ON true
    WHERE j.genesis_hash=? AND j.program_id=? AND c.campaign_version=? AND j.state IN ('queued','leased')
   ) SELECT job_class,
    COUNT(*) FILTER(WHERE funding_blocked) blocked_funding,
    COUNT(*) FILTER(WHERE authority_blocked) blocked_authority,
    COUNT(*) FILTER(WHERE NOT funding_blocked AND NOT authority_blocked AND
     ((state='queued' AND COALESCE(not_before,created_at)<=?) OR (state='leased' AND lease_expires_at<=?))) due,
    COUNT(*) FILTER(WHERE NOT funding_blocked AND NOT authority_blocked AND state='queued' AND not_before>? AND not_before<=?) scheduled_60,
    COUNT(*) FILTER(WHERE NOT funding_blocked AND NOT authority_blocked AND state='queued' AND not_before>? AND not_before<=?) scheduled_300,
    COUNT(*) FILTER(WHERE NOT funding_blocked AND NOT authority_blocked AND state='queued' AND not_before>? AND not_before<=?) scheduled_600
    FROM eligible GROUP BY job_class`,[iso,...id,iso,iso,iso,new Date(at+60000).toISOString(),iso,new Date(at+300000).toISOString(),iso,new Date(at+600000).toISOString()])).rows;
   for(const lane of Object.values(lanes))lane.scaleDemand={due:0,blockedFunding:0,blockedAuthority:0,scheduled:{within60s:0,within300s:0,within600s:0}};
   for(const r of demand){const l=lanes[laneOf[r.job_class]]?.scaleDemand;if(!l)continue;l.due+=count(r.due);l.blockedFunding+=count(r.blocked_funding);l.blockedAuthority+=count(r.blocked_authority);for(const [key,field]of [['within60s','scheduled_60'],['within300s','scheduled_300'],['within600s','scheduled_600']])l.scheduled[key]+=count(r[field]);}
   // A funded campaign that nobody scheduled would otherwise stay silent until its window expired (A33): after the grace
   // period it is an alert of its own, whatever else is queued.
   const unscheduled=(await registry.query(`SELECT COUNT(*)::int n FROM campaigns c JOIN operational_budgets b USING(genesis_hash,program_id,campaign)
    WHERE c.genesis_hash=? AND c.program_id=? AND c.campaign_version=? AND b.reserved_lamports::numeric>0 AND c.created_at<=?
     AND NOT EXISTS(SELECT 1 FROM standard_lifecycles l WHERE l.genesis_hash=c.genesis_hash AND l.program_id=c.program_id AND l.campaign=c.campaign)`,[...id,new Date(at-unscheduledGraceMs).toISOString()])).rows[0];
   if(count(unscheduled.n))alerts.push({code:'unscheduled-funded-campaign',lane:'lifecycle'});
   if(count(budgets.low))alerts.push({code:'low-operating-reserve',lane:'accounting'});
   if(count(budgets.missing))alerts.push({code:'missing-operating-reserve',lane:'accounting'});
   if(authority.missing||authority.revoked||authority.expired)alerts.push({code:'authority-unavailable',lane:'signer'});
   if(authority.expiring)alerts.push({code:'authority-expiring',lane:'signer'});
   const capacity=await observeAdmission(registry,pinned,at),admission=capacity.admission;alerts.push(...capacity.alerts);
   const presence=await observePresence(registry,{scope,at,required:expectations});alerts.push(...presence.alerts);
   return {version:1,observedAt:iso,status:alerts.length?'degraded':'observed',liveness:presence.status==='not-configured'?'not-measured':presence.status,presence,lanes,unassigned,operating:{budgets:count(budgets.n),missingBudgets:count(budgets.missing),lowReserves:count(budgets.low),unscheduledFunded:count(unscheduled.n),heldLamports:budgets.held,minimumReserveLamports},authority,admission,alerts};
  },{retry:false});
 }};
}

export function workerPrometheus(snapshot){
 if(snapshot?.version!==1)throw Error('Invalid worker observation');
 const lines=['# Private aggregate KIDS worker observations; not chain readiness.'];
 for(const [lane,v]of Object.entries(snapshot.lanes)){
  if(!Object.hasOwn(WORKER_LANES,lane))throw Error('Unknown telemetry lane');
  if(v.signerSpendWait!==undefined)lines.push(`kids_worker_signer_spend_wait{lane="${lane}"} ${count(v.signerSpendWait)}`);
  if(v.scaleDemand){for(const key of ['due','blockedFunding','blockedAuthority'])lines.push(`kids_worker_scale_${key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())}{lane="${lane}"} ${count(v.scaleDemand[key])}`);for(const horizon of ['within60s','within300s','within600s'])lines.push(`kids_worker_scale_scheduled{lane="${lane}",horizon="${horizon}"} ${count(v.scaleDemand.scheduled[horizon])}`);}
  for(const horizon of ['within60s','within300s','within600s'])if(v.scheduled)lines.push(`kids_worker_scheduled{lane="${lane}",horizon="${horizon}"} ${count(v.scheduled[horizon])}`);
  for(const key of ['queued','leased','failed','due','expiredLeases','unknownTransactions','fundingWait','capacityWait','oldestDueMs']){
   const metric=key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());lines.push(`kids_worker_${metric}{lane="${lane}"} ${count(v[key])}`);
  }
 }
 for(const [lane,v]of Object.entries(snapshot.presence?.lanes??{}))for(const k of ['minimum','alive','capacity','active','dispatchAgeMs','oldestActiveMs']){if(!Object.hasOwn(WORKER_LANES,lane))throw Error('Unknown presence lane');lines.push(`kids_worker_presence_${k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())}{lane="${lane}"} ${count(v[k])}`);}
 lines.push(`kids_worker_observed_timestamp_seconds ${Date.parse(snapshot.observedAt)/1000}`);
 lines.push(`kids_worker_alerts ${snapshot.alerts.length}`);
 for(const key of ['missing','revoked','expired','expiring'])lines.push(`kids_worker_authority_${key} ${count(snapshot.authority[key])}`);
 lines.push(`kids_worker_missing_budgets ${count(snapshot.operating.missingBudgets)}`);
 lines.push(`kids_worker_low_reserves ${count(snapshot.operating.lowReserves)}`);
 for(const kind of ADMISSION_KINDS){
  const resource=snapshot.admission[kind]??{status:'not-configured'};lines.push(`kids_worker_admission_observed{resource="${kind}"} ${resource.status==='observed'?1:0}`);
  for(const [lane,values]of Object.entries(resource.lanes||{})){
   if(!(kind==='signerRpc'?lane==='signer':Object.hasOwn(WORKER_LANES,lane)))throw Error('Unknown admission observation lane');
   lines.push(`kids_worker_available_requests{resource="${kind}",lane="${lane}"} ${count(values.availableRequests)}`);
   lines.push(`kids_worker_retry_after_ms{resource="${kind}",lane="${lane}"} ${count(values.retryAfterMs)}`);
  }
 }
 return lines.join('\n')+'\n';
}
