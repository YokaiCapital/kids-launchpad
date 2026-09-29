import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Keypair} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createMintLeases} from '../mints/leases.mjs';
import {fakeInventory} from '../test/helpers/mint-inventory-fixture.mjs';
import {campaignAddress,launchAuthority} from '../protocol-v2/client.mjs';
import {createMintIntent,buildMintPacket} from './mint-packet.mjs';
import {createMintApprovalJournal} from './mint-approval.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,address=()=>Keypair.generate().publicKey.toBase58();
test('durable creator-first mint approval and signer authorization', {skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});
  const registry=new PostgresRegistry({pool});await registry.migrate();
  const owner=Keypair.generate(),config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:'http://127.0.0.1:19199',genesisHash:address(),programId:address(),pilotCreator:owner.publicKey.toBase58()};
  let genesis=config.genesisHash,valid=true;
  const connection={rpcEndpoint:config.rpcUrl,getGenesisHash:async()=>genesis,isBlockhashValid:async()=>({value:valid})};
  const inventory=fakeInventory({stock:['7e2g1HXJQPCMLED6PQZhHwzYw9iGemwPuUc5FAFMkids']}),leases=createMintLeases({registry,inventory});
  const requestId=randomUUID(),nonce='33',campaign=campaignAddress(config.programId,owner.publicKey,nonce).toBase58(),binding={creator:config.pilotCreator,draftId:'asset:'+requestId,idempotencyKey:'asset:'+requestId};
  const reserved=await leases.reserve({network:'localnet',genesisHash:config.genesisHash,programId:config.programId,campaign,...binding});
  const reservation=inventory.findReservation(binding),lease=reserved.lease;
  let intent=createMintIntent({preparation:{...config,requestId,nonce,campaign,authority:launchAuthority(config.programId,campaign).toBase58(),state:'reserved',fundingEnabled:false,mint:lease.mint,leaseId:lease.leaseId},creator:config.pilotCreator,metadata:{name:'Coin',symbol:'Coin',uri:'https://kids.fun/rehearsal/coin.json',documentHash:'a'.repeat(64)},rentLamports:'1461600'});
  const open=()=>createMintApprovalJournal({registry,mintLeases:leases,connection,config,loadIntent:async()=>intent});
  const block={blockhash:address(),lastValidBlockHeight:150};
  const tx=buildMintPacket(intent,block);tx.sign([owner]);const creatorPacket=Buffer.from(tx.serialize()).toString('base64'),input={...binding,reservationId:reservation.reservationId};
  await t.test('unsigned packets cannot be journaled or change a mint lease',async()=>{
   await assert.rejects(open().record(requestId,{block,creatorPacket:Buffer.from(buildMintPacket(intent,block).serialize()).toString('base64')}));
   valid=false;await assert.rejects(open().record(requestId,{block,creatorPacket}),/expired/);valid=true;
   assert.equal((await registry.mintLeases.get(lease.leaseId)).state,'reserved');
   assert.equal(Number((await registry.query('SELECT COUNT(*) AS n FROM operator_packets')).rows[0].n),0);
  });
  await t.test('parallel replicas bind one approval; restart rebuilds exactly without signing',async()=>{
   const results=await Promise.all(Array.from({length:10},()=>open().record(requestId,{block,creatorPacket})));
   assert.equal(new Set(results.map(r=>r.messageDigest)).size,1);
   const fresh=open(),approval=await fresh.authorize(input),row=await fresh.read(requestId);
   assert.equal(approval.packet,creatorPacket);assert.equal(row.status,'prepared');assert.equal(row.signedBase64,null);
   assert.equal((await registry.mintLeases.get(lease.leaseId)).state,'signed-pending');
   assert.equal(Number((await registry.query('SELECT COUNT(*) AS n FROM operator_packets')).rows[0].n),1);
  });
  await t.test('new blockhash approval cannot replace a possibly signed attempt',async()=>{
   const otherBlock={...block,blockhash:address()},other=buildMintPacket(intent,otherBlock);other.sign([owner]);
   await assert.rejects(open().record(requestId,{block:otherBlock,creatorPacket:Buffer.from(other.serialize()).toString('base64')}),e=>e.code==='IDEMPOTENCY_CONFLICT');
   assert.equal((await open().read(requestId)).prepared.creatorPacket,creatorPacket);
  });
  await t.test('signer refuses changed plan, binding, ledger and invalid mint signature; expiry preserves exact recovery',async()=>{
   for(const patch of [{creator:address()},{draftId:'asset:foreign'},{idempotencyKey:'foreign'},{reservationId:'foreign'}])await assert.rejects(open().authorize({...input,...patch}));
   const original=intent;intent={...intent,metadata:{...intent.metadata,symbol:'Other'}};await assert.rejects(open().authorize(input));intent=original;
   genesis=address();await assert.rejects(open().authorize(input),/network/);genesis=config.genesisHash;
   valid=false;assert.equal((await open().authorize(input)).packet,creatorPacket);valid=undefined;assert.equal((await open().authorize(input)).packet,creatorPacket);valid=true;
   await assert.rejects(open().captureSigned(requestId,creatorPacket),/invalid signed/);
   assert.equal((await open().read(requestId)).signedBase64,null);
  });
  await t.test('quarantined reservation is no longer signable',async()=>{
   await leases.quarantine({leaseId:lease.leaseId,reason:'qualification'});await assert.rejects(open().authorize(input));
  });
  assert.throws(()=>createMintApprovalJournal({registry,mintLeases:leases,connection,config:{...config,mode:'mainnet'},loadIntent:async()=>intent}));
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
