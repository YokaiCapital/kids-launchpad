import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import pg from 'pg';
import {PostgresRegistry,REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
import {ensureSchema} from './schema-boot.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
async function fixture(fn){
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:6,options:`-c search_path=${schema}`});await fn(new PostgresRegistry({pool}));}
 finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
test('schema boot: a migrating service brings an empty database to the release; waiting services see it; concurrent boots agree',{skip:!url&&'KIDS_TEST_POSTGRES_URL unset'},()=>fixture(async registry=>{
 const logs=[];let t=1_000_000;const clock={now:()=>t,sleepImpl:async ms=>{t+=ms;}};
 await assert.rejects(ensureSchema({registry,env:{},log:l=>logs.push(l),waitMs:12000,pollMs:5000,...clock}),/did not reach/,'a waiting service gives up after its deadline on an empty database');
 assert.ok(logs.some(l=>l.event==='waiting-for-registry'||l.event==='waiting-for-schema'));
 const versions=await Promise.all([1,2,3].map(()=>ensureSchema({registry,env:{KIDS_REGISTRY_MIGRATE:'1'},log:l=>logs.push(l),waitMs:60000,...clock})));
 assert.deepEqual(versions,[REGISTRY_SCHEMA_VERSION,REGISTRY_SCHEMA_VERSION,REGISTRY_SCHEMA_VERSION]);
 assert.equal(await registry.schemaVersion(),REGISTRY_SCHEMA_VERSION);
 assert.equal(await ensureSchema({registry,env:{},log:l=>logs.push(l),waitMs:1000,...clock}),REGISTRY_SCHEMA_VERSION,'a waiting service returns at once when the schema is there');
 assert.equal(logs.filter(l=>l.event==='schema-ready').length,4);
}));
test('schema boot refuses a non-shared registry and a newer schema',async()=>{
 await assert.rejects(ensureSchema({registry:{driver:'sqlite'}}),/shared PostgreSQL/);
 const newer={driver:'postgres',schemaVersion:async()=>REGISTRY_SCHEMA_VERSION+1};
 await assert.rejects(ensureSchema({registry:newer,env:{},waitMs:1000,now:()=>0,sleepImpl:async()=>{}}),/newer than this release/);
});
