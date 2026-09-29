//! Pure arithmetic shared by every instruction: allocation table, parent window, vesting, Merkle leaves.
use super::*;
use solana_program::hash::hashv;
/// Basis points of the original supply per purpose: participants 43.5 %, parent A 5 %, parent B 5 %, dev 3 %.
pub const ALLOCATION_BPS:[u64;4]=[4350,500,500,300];
/// Liquidity (43.5 %) is not a vault; listed so conservation can be checked against the original supply.
pub const LIQUIDITY_BPS:u64=4350;
pub const DEV_INSTANT_BPS:u64=100;
pub const DEV_LINEAR_BPS:u64=200;
/// Dust policy: every share is `supply / 10000 * bps`, the same integer rule the launch program uses, so the
/// remainder `supply % 10000` (below 0.01 token at six decimals) stays in the launch custody and is never owed
/// to anyone. For the fixed one-billion supply the remainder is zero.
pub fn share(supply:u64,bps:u64)->u64{supply/10000*bps}
pub fn allocations(supply:u64)->[u64;4]{[share(supply,ALLOCATION_BPS[0]),share(supply,ALLOCATION_BPS[1]),share(supply,ALLOCATION_BPS[2]),share(supply,ALLOCATION_BPS[3])]}
pub fn dust(supply:u64)->u64{supply%10000}
pub fn parent_expiry(launch_time:i64)->Result<i64,ProgramError>{launch_time.checked_add(PARENT_EXPIRY_SECONDS).ok_or(err(E_OVERFLOW))}
/// Parent claims are open in `[launch_time, expiry)`.
pub fn parent_claim_window(now:i64,launch_time:i64,expiry:i64)->ProgramResult{
 require(now>=launch_time,E_NOT_YET_CLAIMABLE)?;require(now<expiry,E_EXPIRED)
}
/// Parent burns are open from `expiry` on, once per parent.
pub fn burn_decision(now:i64,expiry:i64,already_burned:bool)->ProgramResult{
 require(now>=expiry,E_NOT_EXPIRED)?;require(!already_burned,E_ALREADY_BURNED)
}
/// 0.05 % of the parent snapshot supply, rounded up.
pub fn threshold(supply:u64)->u64{((supply as u128*5+9999)/10000) as u64}
pub fn proportional(reserve:u64,balance:u64,total:u64)->Result<u64,ProgramError>{require(total>0&&balance<=total,E_ALLOCATION_MISMATCH)?;Ok((reserve as u128*balance as u128/total as u128) as u64)}
pub fn civil_from_days(z:i64)->(i64,i64,i64){let z=z+719468;let era=if z>=0{z}else{z-146096}/146097;let doe=z-era*146097;let yoe=(doe-doe/1460+doe/36524-doe/146096)/365;let mut y=yoe+era*400;let doy=doe-(365*yoe+yoe/4-yoe/100);let mp=(5*doy+2)/153;let d=doy-(153*mp+2)/5+1;let m=mp+if mp<10{3}else{-9};if m<=2{y+=1}(y,m,d)}
pub fn days_from_civil(mut y:i64,m:i64,d:i64)->i64{if m<=2{y-=1}let era=if y>=0{y}else{y-399}/400;let yoe=y-era*400;let doy=(153*(m+if m>2{-3}else{9})+2)/5+d-1;era*146097+yoe*365+yoe/4-yoe/100+doy-719468}
/// Same calendar day and time of day three months later, clamped to the last day of that month.
pub fn three_month_end(start:i64)->Result<i64,ProgramError>{require(start>=0,E_OVERFLOW)?;let(y,m,d)=civil_from_days(start/86400);let months=y*12+(m-1)+3;let year=months/12;let month=months%12+1;let leap=year%4==0&&(year%100!=0||year%400==0);let max=match month{2=>if leap{29}else{28},4|6|9|11=>30,_=>31};days_from_civil(year,month,d.min(max)).checked_mul(86400).and_then(|v|v.checked_add(start%86400)).ok_or(err(E_OVERFLOW))}
/// Dev entitlement at `now`: 1 % at once, plus 2 % linear from `start` to `end`, capped at 3 %.
pub fn dev_entitled(supply:u64,start:i64,end:i64,now:i64)->Result<u64,ProgramError>{
 require(start>0&&end>start,E_OVERFLOW)?;require(now>=start,E_NOT_YET_CLAIMABLE)?;
 let instant=share(supply,DEV_INSTANT_BPS);let linear=share(supply,DEV_LINEAR_BPS);let elapsed=now.min(end)-start;
 Ok(instant+(linear as u128*elapsed as u128/(end-start) as u128) as u64)
}
pub fn merkle_leaf(campaign:&Pubkey,index:u8,owner:&Pubkey,balance:u64,allocation:u64)->[u8;32]{hashv(&[b"kids-parent-v1",campaign.as_ref(),&[index],owner.as_ref(),&balance.to_le_bytes(),&allocation.to_le_bytes()]).to_bytes()}
pub fn merkle_pair(a:&[u8;32],b:&[u8;32])->[u8;32]{if a.as_slice()<b.as_slice(){hashv(&[a,b])}else{hashv(&[b,a])}.to_bytes()}
/// Root implied by a leaf and its sibling path (sorted-pair hashing, as the launch program's parent claim).
pub fn merkle(campaign:&Pubkey,index:u8,owner:&Pubkey,balance:u64,allocation:u64,proof:&[u8])->[u8;32]{let mut hash=merkle_leaf(campaign,index,owner,balance,allocation);for sibling in proof.chunks_exact(32){hash=merkle_pair(&hash,sibling.try_into().unwrap());}hash}
#[cfg(test)]mod tests{use super::*;
 #[test]fn allocations_conserve_the_original_supply_up_to_documented_dust(){
  for supply in [1_000_000_000_000_000u64,10_000,10_001,19_999,123_456_789,7,0,u64::MAX]{
   let a=allocations(supply);let liquidity=share(supply,LIQUIDITY_BPS);
   let total=a.iter().fold(liquidity,|acc,n|acc+n);
   assert_eq!(total+dust(supply),supply,"supply {supply}");assert!(dust(supply)<10000);
   assert_eq!(a[1],a[2]);assert_eq!(a[3],share(supply,DEV_INSTANT_BPS)+share(supply,DEV_LINEAR_BPS));
  }
  let a=allocations(1_000_000_000_000_000);
  assert_eq!(a,[435_000_000_000_000,50_000_000_000_000,50_000_000_000_000,30_000_000_000_000]);assert_eq!(dust(1_000_000_000_000_000),0);
 }
 #[test]fn threshold_rounds_up_and_proportional_bounds_inputs(){
  assert_eq!(threshold(1),1);assert_eq!(threshold(10001),6);assert_eq!(threshold(1_000_000_000),500000);assert_eq!(threshold(0),0);
  assert!(proportional(100,11,10).is_err());assert!(proportional(100,1,0).is_err());assert_eq!(proportional(100,1,3).unwrap(),33);
  assert_eq!(proportional(u64::MAX,u64::MAX,u64::MAX).unwrap(),u64::MAX);
  let reserve=50_000_000_000_000u64;let eligible=1_000_000u64;let parts=[1u64,999_999];
  let paid:u64=parts.iter().map(|b|proportional(reserve,*b,eligible).unwrap()).sum();assert!(paid<=reserve);
 }
 #[test]fn three_calendar_months_clamps_end_and_preserves_time_of_day(){
  let jan31=days_from_civil(2024,1,31)*86400+123;assert_eq!(three_month_end(jan31).unwrap(),days_from_civil(2024,4,30)*86400+123);
  let nov30=days_from_civil(2023,11,30)*86400;assert_eq!(three_month_end(nov30).unwrap(),days_from_civil(2024,2,29)*86400);
  let nov=days_from_civil(2024,11,30)*86400;assert_eq!(three_month_end(nov).unwrap(),days_from_civil(2025,2,28)*86400);
  let mid=days_from_civil(2026,9,23)*86400+50_000;assert_eq!(three_month_end(mid).unwrap(),days_from_civil(2026,12,23)*86400+50_000);
  assert!(three_month_end(-1).is_err());
  for day in 0..(366*4){let start=day*86400+3600;let (y,m,d)=civil_from_days(start/86400);assert_eq!(days_from_civil(y,m,d),start/86400);}
 }
 #[test]fn vesting_is_one_percent_then_two_percent_linear_capped(){
  let s=1_000_000_000_000_000u64;let start=days_from_civil(2024,1,31)*86400;let end=three_month_end(start).unwrap();
  assert_eq!(dev_entitled(s,start,end,start).unwrap(),s/100,"start: instant 1 %");
  assert_eq!(dev_entitled(s,start,end,start+(end-start)/2).unwrap(),s/50,"mid: 2 %");
  assert_eq!(dev_entitled(s,start,end,end).unwrap(),s*3/100,"end: 3 %");
  assert_eq!(dev_entitled(s,start,end,end+10_000).unwrap(),s*3/100,"after: still 3 %");
  assert_eq!(dev_entitled(s,start,end,start-1).unwrap_err(),err(E_NOT_YET_CLAIMABLE));
  assert!(dev_entitled(s,0,end,start).is_err());assert!(dev_entitled(s,start,start,start).is_err());
  let mut last=0;for step in 0..=100{let now=start+(end-start)*step/100;let e=dev_entitled(s,start,end,now).unwrap();assert!(e>=last);last=e;}
 }
 #[test]fn parent_window_and_burn_decisions_at_every_boundary(){
  let launch=1_700_000_000i64;let expiry=parent_expiry(launch).unwrap();assert_eq!(expiry,launch+2_592_000);
  assert_eq!(parent_claim_window(launch-1,launch,expiry).unwrap_err(),err(E_NOT_YET_CLAIMABLE));
  assert!(parent_claim_window(launch,launch,expiry).is_ok());
  assert!(parent_claim_window(expiry-1,launch,expiry).is_ok());
  assert_eq!(parent_claim_window(expiry,launch,expiry).unwrap_err(),err(E_EXPIRED));
  assert_eq!(parent_claim_window(expiry+1,launch,expiry).unwrap_err(),err(E_EXPIRED));
  assert_eq!(burn_decision(expiry-1,expiry,false).unwrap_err(),err(E_NOT_EXPIRED));
  assert!(burn_decision(expiry,expiry,false).is_ok());assert!(burn_decision(expiry+1,expiry,false).is_ok());
  assert_eq!(burn_decision(expiry,expiry,true).unwrap_err(),err(E_ALREADY_BURNED));
  assert_eq!(burn_decision(expiry-1,expiry,true).unwrap_err(),err(E_NOT_EXPIRED),"before expiry the burn is refused even if flagged");
  assert!(parent_expiry(i64::MAX).is_err());
 }
 fn tree(campaign:&Pubkey,index:u8,leaves:&[(Pubkey,u64,u64)])->([u8;32],Vec<Vec<u8>>){
  let mut level:Vec<[u8;32]>=leaves.iter().map(|(o,b,a)|merkle_leaf(campaign,index,o,*b,*a)).collect();
  let mut proofs:Vec<Vec<u8>>=vec![vec![];leaves.len()];let mut positions:Vec<usize>=(0..leaves.len()).collect();
  while level.len()>1{
   let mut next=vec![];
   for pair in 0..(level.len()+1)/2{
    let left=level[2*pair];let right=if 2*pair+1<level.len(){level[2*pair+1]}else{left};
    next.push(merkle_pair(&left,&right));
   }
   for (leaf,position) in positions.iter_mut().enumerate(){
    let sibling=if *position%2==0{if *position+1<level.len(){level[*position+1]}else{level[*position]}}else{level[*position-1]};
    proofs[leaf].extend_from_slice(&sibling);*position/=2;
   }
   level=next;
  }
  (level[0],proofs)
 }
 #[test]fn merkle_proofs_verify_for_every_leaf_of_a_small_tree_and_nothing_else(){
  let campaign=Pubkey::new_unique();
  let leaves:Vec<(Pubkey,u64,u64)>=(1..=5u64).map(|i|(Pubkey::new_unique(),i*1000,i*10)).collect();
  let (root,proofs)=tree(&campaign,0,&leaves);
  for (i,(owner,balance,allocation)) in leaves.iter().enumerate(){
   assert_eq!(merkle(&campaign,0,owner,*balance,*allocation,&proofs[i]),root,"leaf {i}");
   assert_ne!(merkle(&campaign,1,owner,*balance,*allocation,&proofs[i]),root,"other parent index");
   assert_ne!(merkle(&Pubkey::new_unique(),0,owner,*balance,*allocation,&proofs[i]),root,"other campaign");
   assert_ne!(merkle(&campaign,0,owner,*balance+1,*allocation,&proofs[i]),root,"other balance");
   assert_ne!(merkle(&campaign,0,owner,*balance,*allocation+1,&proofs[i]),root,"other allocation");
   assert_ne!(merkle(&campaign,0,&Pubkey::new_unique(),*balance,*allocation,&proofs[i]),root,"other owner");
   assert_ne!(merkle(&campaign,0,owner,*balance,*allocation,&proofs[(i+1)%leaves.len()]),root,"another leaf's proof");
   assert_ne!(merkle(&campaign,0,owner,*balance,*allocation,&[]),root,"empty proof");
  }
  let single=tree(&campaign,0,&leaves[..1]);assert_eq!(single.0,merkle_leaf(&campaign,0,&leaves[0].0,leaves[0].1,leaves[0].2));
  let leaf=merkle_leaf(&campaign,0,&leaves[0].0,5,50);let sibling=[42u8;32];
  assert_eq!(merkle(&campaign,0,&leaves[0].0,5,50,&sibling),if leaf<sibling{hashv(&[&leaf,&sibling])}else{hashv(&[&sibling,&leaf])}.to_bytes());
 }
}
