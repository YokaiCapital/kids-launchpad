// Public-launch policy, program version 2 (programs/kids-launch-v2/src/policy.rs in JavaScript).
// Every amount is a BigInt of minor units (lamports, token minor units). Every function here has the same
// name, inputs and integer semantics as its Rust twin; test-vectors.json is checked from both sides.
// Policy tables are proposals until the decision register carries an activation record for them
// (deployment/decisions/DECISION-REGISTER-2026-09-24.md).
import {createHash} from 'node:crypto';

export const MODE_STANDARD=0;
export const MODE_FAMILY=1;
export const BPS_DENOMINATOR=10000n;
export const SECONDS_PER_DAY=86400n;
export const PHASE_FUNDING=0;
export const PHASE_CLOSED=1;
export const PHASE_REFUND_ONLY=2;
export const PHASE_LIVE=3;
export const U64_MAX=(1n<<64n)-1n;
export const I64_MAX=(1n<<63n)-1n;

export const SPLIT_POLICY_STANDARD=1;
export const SPLIT_POLICY_FAMILY=2;
// Version-3 Standard economics sealed by the owner on 27 September 2026: 47.5 % participants, 47.5 % liquidity, 5 % dev,
// with 1.5 % at launch and 3.5 % linear over three calendar months. The version-3 issuer refuses any other Standard
// tables at creation; version 2 keeps policy 1 and rule 1 for its own identity and vectors.
export const SPLIT_POLICY_STANDARD_V3=3;
export const SPLIT_STANDARD=Object.freeze({participants:4850,liquidity:4850,parentA:0,parentB:0,dev:300});
export const SPLIT_FAMILY=Object.freeze({participants:4350,liquidity:4350,parentA:500,parentB:500,dev:300});
export const SPLIT_STANDARD_V3=Object.freeze({participants:4750,liquidity:4750,parentA:0,parentB:0,dev:500});
export const VESTING_RULE_THREE_MONTHS=1;
export const VESTING_THREE_MONTHS=Object.freeze({instantBps:100,linearBps:200,months:3});
export const VESTING_RULE_STANDARD_V3=2;
export const VESTING_STANDARD_V3=Object.freeze({instantBps:150,linearBps:350,months:3});
export const FEE_ROUTING_VERSION_1=1;
export const FEE_WEIGHTS_STANDARD=Object.freeze({treasury:148,dev:20,parentA:0,parentB:0});
export const FEE_WEIGHTS_FAMILY=Object.freeze({treasury:98,dev:20,parentA:25,parentB:25});
export const TERMS_HASH_DOMAIN=Buffer.from('kids-launch-v2-terms');
// The platform treasury every campaign seals (deployment/MAINNET-IDENTITIES.json treasuryWallet.address,
// 91eLwFTAxkcQLPSMxbzdSFkTyEwyRYcoZk64HMZj8vX as 32 bytes); the program refuses any other sealed treasury.
export const PLATFORM_TREASURY_HEX='020d5fde31a2acb8ef4fb1e5f1f4034f1907798a66e887aa9255f3bcefca8bac';
// Largest sealed buybackMaxSlippageBps a Family campaign may carry (5 %).
export const BUYBACK_SLIPPAGE_CEILING_BPS=500;
export const AMM_FEE_DENOMINATOR=1_000_000n;

export function u64(value,name='value'){
 const n=typeof value==='bigint'?value:BigInt(String(value));
 if(n<0n||n>U64_MAX)throw new RangeError(`${name} must fit u64`);
 return n;
}
export function i64(value,name='value'){
 const n=typeof value==='bigint'?value:BigInt(String(value));
 if(n<-(1n<<63n)||n>I64_MAX)throw new RangeError(`${name} must fit i64`);
 return n;
}
function u16(value,name){const n=Number(value);if(!Number.isInteger(n)||n<0||n>65535)throw new RangeError(`${name} must fit u16`);return n;}
function u8(value,name){const n=Number(value);if(!Number.isInteger(n)||n<0||n>255)throw new RangeError(`${name} must fit u8`);return n;}

export function splitForPolicy(id){return id===SPLIT_POLICY_STANDARD?SPLIT_STANDARD:id===SPLIT_POLICY_FAMILY?SPLIT_FAMILY:id===SPLIT_POLICY_STANDARD_V3?SPLIT_STANDARD_V3:null;}
/** The policy a mode seals: version 2 keeps the original tables; version 3 Standard seals policy 3. */
export function splitPolicyForMode(mode,programVersion=2){return mode===MODE_STANDARD?(programVersion>=3?SPLIT_POLICY_STANDARD_V3:SPLIT_POLICY_STANDARD):mode===MODE_FAMILY?SPLIT_POLICY_FAMILY:null;}
export function splitPoliciesForMode(mode){return mode===MODE_STANDARD?[SPLIT_POLICY_STANDARD,SPLIT_POLICY_STANDARD_V3]:mode===MODE_FAMILY?[SPLIT_POLICY_FAMILY]:[];}
export function vestingForRule(id){return id===VESTING_RULE_THREE_MONTHS?VESTING_THREE_MONTHS:id===VESTING_RULE_STANDARD_V3?VESTING_STANDARD_V3:null;}
export function vestingRuleForMode(mode,programVersion=2){return mode===MODE_STANDARD&&programVersion>=3?VESTING_RULE_STANDARD_V3:VESTING_RULE_THREE_MONTHS;}
export function feeWeightsFor(version,mode){
 if(version!==FEE_ROUTING_VERSION_1)return null;
 return mode===MODE_STANDARD?FEE_WEIGHTS_STANDARD:mode===MODE_FAMILY?FEE_WEIGHTS_FAMILY:null;
}
export function splitSum(bps){return BigInt(bps.participants+bps.liquidity+bps.parentA+bps.parentB+bps.dev);}
export function feeDenominator(weights){return BigInt(weights.treasury+weights.dev+weights.parentA+weights.parentB);}

/// supply / 10000 * bps: the integer share rule shared with the live programs.
export function share(supply,bps){return u64(supply,'supply')/BPS_DENOMINATOR*BigInt(u16(bps,'bps'));}
/// Reserves of one campaign. The remainder supply % 10000 goes to liquidity so the five reserves sum to the supply.
export function split(supply,bps){
 supply=u64(supply,'supply');
 if(splitSum(bps)!==BPS_DENOMINATOR)throw new RangeError('split table must sum to 10000');
 const participants=share(supply,bps.participants),parentA=share(supply,bps.parentA),parentB=share(supply,bps.parentB),dev=share(supply,bps.dev);
 const exactLiquidity=share(supply,bps.liquidity);
 const dustToLiquidity=supply-(participants+exactLiquidity+parentA+parentB+dev);
 return {participants,liquidity:exactLiquidity+dustToLiquidity,parentA,parentB,dev,dustToLiquidity};
}

// Calendar arithmetic (proleptic Gregorian, UTC), the same integer formulas as the Rust side.
export function civilFromDays(z){
 z=BigInt(z)+719468n;
 const era=(z>=0n?z:z-146096n)/146097n;
 const doe=z-era*146097n;
 const yoe=(doe-doe/1460n+doe/36524n-doe/146096n)/365n;
 let y=yoe+era*400n;
 const doy=doe-(365n*yoe+yoe/4n-yoe/100n);
 const mp=(5n*doy+2n)/153n;
 const d=doy-(153n*mp+2n)/5n+1n;
 const m=mp+(mp<10n?3n:-9n);
 if(m<=2n)y+=1n;
 return [y,m,d];
}
export function daysFromCivil(y,m,d){
 y=BigInt(y);m=BigInt(m);d=BigInt(d);
 if(m<=2n)y-=1n;
 const era=(y>=0n?y:y-399n)/400n;
 const yoe=y-era*400n;
 const doy=(153n*(m+(m>2n?-3n:9n))+2n)/5n+d-1n;
 return era*146097n+yoe*365n+yoe/4n-yoe/100n+doy-719468n;
}
export function isLeapYear(year){year=BigInt(year);return year%4n===0n&&(year%100n!==0n||year%400n===0n);}
export function daysInMonth(year,month){month=BigInt(month);if(month===2n)return isLeapYear(year)?29n:28n;if([4n,6n,9n,11n].includes(month))return 30n;return 31n;}
function floorDiv(a,b){const q=a/b;return (a%b!==0n&&(a<0n)!==(b<0n))?q-1n:q;}
function floorMod(a,b){return a-floorDiv(a,b)*b;}
/// Same calendar day and time of day `months` months after `start`, the day clamped to the end of the target month.
export function calendarMonthsAfter(start,months){
 start=i64(start,'start');months=u8(months,'months');
 if(start<0n||months===0)throw new RangeError('start must be non-negative and months positive');
 const [y,m,d]=civilFromDays(start/SECONDS_PER_DAY);
 const monthIndex=y*12n+(m-1n)+BigInt(months);
 const year=floorDiv(monthIndex,12n),month=floorMod(monthIndex,12n)+1n;
 const day=d<daysInMonth(year,month)?d:daysInMonth(year,month);
 const end=daysFromCivil(year,month,day)*SECONDS_PER_DAY+start%SECONDS_PER_DAY;
 return i64(end,'end');
}
/// Dev tokens entitled at `now` for a launch at `start`: instant share at once, linear share pro rata to the calendar end.
export function devEntitled(supply,rule,start,now){
 supply=u64(supply,'supply');start=i64(start,'start');now=i64(now,'now');
 if(start<=0n)throw new RangeError('start must be positive');
 if(now<start)throw new RangeError('not yet claimable');
 const end=calendarMonthsAfter(start,rule.months);
 if(end<=start)throw new RangeError('vesting end must follow the start');
 const instant=share(supply,rule.instantBps),linear=share(supply,rule.linearBps);
 const elapsed=(now<end?now:end)-start,span=end-start;
 return instant+linear*elapsed/span;
}
/// Cumulative entitlement of every recipient out of `collected` lamports; dust stays in the fee custody.
export function feeEntitlements(collected,weights){
 collected=u64(collected,'collected');
 const denominator=feeDenominator(weights);
 if(denominator===0n)throw new RangeError('fee weights must not all be zero');
 const part=weight=>collected*BigInt(weight)/denominator;
 const treasury=part(weights.treasury),dev=part(weights.dev),parentA=part(weights.parentA),parentB=part(weights.parentB);
 return {treasury,dev,parentA,parentB,dust:collected-(treasury+dev+parentA+parentB)};
}
/// What the reference pool itself would pay for `amount` of the input token (Raydium CPMM swap_base_input: the trade
/// fee rounded up and taken from the input, then the constant product on the reserves). Throws when it cannot quote.
export function referenceOut(amount,reserveIn,reserveOut,tradeFeeRate){
 amount=u64(amount,'amount');reserveIn=u64(reserveIn,'reserveIn');reserveOut=u64(reserveOut,'reserveOut');tradeFeeRate=u64(tradeFeeRate,'tradeFeeRate');
 if(amount===0n||reserveIn===0n||reserveOut===0n||tradeFeeRate>=AMM_FEE_DENOMINATOR)throw new RangeError('the reference pool cannot quote');
 const fee=(amount*tradeFeeRate+AMM_FEE_DENOMINATOR-1n)/AMM_FEE_DENOMINATOR;
 const net=amount-fee;
 if(net<=0n)throw new RangeError('the fee eats the whole input');
 const out=net*reserveOut/(reserveIn+net);
 if(out===0n)throw new RangeError('the output rounds to zero');
 return out;
}
/// The least min_out tag 25 accepts: the reference output less the sealed slippage, never below one unit.
export function buybackFloor(referenceOutAmount,maxSlippageBps){
 referenceOutAmount=u64(referenceOutAmount,'referenceOut');const bps=BigInt(u16(maxSlippageBps,'maxSlippageBps'));
 const kept=bps>BPS_DENOMINATOR?0n:BPS_DENOMINATOR-bps;
 const floor=referenceOutAmount*kept/BPS_DENOMINATOR;
 return floor<1n?1n:floor;
}
/// accepted_i = floor(commit_i × min(T, H) / T); the whole commitment when the campaign is not oversubscribed.
export function accepted(commit,total,hard){
 commit=u64(commit,'commit');total=u64(total,'total');hard=u64(hard,'hard');
 if(total===0n)return 0n;
 if(total<=hard)return commit;
 return commit*hard/total;
}
export function refundable(commit,total,hard,failed){commit=u64(commit,'commit');return failed?commit:commit-accepted(commit,total,hard);}
/// floor(participant_reserve × accepted_i / A) for A > 0.
export function participantTokens(reserve,acceptedAmount,totalAccepted){
 reserve=u64(reserve,'reserve');acceptedAmount=u64(acceptedAmount,'accepted');totalAccepted=u64(totalAccepted,'totalAccepted');
 if(totalAccepted===0n||acceptedAmount>totalAccepted)throw new RangeError('accepted must be within a positive total');
 return reserve*acceptedAmount/totalAccepted;
}
/// 0.05 % of the parent's snapshot supply, rounded up.
export function parentThreshold(parentSupply){return (u64(parentSupply,'parentSupply')*5n+9999n)/10000n;}
export function parentAllocation(reserve,balance,eligibleTotal){
 reserve=u64(reserve,'reserve');balance=u64(balance,'balance');eligibleTotal=u64(eligibleTotal,'eligibleTotal');
 if(eligibleTotal===0n||balance>eligibleTotal)throw new RangeError('balance must be within a positive eligible total');
 return reserve*balance/eligibleTotal;
}

export function fundingOpen(phase,opensAt,deadline,now){opensAt=i64(opensAt);deadline=i64(deadline);now=i64(now);return phase===PHASE_FUNDING&&now>=opensAt&&now<deadline;}
export function launchFailed(phase,total,soft,launchDeadline,now){total=u64(total);soft=u64(soft);launchDeadline=i64(launchDeadline);now=i64(now);return phase===PHASE_REFUND_ONLY||total<soft||(now>=launchDeadline&&phase!==PHASE_LIVE);}
/** Deadline-aware failure: a round that is still open is never failed, whatever its total. After the funding deadline the
 * chain rule (`launchFailed`) decides. Every refund grant, reserve return and status read uses this; `launchFailed` alone
 * mirrors the program for a moment at or after the deadline. */
export function campaignFailed(c,now){now=i64(now);return now>=i64(c.deadline)&&launchFailed(c.phase,c.total,c.soft,c.launchDeadline,now);}
export function launchReady(r,now){
 now=i64(now);const total=u64(r.total),soft=u64(r.soft),receiptCount=u64(r.receiptCount),settledCount=u64(r.settledCount),settledAccepted=u64(r.settledAccepted);
 return now>=i64(r.deadline)&&now<i64(r.launchDeadline)&&(r.phase===PHASE_FUNDING||r.phase===PHASE_CLOSED)&&total>=soft
  &&receiptCount>0n&&settledCount===receiptCount&&settledAccepted>=soft;
}
/** Funding-first accounting (version 2, `ready_v2` in programs/kids-launch-v3/src/funding_first.rs): inside the launch window,
 * not yet live, funded to the soft cap. No per-receipt condition: receipts are accounted after the launch, exactly once. */
export function launchReadyV2(r,now){
 now=i64(now);const total=u64(r.total),soft=u64(r.soft);
 return now>=i64(r.deadline)&&now<i64(r.launchDeadline)&&(r.phase===PHASE_FUNDING||r.phase===PHASE_CLOSED)&&total>=soft;
}

// Sealed terms encoding: the campaign account bytes 8..808 (programs/kids-launch-v2/src/state.rs), also the tag 0 body.
export const CAMPAIGN_LEN=1024;
export const RECEIPT_LEN=128;
export const LAYOUT_VERSION=2;
export const SEALED_START=8;
export const SEALED_END=808;
export const SEALED_LEN=SEALED_END-SEALED_START;
export const METADATA_URI_MAX=128;
export const OFFSETS=Object.freeze({
 layoutVersion:8,mode:10,decimals:11,splitPolicy:12,vestingRule:13,feeRoutingVersion:14,creatorFeeEnabled:15,genesis:16,creator:48,nonce:80,dev:88,treasury:120,childMint:152,supply:184,
 opensAt:192,deadline:200,launchDeadline:208,soft:216,hard:224,ammProgram:232,ammConfig:264,ammTradeFeeRate:296,ammConfigIndex:304,feeWeights:306,splitBps:314,
 vestingInstantBps:324,vestingLinearBps:326,vestingMonths:328,buybackMaxSlippageBps:329,lockProgram:332,distributionProgram:364,parentMint:396,parentProgram:460,parentSlot:524,parentRoot:540,
 parentSupply:604,parentEligible:620,parentExpirySeconds:636,metadataHash:644,metadataUriLen:676,metadataUri:677,parentReferenceConfig:805,
 termsHash:808,phase:840,bump:841,flags:842,total:848,refunded:856,receiptCount:864,settledCount:872,settledAccepted:880,participantClaimed:888,devClaimed:896,parentClaimed:904,launchTime:920,pool:928,feeNft:960,
});
function bytes32(value,name){
 const b=Buffer.isBuffer(value)?value:Buffer.from(String(value),'hex');
 if(b.length!==32)throw new RangeError(`${name} must be 32 bytes`);
 return b;
}
/// Encodes sealed terms into the 800 sealed bytes. 32-byte fields are hex strings or Buffers; amounts and times are
/// BigInt-compatible; small ids are numbers.
export function encodeTerms(t){
 // v2 seals an all-LP permanent lock. Never silently omit a future custody policy from its signed bytes.
 if(Object.hasOwn(t,'liquidityPolicy'))throw new Error('liquidityPolicy requires a new program version; v2 permanently locks all LP');
 const d=Buffer.alloc(SEALED_END);
 const o=OFFSETS;
 d.writeUInt16LE(u16(t.layoutVersion,'layoutVersion'),o.layoutVersion);
 d[o.mode]=u8(t.mode,'mode');d[o.decimals]=u8(t.decimals,'decimals');d[o.splitPolicy]=u8(t.splitPolicy,'splitPolicy');d[o.vestingRule]=u8(t.vestingRule,'vestingRule');
 d[o.feeRoutingVersion]=u8(t.feeRoutingVersion,'feeRoutingVersion');d[o.creatorFeeEnabled]=u8(t.creatorFeeEnabled,'creatorFeeEnabled');
 bytes32(t.genesis,'genesis').copy(d,o.genesis);bytes32(t.creator,'creator').copy(d,o.creator);
 d.writeBigUInt64LE(u64(t.nonce,'nonce'),o.nonce);
 bytes32(t.dev,'dev').copy(d,o.dev);bytes32(t.treasury,'treasury').copy(d,o.treasury);bytes32(t.childMint,'childMint').copy(d,o.childMint);
 d.writeBigUInt64LE(u64(t.supply,'supply'),o.supply);
 d.writeBigInt64LE(i64(t.opensAt,'opensAt'),o.opensAt);d.writeBigInt64LE(i64(t.deadline,'deadline'),o.deadline);d.writeBigInt64LE(i64(t.launchDeadline,'launchDeadline'),o.launchDeadline);
 d.writeBigUInt64LE(u64(t.soft,'soft'),o.soft);d.writeBigUInt64LE(u64(t.hard,'hard'),o.hard);
 bytes32(t.ammProgram,'ammProgram').copy(d,o.ammProgram);bytes32(t.ammConfig,'ammConfig').copy(d,o.ammConfig);
 d.writeBigUInt64LE(u64(t.ammTradeFeeRate,'ammTradeFeeRate'),o.ammTradeFeeRate);d.writeUInt16LE(u16(t.ammConfigIndex,'ammConfigIndex'),o.ammConfigIndex);
 [t.feeWeights.treasury,t.feeWeights.dev,t.feeWeights.parentA,t.feeWeights.parentB].forEach((w,i)=>d.writeUInt16LE(u16(w,'feeWeight'),o.feeWeights+2*i));
 [t.splitBps.participants,t.splitBps.liquidity,t.splitBps.parentA,t.splitBps.parentB,t.splitBps.dev].forEach((b,i)=>d.writeUInt16LE(u16(b,'splitBps'),o.splitBps+2*i));
 d.writeUInt16LE(u16(t.vesting.instantBps,'instantBps'),o.vestingInstantBps);d.writeUInt16LE(u16(t.vesting.linearBps,'linearBps'),o.vestingLinearBps);d[o.vestingMonths]=u8(t.vesting.months,'months');
 d.writeUInt16LE(u16(t.buybackMaxSlippageBps,'buybackMaxSlippageBps'),o.buybackMaxSlippageBps);
 // Per parent: 0 = no reference pool, n = Raydium CPMM AMM config index n - 1 of the parent/WSOL pool tag 25 quotes against.
 for(let i=0;i<2;i++)d[o.parentReferenceConfig+i]=u8(t.parentReferenceConfig[i],'parentReferenceConfig');
 bytes32(t.lockProgram,'lockProgram').copy(d,o.lockProgram);bytes32(t.distributionProgram,'distributionProgram').copy(d,o.distributionProgram);
 for(let i=0;i<2;i++){
  bytes32(t.parentMint[i],'parentMint').copy(d,o.parentMint+32*i);bytes32(t.parentProgram[i],'parentProgram').copy(d,o.parentProgram+32*i);
  d.writeBigUInt64LE(u64(t.parentSlot[i],'parentSlot'),o.parentSlot+8*i);bytes32(t.parentRoot[i],'parentRoot').copy(d,o.parentRoot+32*i);
  d.writeBigUInt64LE(u64(t.parentSupply[i],'parentSupply'),o.parentSupply+8*i);d.writeBigUInt64LE(u64(t.parentEligible[i],'parentEligible'),o.parentEligible+8*i);
 }
 d.writeBigUInt64LE(u64(t.parentExpirySeconds,'parentExpirySeconds'),o.parentExpirySeconds);
 bytes32(t.metadataHash,'metadataHash').copy(d,o.metadataHash);
 const uri=Buffer.from(String(t.metadataUri),'ascii');
 if(uri.length>METADATA_URI_MAX)throw new RangeError('metadataUri longer than 128 bytes');
 d[o.metadataUriLen]=uri.length;uri.copy(d,o.metadataUri);
 return d.subarray(SEALED_START,SEALED_END);
}
export function termsHash(sealed){
 if(sealed.length!==SEALED_LEN)throw new RangeError('sealed terms must be 800 bytes');
 return createHash('sha256').update(TERMS_HASH_DOMAIN).update(sealed).digest();
}
export function campaignSeeds(creator,nonce){const n=Buffer.alloc(8);n.writeBigUInt64LE(u64(nonce,'nonce'));return [Buffer.from('campaign'),bytes32(creator,'creator'),n];}
export function receiptSeeds(campaign,owner){return [Buffer.from('commitment'),bytes32(campaign,'campaign'),bytes32(owner,'owner')];}
export function launchAuthoritySeeds(campaign){return [Buffer.from('launch_authority'),bytes32(campaign,'campaign')];}
