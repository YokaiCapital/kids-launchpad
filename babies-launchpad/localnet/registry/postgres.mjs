// Shared production registry. Transactions never contain chain/RPC calls: callers receive
// durable records first and execute external work only after the transaction has committed.
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import pg from 'pg';
import {asyncRegistryApi} from './async-api.mjs';
import {operatorPacketsApi} from './operator-packets.mjs';
import {budgetAccounting} from './budget-accounting.mjs';
import {admissionApi} from './admission.mjs';
import {leaseAuthorityApi} from './lease-authority.mjs';
import {postgresJobStatement,databaseIso} from './postgres-job-clock.mjs';
import {SQL,MIGRATIONS,splitStatements,toPostgresPlaceholders,rowToJob,isAddress} from './registry.mjs';

const key=/^[A-Za-z0-9_.:-]{1,128}$/;
const retryable=new Set(['40001','40P01','23505']);
export class PostgresRegistry {
 constructor({path,connectionString=path,pool=null,max=8,now=Date.now,onError=()=>{}}={}) {
  if(!pool&&(!connectionString||!/^postgres(?:ql)?:\/\//.test(connectionString)))throw Error('A Postgres connection URL is required');
  if(!Number.isInteger(max)||max<1||max>32)throw Error('Registry pool size must be 1..32');
  this.driver='postgres';this.now=now;this.context=new AsyncLocalStorage();this.ownsPool=!pool;
  this.pool=pool||new pg.Pool({connectionString,max,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,
   statement_timeout:10000,idle_in_transaction_session_timeout:15000,application_name:'kids-registry'});
  this.pool.on('error',error=>onError({event:'registry-pool-error',code:error?.code||'unknown'}));
  const query=async(sql,params=[])=>{
   // Financial job custody uses the database clock even with an injected host clock.
   const job=postgresJobStatement(sql,params);
   if(job)return (this.context.getStore()||this.pool).query(job.text,job.values);
   // A sequence avoids MAX(ordinal)+1 contention across unrelated campaign inserts.
   const text=sql===SQL.campaignNextOrdinal?"SELECT nextval('kids_campaign_ordinal') AS next":toPostgresPlaceholders(sql);
   return (this.context.getStore()||this.pool).query(text,params);
  };
  this.query=query;
  const driver={get:async(s,p)=>(await query(s,p)).rows[0],all:async(s,p)=>(await query(s,p)).rows,
   run:async(s,p)=>({changes:(await query(s,p)).rowCount}),transaction:(fn,options)=>this.transaction(fn,options)};
  Object.assign(this,asyncRegistryApi(driver,{now}));
  this.operatorPackets=operatorPacketsApi(driver,{now});
  this.admission=admissionApi(driver,{async:true});
  this.capabilities.authorizeLease=leaseAuthorityApi(driver,{async:true});
  this.budgets.apply=budgetAccounting(driver,this.budgets,{now,async:true});
  this.jobs.leaseNext=options=>this.leaseNext(options);
 }
 async transaction(fn,{retry=true,lockKey=null}={}) {
  if(this.context.getStore())return fn();
  for(let attempt=0;;attempt++){
   const client=await this.pool.connect();let error,destroy=false;
   try{
    // Keyed read/merge/write operations serialize only the same identity. Unkeyed
    // multi-row invariants keep SERIALIZABLE isolation. No global campaign mutex.
    await client.query(lockKey===null?'BEGIN ISOLATION LEVEL SERIALIZABLE':'BEGIN ISOLATION LEVEL READ COMMITTED');
    if(lockKey!==null){if(typeof lockKey!=='string'||lockKey.length>512)throw Error('Invalid transaction lock key');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey]);}
    const result=await this.context.run(client,fn);
    await client.query('COMMIT');return result;
   }catch(e){error=e;try{await client.query('ROLLBACK');}catch{destroy=true;throw e;}}
   finally{client.release(destroy);}
   if(!retry||!retryable.has(error.code)||attempt>=7)throw error;
   await pause(Math.min(250,5*2**attempt)+Math.floor(Math.random()*15));
  }
 }
 async migrate(){
  // One dedicated connection and session advisory lock: other replicas wait, then read
  // committed migration versions. No serializable snapshot is taken before that wait.
  const client=await this.pool.connect();const applied=[];
  try{
   await client.query("SELECT pg_advisory_lock(724396821)");
   await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
   const done=new Set((await client.query(SQL.migrationsApplied)).rows.map(x=>Number(x.version)));
   for(const m of MIGRATIONS){
    if(done.has(m.version))continue;
    await client.query('BEGIN');
    try{for(const sql of splitStatements(readFileSync(m.file,'utf8')))await client.query(sql);
     await client.query(toPostgresPlaceholders(SQL.migrationApply),[m.version,m.name,new Date(this.now()).toISOString()]);
     await client.query('COMMIT');applied.push(m.version);
    }catch(e){await client.query('ROLLBACK');throw e;}
   }
   const hadSequence=(await client.query("SELECT to_regclass('kids_campaign_ordinal') AS existing")).rows[0].existing;
   await client.query('CREATE SEQUENCE IF NOT EXISTS kids_campaign_ordinal');
   if(!hadSequence)await client.query("SELECT setval('kids_campaign_ordinal',(SELECT COALESCE(MAX(ordinal),0)+1 FROM campaigns),false)");
   await client.query("CREATE INDEX IF NOT EXISTS jobs_lane_due ON jobs(job_class,not_before,created_at) WHERE state IN ('queued','leased')");
   await client.query('CREATE INDEX IF NOT EXISTS public_activity_page_keyset ON public_activity_events(genesis,program_id,campaign,order_key COLLATE "C" DESC)');
   await client.query('CREATE INDEX IF NOT EXISTS public_activity_movements_keyset ON public_activity_events(genesis,program_id,campaign,order_key COLLATE "C" DESC) WHERE has_movement=1 AND failed=0');
   await client.query('CREATE INDEX IF NOT EXISTS public_activity_failures_keyset ON public_activity_events(genesis,program_id,campaign,order_key COLLATE "C" DESC) WHERE failed=1');
   await client.query('CREATE INDEX IF NOT EXISTS public_market_swaps_keyset ON public_market_swaps(genesis,pool,order_key COLLATE "C" DESC)');
   return applied;
  }finally{try{await client.query('SELECT pg_advisory_unlock(724396821)');}finally{client.release();}}
 }
 async schemaVersion(){const r=await this.pool.query('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations');return Number(r.rows[0].version);}
 async leaseNext({owner,ttlMs=30000,jobClasses,lastCampaign=null,scope=null}={}){
  if(!key.test(owner||''))throw Error('Invalid lease owner');
  if(!Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>3600000)throw Error('Invalid lease duration');
  if(!Array.isArray(jobClasses)||!jobClasses.length||jobClasses.length>32||jobClasses.some(x=>!key.test(x)))throw Error('Explicit job classes are required');
  if(scope&&(!isAddress(scope.genesisHash)||!isAddress(scope.programId)||!Number.isSafeInteger(scope.campaignVersion)||scope.campaignVersion<1))throw Error('Invalid worker program scope');
  if(scope&&(scope.operatingPayer!==undefined||scope.operatingPolicy!==undefined)&&(!isAddress(scope.operatingPayer)||!key.test(scope.operatingPolicy??'')||scope.campaignVersion!==3||jobClasses.some(c=>!['operating-reconcile','operating-refill'].includes(c))))throw Error('Invalid accounting worker scope');
  // No host clock participates in due checks or lease expiry.
  const at=databaseIso,expires=`to_char((clock_timestamp()+($2::double precision*interval '1 millisecond')) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  // A single short statement both selects and claims. Lane filtering occurs BEFORE LIMIT.
  // Round-robin campaign order prevents a campaign with a long backlog taking every turn.
  const r=await this.pool.query(`WITH candidate AS (
   SELECT job_id FROM jobs WHERE job_class=ANY($1::text[])
    AND (state='queued' OR (state='leased' AND lease_expires_at<=${at}))
    AND (not_before IS NULL OR not_before<=${at})
    AND ($5::text IS NULL OR genesis_hash=$5)
    AND ($6::text IS NULL OR program_id=$6)
    AND ($7::integer IS NULL OR EXISTS (SELECT 1 FROM campaigns c WHERE c.genesis_hash=jobs.genesis_hash
      AND c.program_id=jobs.program_id AND c.campaign=jobs.campaign AND c.campaign_version=$7))
    AND ($8::text IS NULL OR payload_json::jsonb->'binding'->>'payer'=$8)
    AND ($9::text IS NULL OR payload_json::jsonb->'binding'->>'policy'=$9)
   ORDER BY CASE WHEN $3::text IS NULL OR genesis_hash||':'||program_id||':'||campaign>$3 THEN 0 ELSE 1 END,
    genesis_hash,program_id,campaign,
    CASE job_class WHEN 'launch' THEN 0 WHEN 'claims' THEN 1 WHEN 'refunds' THEN 1 WHEN 'settlement' THEN 2 WHEN 'reconcile' THEN 2 ELSE 3 END,
    created_at,job_id LIMIT 1 FOR UPDATE SKIP LOCKED
   ) UPDATE jobs SET state='leased',lease_owner=$4,lease_expires_at=${expires},
    retry_count=retry_count+CASE WHEN state='leased' THEN 1 ELSE 0 END,
    fencing_token=fencing_token+1,updated_at=${at}
   WHERE job_id IN (SELECT job_id FROM candidate) RETURNING *`,[jobClasses,ttlMs,lastCampaign,owner,scope?.genesisHash??null,scope?.programId??null,scope?.campaignVersion??null,scope?.operatingPayer??null,scope?.operatingPolicy??null]);
  return rowToJob(r.rows[0]);
 }
 async close(){if(this.ownsPool)await this.pool.end();}
}
