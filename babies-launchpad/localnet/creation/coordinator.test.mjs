import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
import {PostgresRegistry} from '../registry/registry.mjs';import {createCreationCoordinator} from './coordinator.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
test('durable creator work survives replicas, pauses at the wallet and continues without a browser',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  await registry.query('INSERT INTO creation_quotes VALUES(?,?,?,?,?,?,?,?,?,?)',['quote','owner','key','draft',1,'hash','descriptor','{}',1,9999999999999]);
  await registry.query("INSERT INTO creation_requests VALUES(?,?,?,?,?,?,?,?)",['request','owner','draft','quote','accepted','{}',1,1]);
  let enabled=false,stage='reservation',approvals=0,prepares=0,resumes=0,activations=0;
  const s=()=>({requestId:'request',stage,state:stage==='complete'?'funded':'waiting',action:stage==='complete'?'none':stage==='registration'?'resume':'prepare'});
  const flow={status:async owner=>{assert.equal(owner,'owner');return s();},prepare:async()=>{prepares++;stage=stage==='reservation'?'publication':'launch';return s();},resume:async()=>{resumes++;stage='complete';return s();},submit:async()=>{approvals++;stage='registration';return s();},recover:async()=>s()};
  const make=()=>createCreationCoordinator({registry,flow,owner:'owner',canRun:()=>enabled,intervalMs:60000,activate:async()=>{activations++;}});
  const a=make();await a.start();await a.tick();assert.equal(prepares,0,'closed write gate prevents background work');enabled=true;await a.tick();await a.close();
  let work=(await registry.query('SELECT * FROM creation_work')).rows[0];assert.equal(work.state,'wallet');assert.equal(prepares,2);assert.equal(approvals,0);
  const b=make(),c=make();await Promise.all([b.flow.submit('owner',{requestId:'request'}),b.tick(),c.tick()]);await b.tick();await c.tick();await b.close();await c.close();
  work=(await registry.query('SELECT * FROM creation_work')).rows[0];assert.equal(work.state,'done');assert.equal(approvals,1);assert.equal(resumes,1);assert.equal(activations,1);
  // A stale lease is recovered from the database, not an in-memory promise.
  stage='registration';await registry.query("UPDATE creation_work SET state='leased',lease_owner='dead',lease_until=0");const d=make();await d.tick();await d.close();assert.equal((await registry.query('SELECT state FROM creation_work')).rows[0].state,'done');
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
