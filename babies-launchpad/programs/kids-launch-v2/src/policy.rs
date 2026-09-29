//! Pure arithmetic of the public-launch policy: settlement, refunds, the supply split with its dust rule, dev
//! vesting on UTC calendar months, fee-routing weights, parent eligibility, the lifecycle rules and the sealed
//! terms hash. Nothing here reads an account. `localnet/protocol-v2/policy.mjs` implements the same functions
//! and `localnet/protocol-v2/test-vectors.json` is checked from both sides (`vector_tests.rs`).
//!
//! Every policy table below is a *proposal* until the decision register carries an activation record for it
//! (`deployment/decisions/DECISION-REGISTER-2026-09-24.md`). The program refuses any table that does not match
//! its policy id, so a campaign cannot seal a split, vesting rule or routing that no id describes.
use crate::{err,E_FEE_REFERENCE,E_NOT_YET_CLAIMABLE,E_OVERFLOW,E_POLICY_TABLE,E_TERMS_INVALID};
use solana_program::{hash::hashv,program_error::ProgramError};

pub const MODE_STANDARD:u8=0;
pub const MODE_FAMILY:u8=1;
pub const BPS_DENOMINATOR:u64=10_000;
pub const SECONDS_PER_DAY:i64=86_400;

/// Campaign phases. 0 covers "scheduled" and "funding open"; the clock decides which (`funding_open`).
pub const PHASE_FUNDING:u8=0;
pub const PHASE_CLOSED:u8=1;
pub const PHASE_REFUND_ONLY:u8=2;
pub const PHASE_LIVE:u8=3;

/// Supply split in basis points of the original supply. The five entries sum to 10,000.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct SplitBps{pub participants:u16,pub liquidity:u16,pub parent_a:u16,pub parent_b:u16,pub dev:u16}
pub const SPLIT_POLICY_STANDARD:u8=1;
pub const SPLIT_POLICY_FAMILY:u8=2;
/// Standard economics sealed for the public version-3 issuer (owner, 27 September 2026): 47.5 % participants,
/// 47.5 % liquidity, 5 % dev. Version 3 refuses any other Standard split at creation; version 2 keeps policy 1.
pub const SPLIT_POLICY_STANDARD_V3:u8=3;
/// Standard, version 2: 48.5 % participants, 48.5 % liquidity, 3 % dev (retained for the version-2 identity).
pub const SPLIT_STANDARD:SplitBps=SplitBps{participants:4850,liquidity:4850,parent_a:0,parent_b:0,dev:300};
/// Family: 43.5 % participants, 43.5 % liquidity, 5 % per parent, 3 % dev (as the live Family campaign).
pub const SPLIT_FAMILY:SplitBps=SplitBps{participants:4350,liquidity:4350,parent_a:500,parent_b:500,dev:300};
/// The version-3 Standard table behind split policy 3.
pub const SPLIT_STANDARD_V3:SplitBps=SplitBps{participants:4750,liquidity:4750,parent_a:0,parent_b:0,dev:500};
impl SplitBps{
 pub fn sum(&self)->u64{self.participants as u64+self.liquidity as u64+self.parent_a as u64+self.parent_b as u64+self.dev as u64}
 pub fn for_policy(id:u8)->Option<SplitBps>{match id{SPLIT_POLICY_STANDARD=>Some(SPLIT_STANDARD),SPLIT_POLICY_FAMILY=>Some(SPLIT_FAMILY),SPLIT_POLICY_STANDARD_V3=>Some(SPLIT_STANDARD_V3),_=>None}}
 /// The version-2 default policy of a mode (kept for the version-2 identity and its vectors).
 pub fn policy_for_mode(mode:u8)->Option<u8>{match mode{MODE_STANDARD=>Some(SPLIT_POLICY_STANDARD),MODE_FAMILY=>Some(SPLIT_POLICY_FAMILY),_=>None}}
 /// Every policy a mode may seal. The version-3 issuer narrows Standard to `SPLIT_POLICY_STANDARD_V3` on its own.
 pub fn policies_for_mode(mode:u8)->&'static [u8]{match mode{MODE_STANDARD=>&[SPLIT_POLICY_STANDARD,SPLIT_POLICY_STANDARD_V3],MODE_FAMILY=>&[SPLIT_POLICY_FAMILY],_=>&[]}}
}

/// Token reserves of one campaign. `dust_to_liquidity` is the remainder `supply % 10000` that the integer
/// share rule leaves over; it is added to the liquidity reserve so that the five reserves sum to the minted
/// supply exactly. Liquidity is locked forever, so the dust is owed to nobody and can never be claimed.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct Split{pub participants:u64,pub liquidity:u64,pub parent_a:u64,pub parent_b:u64,pub dev:u64,pub dust_to_liquidity:u64}
impl Split{
 pub fn total(&self)->Result<u64,ProgramError>{
  self.participants.checked_add(self.liquidity).and_then(|n|n.checked_add(self.parent_a)).and_then(|n|n.checked_add(self.parent_b)).and_then(|n|n.checked_add(self.dev)).ok_or(err(E_OVERFLOW))
 }
}
/// `supply / 10000 * bps`: the integer share rule shared with the live programs. Never overflows for bps <= 10000.
pub fn share(supply:u64,bps:u16)->u64{supply/BPS_DENOMINATOR*bps as u64}
pub fn split(supply:u64,bps:SplitBps)->Result<Split,ProgramError>{
 if bps.sum()!=BPS_DENOMINATOR{return Err(err(E_POLICY_TABLE))}
 let participants=share(supply,bps.participants);let parent_a=share(supply,bps.parent_a);let parent_b=share(supply,bps.parent_b);let dev=share(supply,bps.dev);
 let exact_liquidity=share(supply,bps.liquidity);
 let allocated=participants.checked_add(exact_liquidity).and_then(|n|n.checked_add(parent_a)).and_then(|n|n.checked_add(parent_b)).and_then(|n|n.checked_add(dev)).ok_or(err(E_OVERFLOW))?;
 let dust_to_liquidity=supply.checked_sub(allocated).ok_or(err(E_OVERFLOW))?;
 let liquidity=exact_liquidity.checked_add(dust_to_liquidity).ok_or(err(E_OVERFLOW))?;
 Ok(Split{participants,liquidity,parent_a,parent_b,dev,dust_to_liquidity})
}

/// Dev vesting: `instant_bps` of the supply at launch, `linear_bps` linearly over `months` UTC calendar months.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct VestingRule{pub instant_bps:u16,pub linear_bps:u16,pub months:u8}
pub const VESTING_RULE_THREE_MONTHS:u8=1;
/// 1 % at launch, 2 % linear over three calendar months, no cliff (version 2 and the live Family campaign).
pub const VESTING_THREE_MONTHS:VestingRule=VestingRule{instant_bps:100,linear_bps:200,months:3};
/// Version-3 Standard dev vesting (owner, 27 September 2026): 1.5 % at launch, 3.5 % linear over three calendar
/// months, no cliff; together the 5 % dev share of `SPLIT_STANDARD_V3`.
pub const VESTING_RULE_STANDARD_V3:u8=2;
pub const VESTING_STANDARD_V3:VestingRule=VestingRule{instant_bps:150,linear_bps:350,months:3};
impl VestingRule{
 pub fn for_rule(id:u8)->Option<VestingRule>{match id{VESTING_RULE_THREE_MONTHS=>Some(VESTING_THREE_MONTHS),VESTING_RULE_STANDARD_V3=>Some(VESTING_STANDARD_V3),_=>None}}
 pub fn total_bps(&self)->u64{self.instant_bps as u64+self.linear_bps as u64}
}
pub fn civil_from_days(z:i64)->(i64,i64,i64){let z=z+719468;let era=if z>=0{z}else{z-146096}/146097;let doe=z-era*146097;let yoe=(doe-doe/1460+doe/36524-doe/146096)/365;let mut y=yoe+era*400;let doy=doe-(365*yoe+yoe/4-yoe/100);let mp=(5*doy+2)/153;let d=doy-(153*mp+2)/5+1;let m=mp+if mp<10{3}else{-9};if m<=2{y+=1}(y,m,d)}
pub fn days_from_civil(mut y:i64,m:i64,d:i64)->i64{if m<=2{y-=1}let era=if y>=0{y}else{y-399}/400;let yoe=y-era*400;let doy=(153*(m+if m>2{-3}else{9})+2)/5+d-1;era*146097+yoe*365+yoe/4-yoe/100+doy-719468}
pub fn is_leap_year(year:i64)->bool{year%4==0&&(year%100!=0||year%400==0)}
pub fn days_in_month(year:i64,month:i64)->i64{match month{2=>if is_leap_year(year){29}else{28},4|6|9|11=>30,_=>31}}
/// Same calendar day and time of day `months` months after `start`, the day clamped to the end of the target
/// month (31 January + 3 months = 30 April; 30 November + 3 months = 28 or 29 February).
pub fn calendar_months_after(start:i64,months:u8)->Result<i64,ProgramError>{
 if start<0||months==0{return Err(err(E_OVERFLOW))}
 let(y,m,d)=civil_from_days(start/SECONDS_PER_DAY);
 let month_index=y*12+(m-1)+months as i64;let year=month_index/12;let month=month_index%12+1;
 let day=d.min(days_in_month(year,month));
 days_from_civil(year,month,day).checked_mul(SECONDS_PER_DAY).and_then(|v|v.checked_add(start%SECONDS_PER_DAY)).ok_or(err(E_OVERFLOW))
}
/// Dev tokens entitled at `now` for a launch at `start`: the instant share at once, the linear share pro rata
/// between `start` and the calendar end, the full linear share (exact remainder) from the end on. Entitlement is a
/// share of the *original* supply; later burns do not change it.
pub fn dev_entitled(supply:u64,rule:VestingRule,start:i64,now:i64)->Result<u64,ProgramError>{
 if start<=0{return Err(err(E_OVERFLOW))}
 if now<start{return Err(err(E_NOT_YET_CLAIMABLE))}
 let end=calendar_months_after(start,rule.months)?;if end<=start{return Err(err(E_OVERFLOW))}
 let instant=share(supply,rule.instant_bps);let linear=share(supply,rule.linear_bps);
 let elapsed=(now.min(end)-start) as u128;let span=(end-start) as u128;
 let vested=(linear as u128*elapsed/span) as u64;
 instant.checked_add(vested).ok_or(err(E_OVERFLOW))
}

/// SOL fee routing weights per collected lamport of eligible LP fees. Denominator is the sum of the weights.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct FeeWeights{pub treasury:u16,pub dev:u16,pub parent_a:u16,pub parent_b:u16}
pub const FEE_ROUTING_VERSION_1:u8=1;
/// Standard, version 1: 148/168 treasury, 20/168 dev (register, proposed).
pub const FEE_WEIGHTS_STANDARD:FeeWeights=FeeWeights{treasury:148,dev:20,parent_a:0,parent_b:0};
/// Family, version 1: 98/168 treasury, 20/168 dev, 25/168 per parent (as deployed on the live Family campaign).
pub const FEE_WEIGHTS_FAMILY:FeeWeights=FeeWeights{treasury:98,dev:20,parent_a:25,parent_b:25};
impl FeeWeights{
 pub fn denominator(&self)->u64{self.treasury as u64+self.dev as u64+self.parent_a as u64+self.parent_b as u64}
 pub fn for_version_and_mode(version:u8,mode:u8)->Option<FeeWeights>{
  match(version,mode){(FEE_ROUTING_VERSION_1,MODE_STANDARD)=>Some(FEE_WEIGHTS_STANDARD),(FEE_ROUTING_VERSION_1,MODE_FAMILY)=>Some(FEE_WEIGHTS_FAMILY),_=>None}
 }
}
/// Cumulative entitlement of every recipient out of `collected` lamports; `dust` (below one denominator unit) stays
/// in the fee custody, never paid and never lost.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct FeeEntitlement{pub treasury:u64,pub dev:u64,pub parent_a:u64,pub parent_b:u64,pub dust:u64}
pub fn fee_entitlements(collected:u64,weights:FeeWeights)->Result<FeeEntitlement,ProgramError>{
 let denominator=weights.denominator() as u128;if denominator==0{return Err(err(E_POLICY_TABLE))}
 let part=|weight:u16|(collected as u128*weight as u128/denominator) as u64;
 let treasury=part(weights.treasury);let dev=part(weights.dev);let parent_a=part(weights.parent_a);let parent_b=part(weights.parent_b);
 let paid=treasury.checked_add(dev).and_then(|n|n.checked_add(parent_a)).and_then(|n|n.checked_add(parent_b)).ok_or(err(E_OVERFLOW))?;
 Ok(FeeEntitlement{treasury,dev,parent_a,parent_b,dust:collected.checked_sub(paid).ok_or(err(E_OVERFLOW))?})
}

/// Largest sealed `buyback_max_slippage_bps` a Family campaign may carry (5 %): how far below the reference pool's
/// own output a Jupiter fill may land.
pub const BUYBACK_SLIPPAGE_CEILING_BPS:u16=500;
/// Raydium's fee denominator: trade fee rates are per 1,000,000.
pub const AMM_FEE_DENOMINATOR:u64=1_000_000;
/// What the reference pool itself would pay for `amount` of the input token: Raydium CPMM `swap_base_input`, the
/// trade fee rounded up and taken from the input, then the constant product on the reserves net of accrued fees.
/// Refused (never a zero floor) when a reserve is empty, the fee eats the whole input, or the output rounds to zero.
pub fn reference_out(amount:u64,reserve_in:u64,reserve_out:u64,trade_fee_rate:u64)->Result<u64,ProgramError>{
 if amount==0||reserve_in==0||reserve_out==0||trade_fee_rate>=AMM_FEE_DENOMINATOR{return Err(err(E_FEE_REFERENCE))}
 let fee=(amount as u128*trade_fee_rate as u128).div_ceil(AMM_FEE_DENOMINATOR as u128);
 let net=(amount as u128).checked_sub(fee).ok_or(err(E_FEE_REFERENCE))?;
 if net==0{return Err(err(E_FEE_REFERENCE))}
 let out=net*reserve_out as u128/(reserve_in as u128+net);
 if out==0{return Err(err(E_FEE_REFERENCE))}
 Ok(out as u64)
}
/// The least `min_out` tag 25 accepts: the reference output less the sealed slippage, never below one unit.
pub fn buyback_floor(reference_out:u64,max_slippage_bps:u16)->u64{
 let kept=(BPS_DENOMINATOR as u128).saturating_sub(max_slippage_bps as u128);
 ((reference_out as u128*kept/BPS_DENOMINATOR as u128) as u64).max(1)
}

/// `accepted_i = floor(commit_i × min(T, H) / T)`; the whole commitment when the campaign is not oversubscribed.
pub fn accepted(commit:u64,total:u64,hard:u64)->u64{
 if total==0{return 0}
 if total<=hard{return commit}
 (commit as u128*hard as u128/total as u128) as u64
}
/// Lamports a receipt may take back in total: everything after a failure, otherwise the unaccepted excess.
pub fn refundable(commit:u64,total:u64,hard:u64,failed:bool)->u64{if failed{commit}else{commit-accepted(commit,total,hard)}}
/// `floor(participant_reserve × accepted_i / A)` for `A > 0`.
pub fn participant_tokens(reserve:u64,accepted:u64,total_accepted:u64)->Result<u64,ProgramError>{
 if total_accepted==0||accepted>total_accepted{return Err(err(E_TERMS_INVALID))}
 Ok((reserve as u128*accepted as u128/total_accepted as u128) as u64)
}
/// Family parents: 0.05 % of the parent's snapshot supply, rounded up, is the holding threshold.
pub fn parent_threshold(parent_supply:u64)->u64{(parent_supply as u128*5).div_ceil(10_000) as u64}
/// `floor(reserve × balance / eligible_total)` for one parent holder above the threshold.
pub fn parent_allocation(reserve:u64,balance:u64,eligible_total:u64)->Result<u64,ProgramError>{
 if eligible_total==0||balance>eligible_total{return Err(err(E_TERMS_INVALID))}
 Ok((reserve as u128*balance as u128/eligible_total as u128) as u64)
}

/// Commits are accepted in `[opens_at, deadline)` by the chain clock while the phase is still 0. Reaching the hard
/// cap changes nothing here: oversubscription is settled pro rata, it never closes funding.
pub fn funding_open(phase:u8,opens_at:i64,deadline:i64,now:i64)->bool{phase==PHASE_FUNDING&&now>=opens_at&&now<deadline}
/// A campaign has failed when it closed below the soft cap or its launch deadline passed without a launch.
pub fn launch_failed(phase:u8,total:u64,soft:u64,launch_deadline:i64,now:i64)->bool{
 phase==PHASE_REFUND_ONLY||total<soft||(now>=launch_deadline&&phase!=PHASE_LIVE)
}
/// Everything a launch needs: funding closed, launch window open, not failed, not live, every registered receipt
/// settled, and the settled accepted total at least the soft cap (integer rounding can leave it below the total).
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct Readiness{pub phase:u8,pub soft:u64,pub deadline:i64,pub launch_deadline:i64,pub total:u64,pub receipt_count:u64,pub settled_count:u64,pub settled_accepted:u64}
pub fn launch_ready(r:Readiness,now:i64)->bool{
 now>=r.deadline&&now<r.launch_deadline&&(r.phase==PHASE_FUNDING||r.phase==PHASE_CLOSED)&&r.total>=r.soft
 &&r.receipt_count>0&&r.settled_count==r.receipt_count&&r.settled_accepted>=r.soft
}

/// Domain-separated SHA-256 of the sealed terms bytes (the campaign account's terms region, `state::SEALED_LEN`
/// bytes). Clients compute the same hash from the same encoding and compare it with the stored one.
pub const TERMS_HASH_DOMAIN:&[u8]=b"kids-launch-v2-terms";
pub fn terms_hash(sealed:&[u8])->[u8;32]{hashv(&[TERMS_HASH_DOMAIN,sealed]).to_bytes()}

#[cfg(test)]mod tests{use super::*;
 const SUPPLY:u64=1_000_000_000_000_000;
 #[test]fn split_tables_sum_to_ten_thousand_and_the_dust_goes_to_liquidity(){
  assert_eq!(SPLIT_STANDARD.sum(),10_000);assert_eq!(SPLIT_FAMILY.sum(),10_000);assert_eq!(SPLIT_STANDARD_V3.sum(),10_000);assert_eq!(VESTING_STANDARD_V3.total_bps(),SPLIT_STANDARD_V3.dev as u64);assert_eq!(SplitBps::policies_for_mode(MODE_STANDARD),&[1,3]);assert_eq!(SplitBps::policies_for_mode(MODE_FAMILY),&[2]);assert_eq!(SplitBps::for_policy(3),Some(SPLIT_STANDARD_V3));assert_eq!(VestingRule::for_rule(2),Some(VESTING_STANDARD_V3));
  let s=split(SUPPLY,SPLIT_STANDARD).unwrap();
  assert_eq!(s,Split{participants:485_000_000_000_000,liquidity:485_000_000_000_000,parent_a:0,parent_b:0,dev:30_000_000_000_000,dust_to_liquidity:0});
  let f=split(SUPPLY,SPLIT_FAMILY).unwrap();
  assert_eq!((f.participants,f.liquidity,f.parent_a,f.parent_b,f.dev),(435_000_000_000_000,435_000_000_000_000,50_000_000_000_000,50_000_000_000_000,30_000_000_000_000));
  for supply in [0u64,1,7,9_999,10_000,10_001,19_999,123_456_789,SUPPLY,u64::MAX-1,u64::MAX]{
   for bps in [SPLIT_STANDARD,SPLIT_FAMILY]{
    let s=split(supply,bps).unwrap();
    assert_eq!(s.total().unwrap(),supply,"reserves sum to the minted supply for {supply}");
    assert_eq!(s.dust_to_liquidity,supply%10_000);assert!(s.dust_to_liquidity<10_000);
    assert_eq!(s.liquidity,share(supply,bps.liquidity)+s.dust_to_liquidity);
    assert_eq!(s.dev,share(supply,VESTING_THREE_MONTHS.instant_bps)+share(supply,VESTING_THREE_MONTHS.linear_bps),"the dev reserve is exactly instant plus linear");
   }
  }
  assert_eq!(split(SUPPLY,SplitBps{participants:5000,liquidity:5000,parent_a:0,parent_b:0,dev:300}).unwrap_err(),err(E_POLICY_TABLE));
  assert_eq!(split(7,SPLIT_STANDARD).unwrap(),Split{participants:0,liquidity:7,parent_a:0,parent_b:0,dev:0,dust_to_liquidity:7});
 }
 #[test]fn policy_ids_resolve_to_their_tables_and_nothing_else(){
  assert_eq!(SplitBps::for_policy(1),Some(SPLIT_STANDARD));assert_eq!(SplitBps::for_policy(2),Some(SPLIT_FAMILY));assert_eq!(SplitBps::for_policy(0),None);assert_eq!(SplitBps::for_policy(3),Some(SPLIT_STANDARD_V3));assert_eq!(SplitBps::for_policy(4),None);
  assert_eq!(SplitBps::policy_for_mode(MODE_STANDARD),Some(1));assert_eq!(SplitBps::policy_for_mode(MODE_FAMILY),Some(2));assert_eq!(SplitBps::policy_for_mode(2),None);
  assert_eq!(VestingRule::for_rule(1),Some(VESTING_THREE_MONTHS));assert_eq!(VestingRule::for_rule(2),Some(VESTING_STANDARD_V3));assert_eq!(VestingRule::for_rule(3),None);assert_eq!(VESTING_THREE_MONTHS.total_bps(),300);
  assert_eq!(FeeWeights::for_version_and_mode(1,0),Some(FEE_WEIGHTS_STANDARD));assert_eq!(FeeWeights::for_version_and_mode(1,1),Some(FEE_WEIGHTS_FAMILY));
  assert_eq!(FeeWeights::for_version_and_mode(2,0),None);assert_eq!(FeeWeights::for_version_and_mode(1,2),None);
  assert_eq!(FEE_WEIGHTS_STANDARD.denominator(),168);assert_eq!(FEE_WEIGHTS_FAMILY.denominator(),168);
 }
 #[test]fn fee_entitlements_conserve_every_lamport(){
  assert_eq!(fee_entitlements(168,FEE_WEIGHTS_STANDARD).unwrap(),FeeEntitlement{treasury:148,dev:20,parent_a:0,parent_b:0,dust:0});
  assert_eq!(fee_entitlements(16_800_000,FEE_WEIGHTS_FAMILY).unwrap(),FeeEntitlement{treasury:9_800_000,dev:2_000_000,parent_a:2_500_000,parent_b:2_500_000,dust:0});
  for collected in [0u64,1,167,169,1_000_000_007,u64::MAX]{for w in [FEE_WEIGHTS_STANDARD,FEE_WEIGHTS_FAMILY]{
   let e=fee_entitlements(collected,w).unwrap();
   assert_eq!(e.treasury+e.dev+e.parent_a+e.parent_b+e.dust,collected);assert!(e.dust<168);
  }}
  assert_eq!(fee_entitlements(5,FeeWeights{treasury:0,dev:0,parent_a:0,parent_b:0}).unwrap_err(),err(E_POLICY_TABLE));
 }
 #[test]fn settlement_matches_the_live_rule_and_conserves_at_the_extremes(){
  assert_eq!(accepted(2_500_000_000_000,2_500_000_000_000,1_000_000_000_000),1_000_000_000_000,"the live Family campaign: 2,500 committed, 1,000 accepted");
  assert_eq!(accepted(11,761,500),7);assert_eq!(refundable(11,761,500,false),4);assert_eq!(refundable(11,761,500,true),11);assert_eq!(refundable(11,400,500,false),0);
  assert_eq!(accepted(u64::MAX,u64::MAX,u64::MAX-1),u64::MAX-1);assert_eq!(refundable(u64::MAX,u64::MAX,u64::MAX-1,false),1);
  assert_eq!(accepted(0,0,5),0);assert_eq!(accepted(5,5,0),0,"a zero hard cap accepts nothing");
  for a in 1..20u64{for b in 1..20{for cap in 1..40{let total=a+b;let aa=accepted(a,total,cap);let ab=accepted(b,total,cap);
   assert!(aa+ab<=cap.min(total));assert!(aa<=a&&ab<=b);assert_eq!(refundable(a,total,cap,false),a-aa);}}}
 }
 #[test]fn participant_tokens_never_exceed_the_reserve(){
  let reserve=485_000_000_000_000u64;
  assert_eq!(participant_tokens(reserve,1,3).unwrap(),161_666_666_666_666);
  assert_eq!(participant_tokens(reserve,3,3).unwrap(),reserve);
  assert_eq!(participant_tokens(u64::MAX,u64::MAX,u64::MAX).unwrap(),u64::MAX);
  assert!(participant_tokens(reserve,1,0).is_err());assert!(participant_tokens(reserve,4,3).is_err());
  let parts=[1u64,1,1,999_999_997];let total:u64=parts.iter().sum();
  let paid:u64=parts.iter().map(|p|participant_tokens(reserve,*p,total).unwrap()).sum();assert!(paid<=reserve&&reserve-paid<parts.len() as u64);
 }
 #[test]fn parent_threshold_rounds_up_and_allocation_bounds_inputs(){
  assert_eq!(parent_threshold(1),1);assert_eq!(parent_threshold(10001),6);assert_eq!(parent_threshold(1_000_000_000),500_000);assert_eq!(parent_threshold(0),0);
  assert!(parent_allocation(100,11,10).is_err());assert!(parent_allocation(100,1,0).is_err());assert_eq!(parent_allocation(100,1,3).unwrap(),33);
 }
 #[test]fn calendar_months_clamp_month_ends_across_leap_years_and_keep_the_time_of_day(){
  let at=|y,m,d,seconds:i64|days_from_civil(y,m,d)*SECONDS_PER_DAY+seconds;
  assert_eq!(calendar_months_after(at(2024,1,31,123),3).unwrap(),at(2024,4,30,123));
  assert_eq!(calendar_months_after(at(2023,11,30,0),3).unwrap(),at(2024,2,29,0),"2024 is a leap year");
  assert_eq!(calendar_months_after(at(2024,11,30,0),3).unwrap(),at(2025,2,28,0));
  assert_eq!(calendar_months_after(at(2027,11,29,7),3).unwrap(),at(2028,2,29,7),"2028 is a leap year");
  assert_eq!(calendar_months_after(at(2099,11,30,0),3).unwrap(),at(2100,2,28,0),"2100 is not a leap year");
  assert_eq!(calendar_months_after(at(2026,10,31,86_399),3).unwrap(),at(2027,1,31,86_399));
  assert_eq!(calendar_months_after(at(2026,9,24,50_000),3).unwrap(),at(2026,12,24,50_000));
  assert_eq!(calendar_months_after(at(2026,12,31,0),3).unwrap(),at(2027,3,31,0),"crosses a year end");
  assert_eq!(calendar_months_after(at(2026,1,15,0),1).unwrap(),at(2026,2,15,0));
  assert!(calendar_months_after(-1,3).is_err());assert!(calendar_months_after(10,0).is_err());
  for day in 0..(366*8){let start=day*SECONDS_PER_DAY+3600;let(y,m,d)=civil_from_days(start/SECONDS_PER_DAY);assert_eq!(days_from_civil(y,m,d),start/SECONDS_PER_DAY);}
 }
 #[test]fn vesting_is_one_percent_then_two_percent_linear_with_an_exact_final_remainder(){
  let start=days_from_civil(2028,1,31)*SECONDS_PER_DAY;let end=calendar_months_after(start,3).unwrap();
  assert_eq!(end,days_from_civil(2028,4,30)*SECONDS_PER_DAY);
  let rule=VESTING_THREE_MONTHS;
  assert_eq!(dev_entitled(SUPPLY,rule,start,start).unwrap(),SUPPLY/100,"launch: 1 %");
  assert_eq!(dev_entitled(SUPPLY,rule,start,start+(end-start)/2).unwrap(),SUPPLY/50,"halfway: 2 %");
  assert_eq!(dev_entitled(SUPPLY,rule,start,end).unwrap(),SUPPLY*3/100,"end: 3 % exactly");
  assert_eq!(dev_entitled(SUPPLY,rule,start,end-1).unwrap(),SUPPLY/100+((SUPPLY/50) as u128*((end-start-1) as u128)/((end-start) as u128)) as u64,"one second before the end");
  assert_eq!(dev_entitled(SUPPLY,rule,start,end+1).unwrap(),SUPPLY*3/100);
  assert_eq!(dev_entitled(SUPPLY,rule,start,i64::MAX).unwrap(),SUPPLY*3/100);
  assert_eq!(dev_entitled(SUPPLY,rule,start,start-1).unwrap_err(),err(E_NOT_YET_CLAIMABLE));
  assert!(dev_entitled(SUPPLY,rule,0,1).is_err());
  let split_dev=split(SUPPLY,SPLIT_STANDARD).unwrap().dev;assert_eq!(dev_entitled(SUPPLY,rule,start,end).unwrap(),split_dev,"the vested total is the whole dev reserve");
  let mut last=0;for step in 0..=1000{let now=start+(end-start)*step/1000;let e=dev_entitled(SUPPLY,rule,start,now).unwrap();assert!(e>=last);last=e;}
  assert_eq!(dev_entitled(u64::MAX,rule,start,end).unwrap(),share(u64::MAX,100)+share(u64::MAX,200));
  assert_eq!(dev_entitled(12_345,rule,start,end).unwrap(),300,"tiny supply: 12,345 / 10000 * 300");
  assert_eq!(dev_entitled(9_999,rule,start,end).unwrap(),0,"below one share unit nothing vests");
 }
 #[test]fn lifecycle_rules_at_every_boundary(){
  assert!(!funding_open(0,100,200,99));assert!(funding_open(0,100,200,100));assert!(funding_open(0,100,200,199));assert!(!funding_open(0,100,200,200));
  assert!(!funding_open(1,100,200,150));assert!(!funding_open(2,100,200,150));
  assert!(!launch_failed(0,50,50,300,299));assert!(launch_failed(0,49,50,300,299),"below soft");assert!(launch_failed(1,50,50,300,300),"launch deadline passed");
  assert!(!launch_failed(3,50,50,300,300),"live campaigns never fail");assert!(launch_failed(2,50,50,300,0),"refund-only is final");
  let r=Readiness{phase:1,soft:50,deadline:200,launch_deadline:300,total:60,receipt_count:2,settled_count:2,settled_accepted:60};
  assert!(launch_ready(r,200));assert!(launch_ready(r,299));assert!(!launch_ready(r,199));assert!(!launch_ready(r,300));
  assert!(launch_ready(Readiness{phase:0,..r},200),"finalize is not a prerequisite");
  assert!(!launch_ready(Readiness{phase:2,..r},200));assert!(!launch_ready(Readiness{phase:3,..r},200));
  assert!(!launch_ready(Readiness{settled_count:1,..r},200));assert!(!launch_ready(Readiness{receipt_count:0,settled_count:0,..r},200));
  assert!(!launch_ready(Readiness{settled_accepted:49,..r},200),"rounding below the soft cap is not launchable");assert!(launch_ready(Readiness{settled_accepted:50,..r},200));
  assert!(!launch_ready(Readiness{total:49,settled_accepted:49,..r},200));
 }
 #[test]fn reference_out_is_the_pools_own_swap_and_the_floor_keeps_the_sealed_share(){
  // 1 SOL into a 100 SOL / 1,000,000 parent pool at 0.25 %: fee 2,500,000, net 997,500,000, out 997,500,000 × 1e6 / 100,997,500,000.
  assert_eq!(reference_out(1_000_000_000,100_000_000_000,1_000_000,2_500).unwrap(),9_876);
  assert_eq!(reference_out(1_000,10_000,10_000,20_000).unwrap(),892,"the production quote before its 2 % haircut");
  assert_eq!(reference_out(1,1_000_000,1_000_000,2_500).unwrap_err(),err(E_FEE_REFERENCE),"a one-unit input is all fee");
  assert_eq!(reference_out(0,1,1,0).unwrap_err(),err(E_FEE_REFERENCE));
  assert_eq!(reference_out(1_000,0,1,0).unwrap_err(),err(E_FEE_REFERENCE));assert_eq!(reference_out(1_000,1,0,0).unwrap_err(),err(E_FEE_REFERENCE));
  assert_eq!(reference_out(1_000,1_000_000_000,1,0).unwrap_err(),err(E_FEE_REFERENCE),"an output that rounds to zero is no reference");
  assert_eq!(reference_out(1_000,1,1,1_000_000).unwrap_err(),err(E_FEE_REFERENCE),"a fee of 100 % is not a pool");
  assert_eq!(reference_out(u64::MAX,u64::MAX,u64::MAX,25_000).unwrap(),9_106_620_492_084_462_189,"u128 arithmetic at the extremes");
  assert_eq!(buyback_floor(10_000,100),9_900);assert_eq!(buyback_floor(10_000,150),9_850);assert_eq!(buyback_floor(10_000,0),10_000);
  assert_eq!(buyback_floor(1,500),1,"never below one unit");assert_eq!(buyback_floor(0,0),1);assert_eq!(buyback_floor(u64::MAX,500),17_524_406_870_024_074_034);
  assert_eq!(buyback_floor(10_000,10_000),1,"a cap of 100 % keeps one unit");assert_eq!(buyback_floor(10_000,20_000),1);
 }
 #[test]fn terms_hash_is_domain_separated(){
  let a=terms_hash(&[1,2,3]);assert_ne!(a,terms_hash(&[1,2,4]));assert_ne!(a,hashv(&[&[1,2,3]]).to_bytes());assert_eq!(a,hashv(&[b"kids-launch-v2-terms",&[1,2,3]]).to_bytes());
 }
}
