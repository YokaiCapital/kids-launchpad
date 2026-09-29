import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {PublicKey} from '@solana/web3.js';
import * as client from './client.mjs';import {createFeeAdapter} from './fee-adapter.mjs';
const key=n=>new PublicKey(Buffer.alloc(32,n));
const disc=name=>createHash('sha256').update('account:'+name).digest().subarray(0,8);
function fixture(){
 const program=key(1),campaign=key(2),keeper=key(3),genesis=key(4),mint=key(5);
 const id={programId:program.toBase58(),campaign:campaign.toBase58(),genesisHash:genesis.toBase58()};
 const terms={mode:0,childMint:mint,treasury:key(6),dev:key(7),ammProgram:client.RAYDIUM_CPMM,ammConfig:client.AMM_CONFIG_TIERS[0].address,lockProgram:client.RAYDIUM_LOCK,feeWeights:{treasury:148,dev:20,parentA:0,parentB:0}};
 const a=client.launchAddresses(program,campaign,terms,key(8)),authority=client.feeAuthority(program,campaign);
 const c={phase:3,terms,feeNft:key(8).toBase58(),pool:a.pool.toBase58(),slot:10,termsHash:'synthetic-sealed-terms'};
 const info=(owner,data)=>({owner,data,lamports:1000000,executable:false});
 const token=(mint,owner,amount)=>{const d=Buffer.alloc(165);mint.toBuffer().copy(d,0);owner.toBuffer().copy(d,32);d.writeBigUInt64LE(amount,64);d[108]=1;if(mint.equals(client.WSOL)){d.writeUInt32LE(1,109);d.writeBigUInt64LE(2039280n,113);}return info(client.TOKEN_PROGRAM,d);};
 const state=Buffer.alloc(160);client.FEE_STATE_MAGIC.copy(state);campaign.toBuffer().copy(state,8);state.writeBigUInt64LE(1000000n,40);state.writeBigUInt64LE(1000000n,48);keeper.toBuffer().copy(state,128);
 const locked=Buffer.alloc(256);disc('LockedCpLiquidityState').copy(locked);locked.writeBigUInt64LE(1000n,8);
 for(const [offset,k]of [[64,a.pool],[96,a.feeNft],[128,a.authority],[160,a.lpMint]])k.toBuffer().copy(locked,offset);
 const pool=Buffer.alloc(637);disc('PoolState').copy(pool);
 for(const [i,k]of [terms.ammConfig,a.authority,a.vault0,a.vault1,a.lpMint,a.mint0,a.mint1,client.TOKEN_PROGRAM,client.TOKEN_PROGRAM,a.observation].entries())k.toBuffer().copy(pool,8+32*i);
 const accounts=[info(program,state),token(mint,authority,1000000n),token(client.WSOL,authority,1000000n),info(terms.lockProgram,locked),token(a.lpMint,a.lockAuthority,1000n),info(terms.ammProgram,pool),token(a.mint0,a.ammAuthority,1000000000n),token(a.mint1,a.ammAuthority,1000000000n),token(key(8),campaign,1n),token(client.WSOL,terms.treasury,0n),token(client.WSOL,terms.dev,0n)];
 let prior=null,simState=null,simErr=null,simLogs=[],slot=10;
 const sent=[],reads=[];
 const connection={
  async getMultipleAccountsInfoAndContext(addresses,options){reads.push(options);return {context:{slot},value:addresses.length===9?accounts.slice(0,9):addresses.map(address=>address.equals(client.associatedTokenAddress(terms.treasury,client.WSOL))?accounts[9]:accounts[10])};},
  async getLatestBlockhash(){return {blockhash:key(9).toBase58(),lastValidBlockHeight:100};},
  async simulateTransaction(){const d=simState??Buffer.from(state);if(!simState)d.writeBigUInt64LE(d.readBigUInt64LE(48)+1000000n,48);return {context:{slot},value:{err:simErr,logs:simLogs,accounts:[{owner:program.toBase58(),data:[d.toString('base64'),'base64']}]}};}
 };
 const registry={operatorPackets:{latest:async()=>prior}};
 const chain={programId:program,keeper,readCampaign:async()=>c,signatureStatus:async()=>({status:'unresolved'}),async send(build,options){sent.push(options);if(!prior)sent.at(-1).instruction=(await build()).instructions[0];return {status:'confirmed',signature:'receipt'};}};
 const adapter=createFeeAdapter({connection,registry,chain});
 return {id,adapter,accounts,state,c,sent,reads,setPrior:v=>prior=v,setSlot:v=>slot=v,setSim:(d,err=null,logs=[])=>{simState=d;simErr=err;simLogs=logs;},run:kind=>adapter.runFeeOperation(id,kind,{operationId:kind+':0',operationKey:kind+':0',fencingToken:1})};
}
test('Standard fees use the expected instruction tags and bounded compute budgets',async()=>{
 for(const [kind,tag]of [['fee-harvest',21],['distribution',23],['token-burn',26]]){const f=fixture();assert.equal((await f.run(kind)).status,'confirmed');assert.equal(f.sent[0].instruction.data[0],tag);assert.ok(f.sent[0].computeUnits<=600000);assert.equal(f.reads[0].minContextSlot,10);}
});
test('nonzero dust accumulates without spending another transaction fee',async()=>{
 for(const kind of ['distribution','token-burn']){const f=fixture();f.state.writeBigUInt64LE(1n,40);f.state.writeBigUInt64LE(1n,48);assert.equal((await f.run(kind)).status,'deferred');assert.equal(f.sent.length,0);}
});
test('signed, prepared and confirmed packets resume before a now-empty balance check',async()=>{
 for(const status of ['signed','prepared','confirmed']){const f=fixture();f.state.writeBigUInt64LE(0n,40);f.state.writeBigUInt64LE(0n,48);f.setPrior({status});assert.equal((await f.run('token-burn')).status,'confirmed');assert.equal(f.sent.length,1);}
});
test('fee snapshot rejects foreign ownership, lock identity and stale RPC data',async()=>{
 const owner=fixture();owner.accounts[0].owner=key(90);await assert.rejects(owner.run('distribution'),/state owner/);
 const lock=fixture();key(90).toBuffer().copy(lock.accounts[3].data,64);await assert.rejects(lock.run('fee-harvest'),/lock identity/);
 const stale=fixture();stale.setSlot(9);await assert.rejects(stale.run('token-burn'),/stale context/);
 for(const f of [owner,lock,stale])assert.equal(f.sent.length,0);
});
test('Family and unprovisioned fees fail closed; the worker never requests treasury setup',async()=>{
 const family=fixture();family.c.terms.mode=1;await assert.rejects(family.run('fee-harvest'),/Only Standard/);
 const missing=fixture();missing.accounts[0]=null;await assert.rejects(missing.run('distribution'),/provisioning unavailable/);
 assert.equal(family.sent.length+missing.sent.length,0);
});
test('a dev closing their recipient ATA does not stop harvests or burns',async()=>{
 for(const kind of ['fee-harvest','token-burn']){const f=fixture();f.accounts[9]=null;f.accounts[10]=null;assert.equal((await f.run(kind)).status,'confirmed');}
});
test('closed payout accounts defer without spending, preserve repair details, and resume after owner restoration',async()=>{
 const f=fixture(),original=f.accounts[10];f.accounts[10]=null;
 for(let i=0;i<12;i++){
  const result=await f.run('distribution');assert.equal(result.status,'deferred');assert.equal(result.recovery.action,'restore-wsol-account');
  assert.deepEqual(result.recovery.accounts,[{owner:String(f.c.terms.dev),address:String(client.associatedTokenAddress(f.c.terms.dev,client.WSOL)),mint:String(client.WSOL)}]);
 }
 assert.equal(f.sent.length,0);f.accounts[10]=original;assert.equal((await f.run('distribution')).status,'confirmed');assert.equal(f.sent.length,1);
});
test('unknown payout packets reconcile before recipient repair and unsafe replacement accounts fail closed',async()=>{
 for(const status of ['signed','prepared','confirmed']){const f=fixture();f.accounts[10]=null;f.setPrior({status});assert.equal((await f.run('distribution')).status,'confirmed');assert.equal(f.sent.length,1);}
 for(const mutate of [f=>{f.accounts[10].owner=key(90);},f=>{f.accounts[10].data[108]=2;},f=>{f.accounts[10].data.writeUInt32LE(0,109);},f=>{key(90).toBuffer().copy(f.accounts[10].data,32);}]){
  const f=fixture();mutate(f);await assert.rejects(f.run('distribution'),/payout/);assert.equal(f.sent.length,0);
 }
});
test('negative fee liability fails closed',async()=>{
 const f=fixture();f.state.writeBigUInt64LE(1000001n,56);await assert.rejects(f.run('token-burn'),/custody liability/);assert.equal(f.sent.length,0);
});
test('a parallel burn cannot make cumulative collection estimation negative',async()=>{
 const f=fixture(),after=Buffer.from(f.state);after.writeBigUInt64LE(0n,40);after.writeBigUInt64LE(1000000n,120);after.writeBigUInt64LE(2000000n,48);f.setSim(after);
 assert.equal((await f.run('fee-harvest')).status,'confirmed');
});
test('only explicit zero-trading-tokens errors are deferred; arbitrary simulation errors surface',async()=>{
 const dust=fixture();dust.setSim(null,{InstructionError:[1,{Custom:6006}]},['Program log: Error Code: ZeroTradingTokens. Error Number: 6006.']);assert.equal((await dust.run('fee-harvest')).status,'deferred');assert.equal(dust.sent.length,0);
 const error=fixture();error.setSim(null,{InstructionError:[1,{Custom:60}]},[]);await assert.rejects(error.run('fee-harvest'),/simulation refused/);assert.equal(error.sent.length,0);
});
