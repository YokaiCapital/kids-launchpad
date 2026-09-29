// Opt-in real encrypted signer + finalized local ledger retry rehearsal.
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresRegistry} from '../registry/registry.mjs';
import {qualifyInventory} from '../mints/qualify-inventory.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
if(!url)throw Error('Explicit synthetic PostgreSQL URL required');
const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
try{
 await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});
 await qualifyInventory({registry:new PostgresRegistry({pool}),programVersion:3,retryGenerations:2,log:event=>console.log(JSON.stringify(event))});
}finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
