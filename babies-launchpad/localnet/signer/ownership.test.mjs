import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';import {acquireSignerOwnership} from './ownership.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
async function fixture(fn){
 const schema='kids_test_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url,max:1});let pool;const leases=[];
 try{await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const scope={genesisHash:addr(1),programId:addr(2),payer:addr(3)};
  const acquire=async extra=>{const lease=await acquireSignerOwnership({registry,...scope,heartbeat:false,...extra});leases.push(lease);return lease;};
  await fn({registry,scope,acquire});
 }finally{for(const lease of leases)await lease.close().catch(()=>{});if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
}
test('concurrent signer replicas admit exactly one scoped owner and graceful release preserves fencing',{skip:!url},()=>fixture(async({registry,acquire})=>{
 const results=await Promise.allSettled(Array.from({length:12},()=>acquire()));assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 const lease=results.find(x=>x.status==='fulfilled').value;assert.equal(lease.valid(),true);await lease.renew();await lease.close();assert.equal(lease.valid(),false);
 const next=await acquire();assert.equal(next.valid(),true);assert.equal((await registry.query('SELECT epoch FROM signer_ownership')).rows[0].epoch,'2');
 await lease.close();assert.equal(next.valid(),true);await assert.rejects(acquire(),{code:'SIGNER_OWNERSHIP_UNAVAILABLE'});
}));
test('owner scope never crosses ledger, program or payer',{skip:!url},()=>fixture(async({acquire})=>{
 await acquire();for(const key of ['genesisHash','programId','payer'])assert.equal((await acquire({[key]:addr(4)})).valid(),true);
}));
test('an expired process cannot renew or release its replacement even after the database recovers',{skip:!url},()=>fixture(async({registry,acquire})=>{
 let now=0;const first=await acquire({monotonicNow:()=>now});now=30000;assert.equal(first.valid(),false);await assert.rejects(first.renew(),{code:'SIGNER_OWNERSHIP_UNAVAILABLE'});
 // Isolated fixture models passage of the database lease deadline.
 await registry.query('UPDATE signer_ownership SET expires_ms=0');const replacement=await acquire();await first.close();
 assert.equal(replacement.valid(),true);assert.equal((await registry.query('SELECT epoch,owner FROM signer_ownership')).rows[0].epoch,'2');await assert.rejects(acquire(),{code:'SIGNER_OWNERSHIP_UNAVAILABLE'});
}));
test('database failure makes renewal terminal instead of resuming after reconnection',{skip:!url},()=>fixture(async({registry,acquire})=>{
 let offline=false;const wrapped={driver:'postgres',query:(...args)=>offline?Promise.reject(Error('offline')):registry.query(...args)};
 const lease=await acquire({registry:wrapped});offline=true;await assert.rejects(lease.renew(),{code:'SIGNER_OWNERSHIP_UNAVAILABLE'});assert.equal(lease.valid(),false);
 offline=false;await assert.rejects(lease.renew(),{code:'SIGNER_OWNERSHIP_UNAVAILABLE'});await assert.rejects(acquire(),{code:'SIGNER_OWNERSHIP_UNAVAILABLE'});
}));
test('a slow acquisition acknowledgement grants no local signing window',{skip:!url},()=>fixture(async({registry,acquire})=>{
 let now=0;const wrapped={driver:'postgres',query:async(...args)=>{const r=await registry.query(...args);now+=26000;return r;}};
 await assert.rejects(acquire({registry:wrapped,monotonicNow:()=>now}),{code:'SIGNER_OWNERSHIP_UNAVAILABLE'});
 await assert.rejects(acquire(),{code:'SIGNER_OWNERSHIP_UNAVAILABLE'},'uncertain acquisition remains reserved until expiry');
}));
test('late renewal acknowledgement cannot resurrect local authority',{skip:!url},()=>fixture(async({registry,acquire})=>{
 let now=0,slow=false;const wrapped={driver:'postgres',query:async(...args)=>{const r=await registry.query(...args);if(slow)now=26000;return r;}};
 const lease=await acquire({registry:wrapped,monotonicNow:()=>now});slow=true;await assert.rejects(lease.renew(),{code:'SIGNER_OWNERSHIP_UNAVAILABLE'});assert.equal(lease.valid(),false);
}));
