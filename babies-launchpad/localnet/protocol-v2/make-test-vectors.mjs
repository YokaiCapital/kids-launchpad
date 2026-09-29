// Writes test-vectors.json: the shared cases that policy.test.mjs (node:test) and
// programs/kids-launch-v2/src/vector_tests.rs (cargo test) both check. Amounts and times are decimal strings,
// 32-byte fields are hex. Run: node localnet/protocol-v2/make-test-vectors.mjs
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as p from './policy.mjs';
const s=v=>v.toString();
const SUPPLY=1_000_000_000_000_000n,SOL=1_000_000_000n,U64=p.U64_MAX;
const at=(y,m,d,seconds=0n)=>p.daysFromCivil(y,m,d)*p.SECONDS_PER_DAY+seconds;
const hex=(byte)=>Buffer.alloc(32,byte).toString('hex');
const settlement=[
 {name:'live Family campaign: 2,500 committed against a 1,000 cap',hard:1_000n*SOL,commits:[2_500n*SOL]},
 {name:'three wallets, 180 against 100',hard:100n*SOL,commits:[40n*SOL,60n*SOL,80n*SOL]},
 {name:'exactly the hard cap',hard:100n*SOL,commits:[50n*SOL,50n*SOL]},
 {name:'one lamport over the hard cap',hard:100n*SOL,commits:[50n*SOL,50n*SOL+1n]},
 {name:'one lamport under the hard cap',hard:100n*SOL,commits:[50n*SOL,50n*SOL-1n]},
 {name:'thirty single lamports against a cap of 20',hard:20n,commits:Array(30).fill(1n)},
 {name:'u64 extremes',hard:(1n<<63n)-1n,commits:[1n<<62n,(1n<<62n)+12345n]},
 {name:'u64 max total',hard:U64-1n,commits:[U64-1n,1n]},
 {name:'no commitments',hard:100n*SOL,commits:[]},
 {name:'rounding dust 11 of 761 against 500',hard:500n,commits:[11n,750n]},
].map(c=>{const total=c.commits.reduce((a,b)=>a+b,0n);const acceptedAmounts=c.commits.map(x=>p.accepted(x,total,c.hard));return {name:c.name,hard:s(c.hard),total:s(total),commits:c.commits.map(s),accepted:acceptedAmounts.map(s),refundable:c.commits.map(x=>s(p.refundable(x,total,c.hard,false))),totalAccepted:s(acceptedAmounts.reduce((a,b)=>a+b,0n))};});
const refund=[[11n,761n,500n,false],[11n,761n,500n,true],[11n,400n,500n,false],[U64,U64,U64-1n,false],[U64,U64,U64-1n,true],[0n,0n,5n,false],[5n,5n,0n,false]].map(([commit,total,hard,failed])=>({commit:s(commit),total:s(total),hard:s(hard),failed,refundable:s(p.refundable(commit,total,hard,failed))}));
const split=[];
for(const supply of [SUPPLY,0n,1n,7n,9_999n,10_000n,10_001n,19_999n,123_456_789n,U64-1n,U64]){for(const policy of [p.SPLIT_POLICY_STANDARD,p.SPLIT_POLICY_FAMILY,p.SPLIT_POLICY_STANDARD_V3]){const r=p.split(supply,p.splitForPolicy(policy));split.push({policy,supply:s(supply),participants:s(r.participants),liquidity:s(r.liquidity),parentA:s(r.parentA),parentB:s(r.parentB),dev:s(r.dev),dustToLiquidity:s(r.dustToLiquidity)});}}
const participantTokens=[[485_000_000_000_000n,1n,3n],[485_000_000_000_000n,3n,3n],[485_000_000_000_000n,22_222_222_222n,99_999_999_999n],[435_000_000_000_000n,1_000n*SOL,1_000n*SOL],[U64,U64,U64],[485_000_000_000_000n,0n,5n],[1n,1n,2n]].map(([reserve,acceptedAmount,totalAccepted])=>({reserve:s(reserve),accepted:s(acceptedAmount),totalAccepted:s(totalAccepted),tokens:s(p.participantTokens(reserve,acceptedAmount,totalAccepted))}));
const calendarMonths=[[at(2024n,1n,31n,123n),3],[at(2023n,11n,30n),3],[at(2024n,11n,30n),3],[at(2027n,11n,29n,7n),3],[at(2099n,11n,30n),3],[at(2026n,10n,31n,86_399n),3],[at(2026n,9n,24n,50_000n),3],[at(2026n,12n,31n),3],[at(2026n,1n,15n),1],[at(2028n,2n,29n),12],[0n,3],[1n,3]].map(([start,months])=>({start:s(start),months,end:s(p.calendarMonthsAfter(start,months))}));
const vesting=[];
for(const [supply,start] of [[SUPPLY,at(2028n,1n,31n)],[SUPPLY,at(2027n,11n,30n,3600n)],[U64,at(2026n,9n,24n)],[12_345n,at(2026n,9n,24n)],[9_999n,at(2026n,9n,24n)],[SUPPLY,at(2026n,12n,31n,1n)]]){
 const end=p.calendarMonthsAfter(start,3);
 for(const now of [start,start+1n,start+(end-start)/2n,end-1n,end,end+1n,end+86_400n*365n,p.I64_MAX]){for(const [rule,table] of [[p.VESTING_RULE_THREE_MONTHS,p.VESTING_THREE_MONTHS],[p.VESTING_RULE_STANDARD_V3,p.VESTING_STANDARD_V3]])vesting.push({rule,supply:s(supply),start:s(start),now:s(now),end:s(end),entitled:s(p.devEntitled(supply,table,start,now))});}
}
const feeRouting=[];
for(const collected of [0n,1n,167n,168n,169n,16_800_000n,1_000_000_007n,U64]){for(const mode of [p.MODE_STANDARD,p.MODE_FAMILY]){const e=p.feeEntitlements(collected,p.feeWeightsFor(1,mode));feeRouting.push({version:1,mode,collected:s(collected),treasury:s(e.treasury),dev:s(e.dev),parentA:s(e.parentA),parentB:s(e.parentB),dust:s(e.dust)});}}
const parentEligibility=[0n,1n,10_001n,1_000_000_000n,1_000_000_000_000n,U64].map(supply=>({parentSupply:s(supply),threshold:s(p.parentThreshold(supply))}));
const parentAllocation=[[100n,1n,3n],[50_000_000_000_000n,400_000_000_000n,400_000_000_000n],[50_000_000_000_000n,1n,400_000_000_000n],[U64,U64,U64]].map(([reserve,balance,eligible])=>({reserve:s(reserve),balance:s(balance),eligible:s(eligible),allocation:s(p.parentAllocation(reserve,balance,eligible))}));
const buybackFloor=[
 ['one SOL into 100 SOL / 1e6 parent at 0.25 %',1n*SOL,100n*SOL,1_000_000n,2_500n,150],
 ['the production quote case',1_000n,10_000n,10_000n,20_000n,200],
 ['parent A test pool, 1,000 lamports',1_000n,100n*SOL,1_000_000_000_000n,2_500n,150],
 ['parent A test pool, 0.3 SOL',300_000_000n,100n*SOL,1_000_000_000_000n,2_500n,150],
 ['parent A test pool, 0.5 SOL',500_000_000n,100n*SOL,1_000_000_000_000n,2_500n,150],
 ['parent B test pool, 0.5 SOL, on the 2.5 % tier',500_000_000n,50n*SOL,250_000_000_000n,25_000n,150],
 ['parent B test pool, 1,000 lamports, on the 2.5 % tier',1_000n,50n*SOL,250_000_000_000n,25_000n,150],
 ['no slippage allowance',10_000n,1_000_000n,1_000_000n,0n,0],
 ['the 5 % ceiling',10_000n,1_000_000n,1_000_000n,2_500n,500],
 ['u64 extremes',U64,U64,U64,25_000n,500],
 ['one unit of input is all fee',1n,1_000_000n,1_000_000n,2_500n,100],
 ['empty input reserve',1_000n,0n,1n,0n,100],
 ['empty output reserve',1_000n,1n,0n,0n,100],
 ['output rounds to zero',1_000n,1_000_000_000n,1n,0n,100],
 ['a 100 % fee is not a pool',1_000n,1n,1n,1_000_000n,100],
].map(([name,amount,reserveIn,reserveOut,tradeFeeRate,maxSlippageBps])=>{
 let referenceOut=null,floor=null;
 try{referenceOut=p.referenceOut(amount,reserveIn,reserveOut,tradeFeeRate);floor=s(p.buybackFloor(referenceOut,maxSlippageBps));referenceOut=s(referenceOut);}catch(thrown){if(!(thrown instanceof RangeError))throw thrown;}
 return {name,amount:s(amount),reserveIn:s(reserveIn),reserveOut:s(reserveOut),tradeFeeRate:s(tradeFeeRate),maxSlippageBps,referenceOut,floor};
});
const base={phase:1,opensAt:100n,deadline:200n,launchDeadline:300n,soft:50n,total:60n,receiptCount:2n,settledCount:2n,settledAccepted:60n};
const lifecycle=[];
for(const [patch,now] of [[{phase:0},99n],[{phase:0},100n],[{phase:0},199n],[{phase:0},200n],[{},200n],[{},299n],[{},300n],[{phase:0},250n],[{phase:2},250n],[{phase:3},250n],[{settledCount:1n},250n],[{receiptCount:0n,settledCount:0n},250n],[{settledAccepted:49n},250n],[{total:49n,settledAccepted:49n},250n],[{phase:3},400n],[{phase:1},400n]]){
 const r={...base,...patch};
 lifecycle.push({phase:r.phase,opensAt:s(r.opensAt),deadline:s(r.deadline),launchDeadline:s(r.launchDeadline),soft:s(r.soft),total:s(r.total),receiptCount:s(r.receiptCount),settledCount:s(r.settledCount),settledAccepted:s(r.settledAccepted),now:s(now),
  fundingOpen:p.fundingOpen(r.phase,r.opensAt,r.deadline,now),failed:p.launchFailed(r.phase,r.total,r.soft,r.launchDeadline,now),ready:p.launchReady(r,now)});
}
const standard={layoutVersion:2,mode:0,decimals:6,splitPolicy:1,vestingRule:1,feeRoutingVersion:1,creatorFeeEnabled:0,genesis:hex(7),creator:hex(1),nonce:'11',dev:hex(2),treasury:p.PLATFORM_TREASURY_HEX,childMint:hex(4),supply:s(SUPPLY),
 opensAt:'1790000100',deadline:'1790007300',launchDeadline:'1790014500',soft:s(50n*SOL),hard:s(100n*SOL),ammProgram:hex(0xa1),ammConfig:hex(0xa2),ammTradeFeeRate:'25000',ammConfigIndex:7,
 feeWeights:p.FEE_WEIGHTS_STANDARD,splitBps:p.SPLIT_STANDARD,vesting:p.VESTING_THREE_MONTHS,buybackMaxSlippageBps:0,lockProgram:hex(0xb1),distributionProgram:hex(0),
 parentMint:[hex(0),hex(0)],parentProgram:[hex(0),hex(0)],parentSlot:['0','0'],parentRoot:[hex(0),hex(0)],parentSupply:['0','0'],parentEligible:['0','0'],parentExpirySeconds:'0',
 metadataHash:hex(9),metadataUri:'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/kids.json',parentReferenceConfig:[0,0]};
// Family: parent A quotes against the config-0 pool (stored 1), parent B against config 7 (stored 8), fills may land 1.5 % under.
const family={...standard,mode:1,splitPolicy:2,feeWeights:p.FEE_WEIGHTS_FAMILY,splitBps:p.SPLIT_FAMILY,buybackMaxSlippageBps:150,distributionProgram:hex(0xd1),
 parentMint:[hex(0x11),hex(0x12)],parentProgram:[hex(0x21),hex(0x22)],parentSlot:['446208617','446208618'],parentRoot:[hex(0x31),hex(0x32)],parentSupply:['1000000000000','500000000000'],parentEligible:['400000000000','200000000000'],parentExpirySeconds:'2592000',
 metadataUri:'a'.repeat(128),parentReferenceConfig:[1,8]};
const extremes={...standard,nonce:s(U64),supply:s(U64),opensAt:s(p.I64_MAX-2n),deadline:s(p.I64_MAX-1n),launchDeadline:s(p.I64_MAX),soft:'1',hard:s(U64),ammTradeFeeRate:s(U64),ammConfigIndex:65535,buybackMaxSlippageBps:65535,metadataUri:'x',parentReferenceConfig:[254,255]};
const termsHash=[['standard',standard],['family',family],['extremes',extremes]].map(([name,terms])=>{const sealed=p.encodeTerms(terms);return {name,terms,sealedHex:sealed.toString('hex'),hash:p.termsHash(sealed).toString('hex')};});
const vectors={version:2,generatedBy:'localnet/protocol-v2/make-test-vectors.mjs',platformTreasury:p.PLATFORM_TREASURY_HEX,buybackSlippageCeilingBps:p.BUYBACK_SLIPPAGE_CEILING_BPS,settlement,refund,split,participantTokens,calendarMonths,vesting,feeRouting,parentEligibility,parentAllocation,lifecycle,buybackFloor,termsHash};
const path=fileURLToPath(new URL('./test-vectors.json',import.meta.url));
writeFileSync(path,JSON.stringify(vectors,null,1)+'\n');
console.log(`wrote ${path}: ${Object.entries(vectors).filter(([,v])=>Array.isArray(v)).map(([k,v])=>`${k} ${v.length}`).join(', ')}`);
