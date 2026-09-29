// node --test localnet/protocol-v2/policy.test.mjs
// Hand-computed cases first (independent of the vector file), then every vector in test-vectors.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as p from './policy.mjs';
const vectors=JSON.parse(readFileSync(new URL('./test-vectors.json',import.meta.url),'utf8'));
const SUPPLY=1_000_000_000_000_000n,SOL=1_000_000_000n;
const ts=text=>BigInt(Date.parse(text)/1000);
test('v2 cannot sign terms that silently drop a future liquidity policy',()=>{
 const t=vectors.termsHash.find(v=>v.name==='standard').terms;
 for(const liquidityPolicy of [null,undefined,{kind:'standard-bounded-recycling-v1'}])assert.throws(()=>p.encodeTerms({...t,liquidityPolicy}),/new program version/);
});
test('split tables sum to 10000 and the dust goes to liquidity',()=>{
 assert.equal(p.splitSum(p.SPLIT_STANDARD),10000n);assert.equal(p.splitSum(p.SPLIT_FAMILY),10000n);
 assert.deepEqual(p.split(SUPPLY,p.SPLIT_STANDARD),{participants:485_000_000_000_000n,liquidity:485_000_000_000_000n,parentA:0n,parentB:0n,dev:30_000_000_000_000n,dustToLiquidity:0n});
 assert.deepEqual(p.split(SUPPLY,p.SPLIT_FAMILY),{participants:435_000_000_000_000n,liquidity:435_000_000_000_000n,parentA:50_000_000_000_000n,parentB:50_000_000_000_000n,dev:30_000_000_000_000n,dustToLiquidity:0n});
 assert.deepEqual(p.split(7n,p.SPLIT_STANDARD),{participants:0n,liquidity:7n,parentA:0n,parentB:0n,dev:0n,dustToLiquidity:7n});
 for(const supply of [0n,1n,9_999n,10_001n,123_456_789n,p.U64_MAX]){for(const bps of [p.SPLIT_STANDARD,p.SPLIT_FAMILY]){const r=p.split(supply,bps);assert.equal(r.participants+r.liquidity+r.parentA+r.parentB+r.dev,supply);assert.equal(r.dustToLiquidity,supply%10000n);}}
 assert.throws(()=>p.split(SUPPLY,{participants:5000,liquidity:5000,parentA:0,parentB:0,dev:300}));
 assert.throws(()=>p.split(-1n,p.SPLIT_STANDARD));assert.throws(()=>p.split(p.U64_MAX+1n,p.SPLIT_STANDARD));
});
test('settlement is floor(commit × min(T, H) / T) and refunds are the excess or everything',()=>{
 assert.equal(p.accepted(2_500n*SOL,2_500n*SOL,1_000n*SOL),1_000n*SOL);
 assert.equal(p.accepted(11n,761n,500n),7n);assert.equal(p.refundable(11n,761n,500n,false),4n);assert.equal(p.refundable(11n,761n,500n,true),11n);
 assert.equal(p.accepted(p.U64_MAX,p.U64_MAX,p.U64_MAX-1n),p.U64_MAX-1n);
 assert.equal(p.accepted(0n,0n,5n),0n);assert.equal(p.accepted(5n,5n,0n),0n);
 const commits=[40n*SOL,60n*SOL,80n*SOL];const total=180n*SOL;
 assert.deepEqual(commits.map(c=>p.accepted(c,total,100n*SOL)),[22_222_222_222n,33_333_333_333n,44_444_444_444n]);
 for(let a=1n;a<20n;a++)for(let b=1n;b<20n;b++)for(let cap=1n;cap<40n;cap++){const t=a+b;const aa=p.accepted(a,t,cap),ab=p.accepted(b,t,cap);assert.ok(aa+ab<=(cap<t?cap:t));assert.equal(p.refundable(a,t,cap,false),a-aa);}
});
test('participant tokens and parent allocation never exceed the reserve',()=>{
 assert.equal(p.participantTokens(485_000_000_000_000n,1n,3n),161_666_666_666_666n);
 assert.equal(p.participantTokens(485_000_000_000_000n,22_222_222_222n,99_999_999_999n),485_000_000_000_000n*22_222_222_222n/99_999_999_999n);
 assert.equal(p.participantTokens(p.U64_MAX,p.U64_MAX,p.U64_MAX),p.U64_MAX);
 assert.throws(()=>p.participantTokens(1n,1n,0n));assert.throws(()=>p.participantTokens(1n,4n,3n));
 assert.equal(p.parentThreshold(1n),1n);assert.equal(p.parentThreshold(10001n),6n);assert.equal(p.parentThreshold(1_000_000_000n),500_000n);
 assert.equal(p.parentAllocation(100n,1n,3n),33n);assert.throws(()=>p.parentAllocation(100n,11n,10n));
});
test('calendar months clamp month ends across leap years and keep the time of day',()=>{
 assert.equal(p.calendarMonthsAfter(ts('2024-01-31T00:02:03Z'),3),ts('2024-04-30T00:02:03Z'));
 assert.equal(p.calendarMonthsAfter(ts('2023-11-30T00:00:00Z'),3),ts('2024-02-29T00:00:00Z'));
 assert.equal(p.calendarMonthsAfter(ts('2024-11-30T00:00:00Z'),3),ts('2025-02-28T00:00:00Z'));
 assert.equal(p.calendarMonthsAfter(ts('2027-11-29T00:00:07Z'),3),ts('2028-02-29T00:00:07Z'));
 assert.equal(p.calendarMonthsAfter(ts('2099-11-30T00:00:00Z'),3),ts('2100-02-28T00:00:00Z'));
 assert.equal(p.calendarMonthsAfter(ts('2026-10-31T23:59:59Z'),3),ts('2027-01-31T23:59:59Z'));
 assert.equal(p.calendarMonthsAfter(ts('2026-12-31T00:00:00Z'),3),ts('2027-03-31T00:00:00Z'));
 assert.throws(()=>p.calendarMonthsAfter(-1n,3));assert.throws(()=>p.calendarMonthsAfter(10n,0));
 for(let day=0n;day<366n*8n;day++){const start=day*p.SECONDS_PER_DAY;const [y,m,d]=p.civilFromDays(start/p.SECONDS_PER_DAY);assert.equal(p.daysFromCivil(y,m,d),day);assert.equal(new Date(Number(start)*1000).toISOString().slice(0,10),`${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`);}
});
test('vesting is 1 % then 2 % linear with an exact final remainder',()=>{
 const start=ts('2028-01-31T00:00:00Z'),end=p.calendarMonthsAfter(start,3);assert.equal(end,ts('2028-04-30T00:00:00Z'));
 const rule=p.VESTING_THREE_MONTHS;
 assert.equal(p.devEntitled(SUPPLY,rule,start,start),SUPPLY/100n);
 assert.equal(p.devEntitled(SUPPLY,rule,start,start+(end-start)/2n),SUPPLY/50n);
 assert.equal(p.devEntitled(SUPPLY,rule,start,end),SUPPLY*3n/100n);
 assert.equal(p.devEntitled(SUPPLY,rule,start,end+1n),SUPPLY*3n/100n);
 assert.equal(p.devEntitled(SUPPLY,rule,start,p.I64_MAX),SUPPLY*3n/100n);
 assert.equal(p.devEntitled(SUPPLY,rule,start,end),p.split(SUPPLY,p.SPLIT_STANDARD).dev);
 assert.equal(p.devEntitled(12_345n,rule,start,end),300n);assert.equal(p.devEntitled(9_999n,rule,start,end),0n);
 assert.throws(()=>p.devEntitled(SUPPLY,rule,start,start-1n));assert.throws(()=>p.devEntitled(SUPPLY,rule,0n,1n));
 let last=0n;for(let step=0n;step<=1000n;step++){const e=p.devEntitled(SUPPLY,rule,start,start+(end-start)*step/1000n);assert.ok(e>=last);last=e;}
});
test('version-3 standard economics: 47.5 / 47.5 / 5 with 1.5 % at launch and 3.5 % linear, sealed as policy 3 and rule 2',()=>{
 assert.deepEqual(p.SPLIT_STANDARD_V3,{participants:4750,liquidity:4750,parentA:0,parentB:0,dev:500});assert.deepEqual(p.VESTING_STANDARD_V3,{instantBps:150,linearBps:350,months:3});
 assert.equal(p.splitPolicyForMode(p.MODE_STANDARD,3),p.SPLIT_POLICY_STANDARD_V3);assert.equal(p.splitPolicyForMode(p.MODE_STANDARD),p.SPLIT_POLICY_STANDARD);assert.equal(p.splitPolicyForMode(p.MODE_FAMILY,3),p.SPLIT_POLICY_FAMILY);
 assert.deepEqual(p.splitPoliciesForMode(p.MODE_STANDARD),[1,3]);assert.deepEqual(p.splitPoliciesForMode(p.MODE_FAMILY),[2]);
 assert.equal(p.vestingRuleForMode(p.MODE_STANDARD,3),p.VESTING_RULE_STANDARD_V3);assert.equal(p.vestingRuleForMode(p.MODE_STANDARD),p.VESTING_RULE_THREE_MONTHS);
 const start=ts('2028-01-31T00:00:00Z'),end=p.calendarMonthsAfter(start,3),rule=p.VESTING_STANDARD_V3;
 assert.equal(p.devEntitled(SUPPLY,rule,start,start),SUPPLY*15n/1000n);assert.equal(p.devEntitled(SUPPLY,rule,start,end),SUPPLY*5n/100n);assert.equal(p.devEntitled(SUPPLY,rule,start,end),p.split(SUPPLY,p.SPLIT_STANDARD_V3).dev);
 assert.equal(p.devEntitled(SUPPLY,rule,start,start+(end-start)/2n),SUPPLY*15n/1000n+SUPPLY*35n/2000n);
 const s=p.split(SUPPLY,p.SPLIT_STANDARD_V3);assert.equal(s.participants,s.liquidity);assert.equal(s.participants+s.liquidity+s.dev+s.dustToLiquidity,SUPPLY);
});
test('fee routing conserves every lamport',()=>{
 assert.deepEqual(p.feeEntitlements(168n,p.FEE_WEIGHTS_STANDARD),{treasury:148n,dev:20n,parentA:0n,parentB:0n,dust:0n});
 assert.deepEqual(p.feeEntitlements(16_800_000n,p.FEE_WEIGHTS_FAMILY),{treasury:9_800_000n,dev:2_000_000n,parentA:2_500_000n,parentB:2_500_000n,dust:0n});
 for(const collected of [0n,1n,167n,169n,1_000_000_007n,p.U64_MAX]){for(const w of [p.FEE_WEIGHTS_STANDARD,p.FEE_WEIGHTS_FAMILY]){const e=p.feeEntitlements(collected,w);assert.equal(e.treasury+e.dev+e.parentA+e.parentB+e.dust,collected);assert.ok(e.dust<168n);}}
 assert.equal(p.feeDenominator(p.FEE_WEIGHTS_STANDARD),168n);assert.equal(p.feeDenominator(p.FEE_WEIGHTS_FAMILY),168n);
 assert.equal(p.feeWeightsFor(2,0),null);assert.equal(p.feeWeightsFor(1,2),null);assert.equal(p.splitForPolicy(4),null);assert.equal(p.vestingForRule(3),null);assert.deepEqual(p.splitForPolicy(3),p.SPLIT_STANDARD_V3);assert.deepEqual(p.vestingForRule(2),p.VESTING_STANDARD_V3);
});
test('lifecycle rules at every boundary',()=>{
 assert.equal(p.fundingOpen(0,100n,200n,99n),false);assert.equal(p.fundingOpen(0,100n,200n,100n),true);assert.equal(p.fundingOpen(0,100n,200n,199n),true);assert.equal(p.fundingOpen(0,100n,200n,200n),false);assert.equal(p.fundingOpen(1,100n,200n,150n),false);
 assert.equal(p.launchFailed(0,50n,50n,300n,299n),false);assert.equal(p.launchFailed(0,49n,50n,300n,299n),true);assert.equal(p.launchFailed(1,50n,50n,300n,300n),true);assert.equal(p.launchFailed(3,50n,50n,300n,300n),false);assert.equal(p.launchFailed(2,50n,50n,300n,0n),true);
 const r={phase:1,soft:50n,deadline:200n,launchDeadline:300n,total:60n,receiptCount:2n,settledCount:2n,settledAccepted:60n};
 assert.equal(p.launchReady(r,200n),true);assert.equal(p.launchReady(r,299n),true);assert.equal(p.launchReady(r,199n),false);assert.equal(p.launchReady(r,300n),false);
 assert.equal(p.launchReady({...r,phase:0},200n),true);assert.equal(p.launchReady({...r,phase:2},200n),false);assert.equal(p.launchReady({...r,phase:3},200n),false);
 assert.equal(p.launchReady({...r,settledCount:1n},200n),false);assert.equal(p.launchReady({...r,settledAccepted:49n},200n),false);
});
test('sealed terms encode at the documented offsets and hash with the domain',()=>{
 const t=vectors.termsHash.find(v=>v.name==='family').terms;const d=Buffer.concat([Buffer.alloc(8),p.encodeTerms(t)]);
 assert.equal(d.length,808);assert.equal(d.readUInt16LE(8),2);assert.equal(d[10],1);assert.equal(d[11],6);assert.equal(d[12],2);assert.equal(d[13],1);assert.equal(d[14],1);assert.equal(d[15],0);
 assert.equal(d.subarray(16,48).toString('hex'),t.genesis);assert.equal(d.subarray(48,80).toString('hex'),t.creator);assert.equal(d.readBigUInt64LE(80),11n);
 assert.equal(d.readBigUInt64LE(184),SUPPLY);assert.equal(d.readBigInt64LE(192),1790000100n);assert.equal(d.readBigUInt64LE(216),50n*SOL);assert.equal(d.readBigUInt64LE(224),100n*SOL);
 assert.equal(d.readBigUInt64LE(296),25000n);assert.equal(d.readUInt16LE(304),7);
 assert.deepEqual([...d.subarray(306,314)],[98,0,20,0,25,0,25,0]);assert.deepEqual([...d.subarray(314,324)],[0xfe,0x10,0xfe,0x10,0xf4,0x01,0xf4,0x01,0x2c,0x01]);
 assert.deepEqual([...d.subarray(324,332)],[100,0,200,0,3,150,0,0],'vesting, then the slippage cap u16, then one zero byte');
 assert.equal(d.subarray(364,396).toString('hex'),t.distributionProgram);assert.equal(d.subarray(396,428).toString('hex'),t.parentMint[0]);assert.equal(d.subarray(428,460).toString('hex'),t.parentMint[1]);
 assert.equal(d.readBigUInt64LE(524),446208617n);assert.equal(d.readBigUInt64LE(532),446208618n);assert.equal(d.readBigUInt64LE(636),2592000n);
 assert.equal(d[676],128);assert.equal(d.subarray(677,805).toString('ascii'),'a'.repeat(128));assert.deepEqual([...d.subarray(805,808)],[1,8,0],'reference config index plus one per parent, then one zero byte');
 assert.equal(d.subarray(120,152).toString('hex'),p.PLATFORM_TREASURY_HEX);
 const standard=vectors.termsHash.find(v=>v.name==='standard').terms;const sd=Buffer.concat([Buffer.alloc(8),p.encodeTerms(standard)]);
 assert.deepEqual([...sd.subarray(329,332)],[0,0,0]);assert.deepEqual([...sd.subarray(805,808)],[0,0,0]);
 assert.throws(()=>p.encodeTerms({...t,buybackMaxSlippageBps:65536}));assert.throws(()=>p.encodeTerms({...t,parentReferenceConfig:[256,0]}));
 const sealed=d.subarray(8,808);
 assert.equal(p.termsHash(sealed).toString('hex'),createHash('sha256').update(Buffer.from('kids-launch-v2-terms')).update(sealed).digest('hex'));
 assert.notEqual(p.termsHash(sealed).toString('hex'),createHash('sha256').update(sealed).digest('hex'),'domain separated');
 assert.throws(()=>p.encodeTerms({...t,metadataUri:'a'.repeat(129)}));assert.throws(()=>p.encodeTerms({...t,creator:'00'}));assert.throws(()=>p.encodeTerms({...t,supply:'-1'}));
 assert.deepEqual(p.campaignSeeds(t.creator,t.nonce).map(b=>b.toString('hex')),['63616d706169676e',t.creator,'0b00000000000000']);
});
test('the reference output is the pool\'s own swap and the floor keeps the sealed share',()=>{
 assert.equal(p.referenceOut(1n*SOL,100n*SOL,1_000_000n,2_500n),9_876n);
 assert.equal(p.referenceOut(1_000n,10_000n,10_000n,20_000n),892n);
 assert.equal(p.referenceOut(1_000n,100n*SOL,1_000_000_000_000n,2_500n),9_969n);
 assert.throws(()=>p.referenceOut(1n,1_000_000n,1_000_000n,2_500n),RangeError);
 assert.throws(()=>p.referenceOut(0n,1n,1n,0n),RangeError);assert.throws(()=>p.referenceOut(1_000n,0n,1n,0n),RangeError);assert.throws(()=>p.referenceOut(1_000n,1n,0n,0n),RangeError);
 assert.throws(()=>p.referenceOut(1_000n,1_000_000_000n,1n,0n),RangeError);assert.throws(()=>p.referenceOut(1_000n,1n,1n,1_000_000n),RangeError);
 assert.equal(p.buybackFloor(10_000n,100),9_900n);assert.equal(p.buybackFloor(10_000n,150),9_850n);assert.equal(p.buybackFloor(10_000n,0),10_000n);
 assert.equal(p.buybackFloor(1n,500),1n);assert.equal(p.buybackFloor(0n,0),1n);assert.equal(p.buybackFloor(10_000n,10_000),1n);
 assert.equal(p.buybackFloor(p.referenceOut(1_000n,100n*SOL,1_000_000_000_000n,2_500n),150),9_819n);
 assert.equal(p.BUYBACK_SLIPPAGE_CEILING_BPS,500);assert.equal(p.PLATFORM_TREASURY_HEX.length,64);
});
test('every settlement vector conserves committed = accepted + refundable',()=>{
 for(const v of vectors.settlement){
  const total=v.commits.reduce((a,b)=>a+BigInt(b),0n);assert.equal(total,BigInt(v.total),v.name);
  let sum=0n;v.commits.forEach((c,i)=>{const a=p.accepted(c,total,v.hard);assert.equal(a,BigInt(v.accepted[i]),v.name);assert.equal(p.refundable(c,total,v.hard,false),BigInt(v.refundable[i]));assert.equal(a+BigInt(v.refundable[i]),BigInt(c));sum+=a;});
  assert.equal(sum,BigInt(v.totalAccepted));const cap=BigInt(v.hard)<total?BigInt(v.hard):total;assert.ok(sum<=cap,v.name);
 }
 for(const v of vectors.refund)assert.equal(p.refundable(v.commit,v.total,v.hard,v.failed),BigInt(v.refundable));
});
test('every split, participant, parent, calendar, vesting, fee and lifecycle vector matches',()=>{
 for(const v of vectors.split){const r=p.split(v.supply,p.splitForPolicy(v.policy));assert.deepEqual(Object.fromEntries(Object.entries(r).map(([k,x])=>[k,x.toString()])),{participants:v.participants,liquidity:v.liquidity,parentA:v.parentA,parentB:v.parentB,dev:v.dev,dustToLiquidity:v.dustToLiquidity});assert.equal(r.participants+r.liquidity+r.parentA+r.parentB+r.dev,BigInt(v.supply));}
 for(const v of vectors.participantTokens)assert.equal(p.participantTokens(v.reserve,v.accepted,v.totalAccepted),BigInt(v.tokens));
 for(const v of vectors.calendarMonths)assert.equal(p.calendarMonthsAfter(v.start,v.months),BigInt(v.end));
 for(const v of vectors.vesting){assert.equal(p.calendarMonthsAfter(v.start,3),BigInt(v.end));assert.equal(p.devEntitled(v.supply,p.vestingForRule(v.rule),v.start,v.now),BigInt(v.entitled));}
 assert.ok(vectors.vesting.some(v=>v.rule===2)&&vectors.split.some(v=>v.policy===3),'version-3 standard vectors present');
 for(const v of vectors.feeRouting){const e=p.feeEntitlements(v.collected,p.feeWeightsFor(v.version,v.mode));assert.deepEqual(Object.fromEntries(Object.entries(e).map(([k,x])=>[k,x.toString()])),{treasury:v.treasury,dev:v.dev,parentA:v.parentA,parentB:v.parentB,dust:v.dust});}
 for(const v of vectors.parentEligibility)assert.equal(p.parentThreshold(v.parentSupply),BigInt(v.threshold));
 for(const v of vectors.parentAllocation)assert.equal(p.parentAllocation(v.reserve,v.balance,v.eligible),BigInt(v.allocation));
 for(const v of vectors.lifecycle){assert.equal(p.fundingOpen(v.phase,v.opensAt,v.deadline,v.now),v.fundingOpen);assert.equal(p.launchFailed(v.phase,v.total,v.soft,v.launchDeadline,v.now),v.failed);assert.equal(p.launchReady(v,v.now),v.ready);}
 for(const v of vectors.termsHash){const sealed=p.encodeTerms(v.terms);assert.equal(sealed.toString('hex'),v.sealedHex,v.name);assert.equal(p.termsHash(sealed).toString('hex'),v.hash,v.name);}
 for(const v of vectors.buybackFloor){
  if(v.referenceOut===null){assert.throws(()=>p.referenceOut(v.amount,v.reserveIn,v.reserveOut,v.tradeFeeRate),RangeError,v.name);continue;}
  const out=p.referenceOut(v.amount,v.reserveIn,v.reserveOut,v.tradeFeeRate);assert.equal(out,BigInt(v.referenceOut),v.name);assert.equal(p.buybackFloor(out,v.maxSlippageBps),BigInt(v.floor),v.name);
 }
 assert.equal(vectors.version,2);assert.equal(vectors.platformTreasury,p.PLATFORM_TREASURY_HEX);
 assert.ok(vectors.settlement.length>=10&&vectors.vesting.length>=40&&vectors.termsHash.length===3&&vectors.buybackFloor.length>=12);
});
