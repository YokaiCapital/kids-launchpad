import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {openRegistry,PostgresRegistry} from './registry.mjs';
const address=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
async function cases(r){
 await r.migrate();const creator=address(201);
 for(let n=1;n<=65;n++)await r.campaigns.upsert({genesisHash:address(199),programId:address(200),campaign:address(n),mode:'standard',campaignVersion:3,registryStatus:'planned',creator,name:n<4?'Tied':'Coin '+String(66-n).padStart(2,'0'),deadlineUnix:n===65?null:1000+Math.floor(n/3),chainStatus:n===65?'scheduled':'open'});
 for(const sort of ['newest','name','closing']){
  let cursor=null,all=[];do{const p=await r.campaigns.list({sort,cursor,limit:7,creator});all.push(...p.campaigns);cursor=p.nextCursor;if(cursor)await assert.rejects(async()=>r.campaigns.list({sort:sort==='name'?'closing':'name',cursor}),/sort/);}while(cursor);
  assert.equal(all.length,65);assert.equal(new Set(all.map(c=>c.campaign)).size,65);
  const expected=[...all].sort((a,b)=>sort==='newest'?b.ordinal-a.ordinal:sort==='closing'?(a.deadlineUnix??Number.MAX_SAFE_INTEGER)-(b.deadlineUnix??Number.MAX_SAFE_INTEGER)||b.ordinal-a.ordinal:(a.name.toLowerCase()<b.name.toLowerCase()?-1:a.name.toLowerCase()>b.name.toLowerCase()?1:0)||b.ordinal-a.ordinal);
  assert.deepEqual(all.map(c=>c.ordinal),expected.map(c=>c.ordinal));
  const filtered=await r.campaigns.list({sort,query:'tied',status:'open',limit:2});assert.equal(filtered.campaigns.length,2);assert.ok(filtered.nextCursor);assert.equal((await r.campaigns.list({sort,query:'tied',status:'open',limit:2,cursor:filtered.nextCursor})).campaigns.length,1);
 }
 const first=await r.campaigns.list({sort:'closing',limit:2,status:'open'});assert.equal(first.campaigns[0].ordinal,2);assert.equal(first.campaigns[1].ordinal,1);
 await assert.rejects(async()=>r.campaigns.list({sort:'deadline; DROP TABLE campaigns'}),/sort/);
 // A new newest-first item does not shift the continuation boundary.
 const p=await r.campaigns.list({limit:2});await r.campaigns.upsert({genesisHash:address(199),programId:address(200),campaign:address(66),mode:'standard',campaignVersion:3,registryStatus:'planned'});
 assert.equal((await r.campaigns.list({cursor:p.nextCursor,limit:2})).campaigns[0].ordinal,63);
}
test('global directory order: SQLite keysets keep ties, filters and all 65 launches',async()=>{const r=openRegistry();try{await cases(r);}finally{r.close();}});
test('global directory order: PostgreSQL keyset parity and indexes',{skip:!process.env.KIDS_TEST_POSTGRES_URL},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:process.env.KIDS_TEST_POSTGRES_URL,max:1});let pool;
 try{await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.KIDS_TEST_POSTGRES_URL,max:2,options:`-c search_path=${schema}`});const r=new PostgresRegistry({pool});await cases(r);const indexes=(await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1",[schema])).rows.map(r=>r.indexname);assert.ok(indexes.includes('campaign_directory_deadline'));assert.ok(indexes.includes('campaign_directory_name'));}finally{await pool?.end();await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();}
});
