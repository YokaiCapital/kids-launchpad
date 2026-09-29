import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import * as c from '../protocol-v2/client.mjs';
import * as p from '../protocol-v2/policy.mjs';
import {withLiveVerification} from './live-verification.mjs';
const vector=JSON.parse(readFileSync(new URL('../protocol-v2/test-vectors.json',import.meta.url))).termsHash.find(x=>x.name==='standard').terms;
const key=n=>new PublicKey(Buffer.alloc(32,n));
const disc=name=>createHash('sha256').update('account:'+name).digest().subarray(0,8);
function fixture(){
 const program=key(11),genesis=key(12),t={...vector,genesis:c.keyHex(genesis),distributionProgram:c.keyHex(PublicKey.default)};
 const campaign=c.campaignAddress(program,t.creator,t.nonce),id={programId:String(program),genesisHash:String(genesis),campaign:String(campaign)};
 const data=Buffer.alloc(c.CAMPAIGN_LEN);c.CAMPAIGN_MAGIC.copy(data);p.encodeTerms(t).copy(data,8);p.termsHash(data.subarray(8,808)).copy(data,808);data[840]=3;
 const decoded=c.decodeCampaign(data),terms=decoded.terms,split=decoded.split,a=c.launchAddresses(program,campaign,terms,key(13));
 for(const [offset,amount]of [[848,terms.hard+1000n],[856,0n],[864,1n],[872,1n],[880,terms.hard],[920,200n]])data.writeBigUInt64LE(amount,offset);
 a.pool.toBuffer().copy(data,928);a.feeNft.toBuffer().copy(data,960);
 const owned=(owner,data,lamports=5000)=>({owner,data,lamports,executable:false});
 const token=(mint,owner,amount)=>{const d=Buffer.alloc(165);mint.toBuffer().copy(d);owner.toBuffer().copy(d,32);d.writeBigUInt64LE(amount,64);d[108]=1;if(mint.equals(c.WSOL)){d.writeUInt32LE(1,109);d.writeBigUInt64LE(2039280n,113);}return owned(c.TOKEN_PROGRAM,d);};
 const mint=(supply,decimals,authority=null)=>{const d=Buffer.alloc(82);d.writeBigUInt64LE(supply,36);d[44]=decimals;d[45]=1;if(authority){d.writeUInt32LE(1,0);authority.toBuffer().copy(d,4);}return owned(c.TOKEN_PROGRAM,d);};
 const lock=Buffer.alloc(256);disc('LockedCpLiquidityState').copy(lock);lock.writeBigUInt64LE(1000n,8);
 for(const [offset,k]of [[64,a.pool],[96,a.feeNft],[128,a.authority],[160,a.lpMint]])k.toBuffer().copy(lock,offset);
 const pool=Buffer.alloc(637);disc('PoolState').copy(pool);pool.writeBigUInt64LE(1100n,333);
 for(const [i,k]of [terms.ammConfig,a.authority,a.vault0,a.vault1,a.lpMint,a.mint0,a.mint1,c.TOKEN_PROGRAM,c.TOKEN_PROGRAM,a.observation].entries())k.toBuffer().copy(pool,8+32*i);
 const infos=[owned(program,data),mint(terms.supply,terms.decimals),token(terms.childMint,a.authority,terms.supply-split.liquidity),token(a.mint0,a.ammAuthority,a.mint0.equals(c.WSOL)?terms.hard:split.liquidity),token(a.mint1,a.ammAuthority,a.mint1.equals(c.WSOL)?terms.hard:split.liquidity),token(a.lpMint,a.lockAuthority,1000n),owned(terms.lockProgram,lock),token(a.feeNft,campaign,1n),mint(1n,0),owned(terms.ammProgram,pool),mint(1000n,9,a.ammAuthority),null];
 let slot=11;const reads=[];
 // The first read is intentionally stale relative to mutations to the snapshot.
 const initial={terms,termsHash:c.decodeCampaign(data).state.termsHash,phase:3,slot:10,pool:String(a.pool),feeNft:String(a.feeNft)};
 const base={programId:program,genesisHash:genesis,readCampaign:async()=>initial,verifyLaunch:async()=>{throw Error('Legacy verifier must not run');}};
 const connection={async getMultipleAccountsInfoAndContext(addresses,options){reads.push({addresses,options});return {context:{slot},value:infos};},getMinimumBalanceForRentExemption:async()=>1000};
 const chain=withLiveVerification(base,{connection,programVersion:3});
 return {id,chain,base,connection,initial,infos,data,terms,split,a,reads,setSlot:v=>slot=v,verify:()=>chain.verifyLaunch(id)};
}
test('current verification reads claims and every custody account in one finalized snapshot',async()=>{
 const f=fixture(),r=await f.verify();assert.equal(r.ok,true,JSON.stringify(r.failures));assert.equal(r.checks.kind,'current-standard-custody-v3');assert.equal(r.checks.slot,11);
 assert.deepEqual(f.reads[0].options,{commitment:'finalized',minContextSlot:10});assert.equal(f.reads[0].addresses.length,12);assert.equal(String(f.reads[0].addresses[0]),f.id.campaign);assert.equal(f.infos[11],null,'a version-0 campaign has no extension');
});
test('trades, claims, burns, donations and third-party liquidity do not invalidate a completed launch',async()=>{
 const f=fixture();
 f.data.writeBigUInt64LE(100n,888);f.data.writeBigUInt64LE(20n,896);
 f.infos[2].data.writeBigUInt64LE(f.terms.supply-f.split.liquidity-120n+10n,64); // claims + donation
 f.infos[1].data.writeBigUInt64LE(f.terms.supply-30n,36); // a holder burns
 const coin=f.a.mint0.equals(f.terms.childMint)?3:4,sol=coin===3?4:3;
 f.infos[coin].data.writeBigUInt64LE(f.split.liquidity-1000n,64);f.infos[sol].data.writeBigUInt64LE(f.terms.hard+500n,64); // trade
 f.infos[5].data.writeBigUInt64LE(1500n,64);f.infos[9].data.writeBigUInt64LE(3100n,333);f.infos[10].data.writeBigUInt64LE(3000n,36); // another LP position
 const r=await f.verify();assert.equal(r.ok,true,r.failures.join('; '));assert.equal(r.checks.remainingClaims,f.terms.supply-f.split.liquidity-120n);
});
test('missing, stale, truncated and foreign-owned RPC evidence fails closed',async()=>{
 const missing=fixture();missing.infos[3]=null;await assert.rejects(missing.verify(),/missing/);
 const stale=fixture();stale.setSlot(9);await assert.rejects(stale.verify(),/snapshot unavailable/);
 const short=fixture();short.infos.pop();await assert.rejects(short.verify(),/snapshot unavailable/);
 const owner=fixture();owner.infos[0].owner=key(80);await assert.rejects(owner.verify(),/owner or layout/);
 const layout=fixture();layout.infos[2].data=Buffer.alloc(166);await assert.rejects(layout.verify(),/owner or layout/);
 const lag=fixture();lag.connection.getMultipleAccountsInfoAndContext=async()=>{throw Object.assign(Error('Minimum context slot has not been reached'),{code:-32016});};await assert.rejects(lag.verify(),{code:'RPC_UNAVAILABLE'});
});
test('claim deficits, invalid counters, refund deficits and changed supply still reject',async()=>{
 for(const mutate of [
  f=>f.infos[2].data.writeBigUInt64LE(f.terms.supply-f.split.liquidity-1n,64),
  f=>f.data.writeBigUInt64LE(f.split.participants+1n,888),
  f=>{f.infos[0].lamports=1999;},
  f=>f.data.writeBigUInt64LE(1001n,856),
  f=>f.infos[1].data.writeBigUInt64LE(f.terms.supply+1n,36),
  f=>f.data.writeBigUInt64LE(0n,872),
  f=>f.data.writeBigUInt64LE(1n,904),
  f=>{f.data[842]=1;}
 ]){const f=fixture();mutate(f);const r=await f.verify();assert.equal(r.ok,false,'Unsafe counters must not verify');}
});
test('authorities, delegation, frozen accounts, pool identities and lock coverage remain enforced',async()=>{
 for(const mutate of [
  f=>{f.infos[1].data.writeUInt32LE(1,0);key(80).toBuffer().copy(f.infos[1].data,4);},
  f=>{f.infos[1].data.writeUInt32LE(1,46);key(80).toBuffer().copy(f.infos[1].data,50);},
  f=>{f.infos[2].data[108]=2;},
  f=>{f.infos[2].data.writeUInt32LE(1,72);key(80).toBuffer().copy(f.infos[2].data,76);},
  f=>key(80).toBuffer().copy(f.infos[9].data,8),
  f=>{f.infos[9].data[390]=1;},
  f=>{f.infos[6].data[0]^=1;},
  f=>key(80).toBuffer().copy(f.infos[6].data,128),
  f=>f.infos[5].data.writeBigUInt64LE(999n,64),
  f=>f.infos[7].data.writeBigUInt64LE(0n,64),
  f=>f.infos[10].data.writeBigUInt64LE(999n,36),
  f=>{f.infos[3].data.writeBigUInt64LE(0n,64);}
 ]){const f=fixture();mutate(f);assert.equal((await f.verify()).ok,false,'Unsafe custody must not verify');}
});
test('wrapper refuses old versions and foreign scope without altering the original adapter',async()=>{
 const f=fixture();assert.throws(()=>withLiveVerification(f.base,{connection:f.connection,programVersion:2}),/explicit v3/);
 await assert.rejects(f.chain.verifyLaunch({...f.id,genesisHash:String(key(80))}),/scope mismatch/);
 await assert.rejects(f.chain.verifyLaunch({...f.id,programId:String(key(80))}),/scope mismatch/);
 await assert.rejects(f.base.verifyLaunch(),/Legacy verifier/);assert.equal(f.reads.length,0);
});

// --- Funding-first campaigns (accounting version 2): the extension rides in the snapshot and replaces the settlement counters ---
function fundingFirst(f,{sealed=true,target=null,returned=0n}={}){
 const t=f.terms,s=c.decodeCampaign(f.data).state;
 f.data[992]=2;f.data.writeBigUInt64LE(0n,872);f.data.writeBigUInt64LE(0n,880); // no settlement counters in version 2
 const total=s.total,accepted=target??(total<t.hard?total:t.hard);
 const e=Buffer.alloc(256);e.write('KIDSEXT2',0);new PublicKey(f.id.campaign).toBuffer().copy(e,8);Buffer.from(s.termsHash,'hex').copy(e,40);t.childMint.toBuffer().copy(e,72);f.a.feeNft.toBuffer().copy(e,104);Buffer.alloc(32,7).copy(e,136);e[168]=2;e[169]=sealed?1:0;e.writeUInt32LE(Number(s.receiptCount),172);e.writeBigUInt64LE(total,176);e.writeBigUInt64LE(accepted,184);e.writeBigUInt64LE(returned,208);
 f.infos[11]={owner:new PublicKey(f.id.programId),data:e,lamports:5000,executable:false};
 // the pool's SOL side holds the accepted target; the campaign holds rent + unpaid excess + the collateral still held
 const sol=f.a.mint0.equals(c.WSOL)?3:4;f.infos[sol].data.writeBigUInt64LE(accepted,64);
 f.infos[0].lamports=Number(1000n+(total-accepted)+(65535n-returned)-s.refunded);
 return {total,accepted};
}
test('a funding-first campaign verifies from its sealed extension instead of settlement counters',async()=>{
 const f=fixture();const {total,accepted}=fundingFirst(f);
 const r=await f.verify();assert.equal(r.ok,true,JSON.stringify(r.failures));
 f.infos[0].lamports-=1;assert.equal((await f.verify()).ok,false,'one lamport below rent + excess + collateral fails');
});
test('funding-first refusals: unsealed, wrong target, settlement counters present, missing extension, collateral above bound',async()=>{
 let f=fixture();fundingFirst(f,{sealed:false});assert.ok((await f.verify()).failures.some(x=>/Sealed totals/.test(x)));
 f=fixture();fundingFirst(f,{target:f.terms.hard-1n});assert.ok((await f.verify()).failures.some(x=>/Sealed totals/.test(x)));
 f=fixture();fundingFirst(f);f.data.writeBigUInt64LE(1n,880);assert.ok((await f.verify()).failures.some(x=>/settlement counters/.test(x)));
 f=fixture();fundingFirst(f);f.infos[11]=null;await assert.rejects(f.verify(),/owner or layout at 11/);
 f=fixture();fundingFirst(f,{returned:65536n});assert.ok((await f.verify()).failures.some(x=>/Collateral returned/.test(x)));
 f=fixture();fundingFirst(f,{returned:65535n});f.infos[0].lamports=Number(1000n+(f.terms.hard+1000n-f.terms.hard));assert.equal((await f.verify()).ok,true,'after a full collateral return only rent + excess must remain');
 f=fixture();f.infos[11]={owner:new PublicKey(f.id.programId),data:Buffer.alloc(256),lamports:1,executable:false};assert.ok((await f.verify()).failures.some(x=>/version-0 campaign carries an extension/.test(x)));
 f=fixture();f.infos[11]={owner:new PublicKey('11111111111111111111111111111111'),data:Buffer.alloc(0),lamports:890880,executable:false};assert.equal((await f.verify()).ok,true,'a pre-funded empty system account at the extension address does not invalidate a version-0 coin');
 f=fixture();f.infos[11]={owner:new PublicKey('11111111111111111111111111111111'),data:Buffer.alloc(8),lamports:890880,executable:false};assert.ok((await f.verify()).failures.some(x=>/version-0 campaign carries an extension/.test(x)),'a system account holding data is not tolerated');
});
