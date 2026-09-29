import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
const before=readFileSync(new URL('../registry/migration-35-profile-media.sql',import.meta.url),'utf8'),after=readFileSync(new URL('../registry/migration-36-video-media.sql',import.meta.url),'utf8');
const setup="CREATE TABLE creation_requests(request_id TEXT PRIMARY KEY);INSERT INTO creation_requests VALUES('request');";
const row="('operation','request','owner','banner','descriptor','hash',123,'published','content-id',1,2)";
test('video migration preserves existing publication receipts and uniqueness on SQLite',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('PRAGMA foreign_keys=ON');db.exec(setup+before);db.exec('INSERT INTO creation_media_publications VALUES'+row);const original=db.prepare('SELECT * FROM creation_media_publications').get();db.exec('BEGIN');db.exec(after);db.exec('COMMIT');assert.deepEqual(db.prepare('SELECT * FROM creation_media_publications').get(),original);assert.throws(()=>db.exec('INSERT INTO creation_media_publications VALUES'+row));db.exec("INSERT INTO creation_media_publications VALUES('video-op','request','owner','video','descriptor','hash',123,'published','video-cid',1,2)");}finally{db.close();}
});
test('video migration preserves existing publication receipts and uniqueness on PostgreSQL',{skip:!process.env.KIDS_TEST_POSTGRES_URL},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:process.env.KIDS_TEST_POSTGRES_URL,max:1});let pool;
 try{await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.KIDS_TEST_POSTGRES_URL,max:1,options:`-c search_path=${schema}`});await pool.query(setup+before);await pool.query('INSERT INTO creation_media_publications VALUES'+row);const original=(await pool.query('SELECT * FROM creation_media_publications')).rows;await pool.query('BEGIN;'+after+'COMMIT;');assert.deepEqual((await pool.query('SELECT * FROM creation_media_publications')).rows,original);await assert.rejects(pool.query('INSERT INTO creation_media_publications VALUES'+row),e=>e.code==='23505');await pool.query("INSERT INTO creation_media_publications VALUES('video-op','request','owner','video','descriptor','hash',123,'published','video-cid',1,2)");}finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
