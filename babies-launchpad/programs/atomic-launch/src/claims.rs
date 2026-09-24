//! Fixed-recipient claims paid from launch custody. Parent roots attest a publisher's snapshot; they do
//! not independently prove historical ownership of a parent token. A campaign whose distribution was
//! activated in tag 6 refuses every claim here (error 40): its vaults and terms live in the distribution program.
//! Parent claims (tag 10) close 30 days after the launch; tag 11 then burns the unclaimed rest of both reserves.
use super::*;
use solana_program::{instruction::{AccountMeta,Instruction},pubkey,hash::hashv};
const TOKEN:Pubkey=pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA:Pubkey=pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const NATIVE:Pubkey=pubkey!("So11111111111111111111111111111111111111112");
// KIDSPAR1 (256 bytes): 0 magic, 8 campaign, 40 parent A mint, 72 parent B mint, 104 root A, 136 root B, 168 supply A,
// 176 supply B, 184 snapshot slot, 192 eligible A, 200 eligible B, 208 claimed A, 216 claimed B (tag 10), 224 burned A,
// 232 burned B, 240 burn time (tag 11, zero until the window closed and tag 11 ran). 248..256 unused.
const PARENTS_LEN:usize=256;
const OFF_CLAIMED:usize=208;
const OFF_BURNED:usize=224;
const OFF_BURNED_AT:usize=240;
const CLAIM_LEN:usize=80;
/// Each parent reserve is 5 % of the original supply.
fn parent_reserve(c:&Campaign)->u64{c.supply/10000*500}
fn require(b:bool)->ProgramResult{if b{Ok(())}else{Err(err(30))}}
fn key(d:&[u8],at:usize)->Result<Pubkey,ProgramError>{read_key(d,at)}
fn mint_supply(a:&AccountInfo)->Result<u64,ProgramError>{require(*a.owner==TOKEN)?;let d=a.try_borrow_data()?;require(d.len()==82&&d[45]==1)?;read64(&d,36)}
fn token(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey)->Result<u64,ProgramError>{require(*a.owner==TOKEN)?;let d=a.try_borrow_data()?;require(d.len()==165)?;require(key(&d,0)?==*mint&&key(&d,32)?==*owner&&d[108]==1&&d[72..76]==[0;4]&&d[129..133]==[0;4])?;read64(&d,64)}
fn ata(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey)->ProgramResult{require(*a.key==Pubkey::find_program_address(&[owner.as_ref(),TOKEN.as_ref(),mint.as_ref()],&ATA).0)}
fn proportional(reserve:u64,balance:u64,total:u64)->Result<u64,ProgramError>{require(total>0&&balance<=total)?;Ok((reserve as u128*balance as u128/total as u128) as u64)}
fn threshold(supply:u64)->u64{((supply as u128*5+9999)/10000) as u64}
fn civil_from_days(z:i64)->(i64,i64,i64){let z=z+719468;let era=if z>=0{z}else{z-146096}/146097;let doe=z-era*146097;let yoe=(doe-doe/1460+doe/36524-doe/146096)/365;let mut y=yoe+era*400;let doy=doe-(365*yoe+yoe/4-yoe/100);let mp=(5*doy+2)/153;let d=doy-(153*mp+2)/5+1;let m=mp+if mp<10{3}else{-9};if m<=2{y+=1}(y,m,d)}
fn days_from_civil(mut y:i64,m:i64,d:i64)->i64{if m<=2{y-=1}let era=if y>=0{y}else{y-399}/400;let yoe=y-era*400;let doy=(153*(m+if m>2{-3}else{9})+2)/5+d-1;era*146097+yoe*365+yoe/4-yoe/100+doy-719468}
fn three_month_end(start:i64)->Result<i64,ProgramError>{require(start>=0)?;let(y,m,d)=civil_from_days(start/86400);let months=y*12+(m-1)+3;let year=months/12;let month=months%12+1;let leap=year%4==0&&(year%100!=0||year%400==0);let max=match month{2=>if leap{29}else{28},4|6|9|11=>30,_=>31};days_from_civil(year,month,d.min(max)).checked_mul(86400).and_then(|v|v.checked_add(start%86400)).ok_or(err(10))}
fn dev_entitled(supply:u64,start:i64,now:i64)->Result<u64,ProgramError>{require(start>0&&now>=start)?;let end=three_month_end(start)?;let instant=supply/10000*100;let linear=supply/10000*200;let elapsed=now.min(end)-start;Ok(instant+(linear as u128*elapsed as u128/(end-start) as u128) as u64)}
fn transfer<'a>(program:&Pubkey,c:&Campaign,campaign:&AccountInfo<'a>,authority:&AccountInfo<'a>,mint:&AccountInfo<'a>,source:&AccountInfo<'a>,dest:&AccountInfo<'a>,owner:&Pubkey,token_program:&AccountInfo<'a>,amount:u64)->ProgramResult{
 require(c.phase==3&&*mint.key==c.child_mint&&*token_program.key==TOKEN&&token_program.executable)?;// Holders may burn circulating tokens after launch. Entitlements remain
 // based on the immutable original supply, not the current mint supply.
 require(mint_supply(mint)?<=c.supply)?;{let d=mint.try_borrow_data()?;require(d[44]==6&&d[..4]==[0;4]&&d[46..50]==[0;4])?;}
 let(expected,bump)=Pubkey::find_program_address(&[b"launch_authority",campaign.key.as_ref()],program);require(*authority.key==expected)?;
 ata(source,&c.child_mint,&expected)?;ata(dest,&c.child_mint,owner)?;require(source.key!=dest.key)?;
 require(token(source,&c.child_mint,&expected)?>=amount)?;token(dest,&c.child_mint,owner)?;
 let mut data=vec![3];data.extend_from_slice(&amount.to_le_bytes());
 invoke_signed(&Instruction{program_id:TOKEN,accounts:vec![AccountMeta::new(*source.key,false),AccountMeta::new(*dest.key,false),AccountMeta::new_readonly(expected,true)],data},&[source.clone(),dest.clone(),authority.clone(),token_program.clone()],&[&[b"launch_authority",campaign.key.as_ref(),&[bump]]])
}
pub(super) fn participant(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(body.is_empty()&&a.len()==7)?;let c=Campaign::read(&a[0],program)?;c.refuse_claims_after_activation()?;let mut r=Receipt::read(&a[1],program,a[0].key)?;
 require(c.phase==3&&r.settled)?;if r.claimed{return Ok(())}
 let amount=proportional(c.supply/10000*4350,r.accepted,c.settled_accepted)?;
 transfer(program,&c,&a[0],&a[2],&a[3],&a[4],&a[5],&r.owner,&a[6],amount)?;
 r.claimed=true;r.write(&a[1])
}
pub(super) fn dev(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(body.is_empty()&&a.len()==6)?;let c=Campaign::read(&a[0],program)?;c.refuse_claims_after_activation()?;require(c.phase==3)?;
 let entitled=dev_entitled(c.supply,c.launch_time,Clock::get()?.unix_timestamp)?;let prior={let d=a[0].try_borrow_data()?;read64(&d,304)?};let amount=entitled.checked_sub(prior).ok_or(err(10))?;
 transfer(program,&c,&a[0],&a[1],&a[2],&a[3],&a[4],&c.dev,&a[5],amount)?;
 put64(&mut a[0].try_borrow_mut_data()?,304,entitled);Ok(())
}
pub(super) fn configure(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(a.len()==6&&body.len()==88)?;let c=Campaign::read(&a[1],program)?;let clock=Clock::get()?;
 require(a[1].is_writable&&a[0].is_signer&&*a[0].key==c.creator&&c.phase==0&&c.total==0&&c.receipt_count==0&&clock.unix_timestamp<c.deadline)?;system(&a[5])?;
 require(a[3].key!=a[4].key&&*a[3].key!=c.child_mint&&*a[4].key!=c.child_mint&&*a[3].key!=NATIVE&&*a[4].key!=NATIVE)?;
 let (sa,_)=parent_mint_supply(&a[3])?;let (sb,_)=parent_mint_supply(&a[4])?;let slot=read64(body,64)?;let ea=read64(body,72)?;let eb=read64(body,80)?;
 require(sa>0&&sb>0&&ea>0&&eb>0&&ea<=sa&&eb<=sb&&slot>0&&slot<=clock.slot&&body[..32]!=[0;32]&&body[32..64]!=[0;32])?;
 let(expected,bump)=Pubkey::find_program_address(&[b"parents",a[1].key.as_ref()],program);require(*a[2].key==expected)?;
 create_pda(&a[0],&a[2],&a[5],program,PARENTS_LEN,&[b"parents",a[1].key.as_ref(),&[bump]])?;
 let mut d=a[2].try_borrow_mut_data()?;d.fill(0);d[..8].copy_from_slice(b"KIDSPAR1");d[8..40].copy_from_slice(a[1].key.as_ref());d[40..72].copy_from_slice(a[3].key.as_ref());d[72..104].copy_from_slice(a[4].key.as_ref());d[104..168].copy_from_slice(&body[..64]);
 for(at,value)in[(168,sa),(176,sb),(184,slot),(192,ea),(200,eb)]{put64(&mut d,at,value)}
 a[1].try_borrow_mut_data()?[98]=1;Ok(())
}
pub(super) fn merkle(campaign:&Pubkey,index:u8,owner:&Pubkey,balance:u64,allocation:u64,proof:&[u8])->[u8;32]{let mut hash=hashv(&[b"kids-parent-v1",campaign.as_ref(),&[index],owner.as_ref(),&balance.to_le_bytes(),&allocation.to_le_bytes()]).to_bytes();for sibling in proof.chunks_exact(32){hash=if hash.as_slice()<sibling{hashv(&[&hash,sibling])}else{hashv(&[sibling,&hash])}.to_bytes()}hash}
pub(super) fn parent(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(a.len()==11&&body.len()>=18&&a[0].is_signer)?;let index=body[0];let balance=read64(body,1)?;let allocation=read64(body,9)?;let count=body[17] as usize;
 require(index<2&&count<=32&&body.len()==18+32*count)?;let c=Campaign::read(&a[1],program)?;c.refuse_claims_after_activation()?;require(c.phase==3)?;
 if Clock::get()?.unix_timestamp>=c.parent_claims_expire_at()?{return Err(err(E_PARENT_CLAIM_EXPIRED))}
 system(&a[10])?;
 require(*a[2].owner==*program&&*a[2].key==Pubkey::find_program_address(&[b"parents",a[1].key.as_ref()],program).0)?;
 let reserve=parent_reserve(&c);
 let claimed={let d=a[2].try_borrow_data()?;require(d.len()==PARENTS_LEN&&&d[..8]==b"KIDSPAR1"&&key(&d,8)?==*a[1].key)?;
 let parent_supply=read64(&d,168+8*index as usize)?;let eligible=read64(&d,192+8*index as usize)?;
 require(balance>=threshold(parent_supply)&&allocation==proportional(reserve,balance,eligible)?)?;
 require(merkle(a[1].key,index,a[4].key,balance,allocation,&body[18..])==d[104+32*index as usize..136+32*index as usize])?;
 read64(&d,OFF_CLAIMED+8*index as usize)?};
 let(expected,bump)=Pubkey::find_program_address(&[b"parent_claim",a[1].key.as_ref(),&[index],a[4].key.as_ref()],program);require(*a[3].key==expected)?;
 // A valid replay is harmless, but unrelated existing accounts are rejected.
 if *a[3].owner==*program{let d=a[3].try_borrow_data()?;require(d.len()==CLAIM_LEN&&&d[..8]==b"KIDSPCL1"&&key(&d,8)?==*a[1].key&&key(&d,40)?==*a[4].key&&d[72]==index&&d[73]==bump)?;return Ok(())}
 let claimed=add(claimed,allocation)?;require(claimed<=reserve)?;
 create_pda(&a[0],&a[3],&a[10],program,CLAIM_LEN,&[b"parent_claim",a[1].key.as_ref(),&[index],a[4].key.as_ref(),&[bump]])?;
 transfer(program,&c,&a[1],&a[5],&a[6],&a[7],&a[8],a[4].key,&a[9],allocation)?;
 {let mut d=a[3].try_borrow_mut_data()?;d.fill(0);d[..8].copy_from_slice(b"KIDSPCL1");d[8..40].copy_from_slice(a[1].key.as_ref());d[40..72].copy_from_slice(a[4].key.as_ref());d[72]=index;d[73]=bump;}
 put64(&mut a[2].try_borrow_mut_data()?,OFF_CLAIMED+8*index as usize,claimed);Ok(())
}
/// What tag 11 burns for one parent: the reserve minus what tag 10 paid out and what an earlier tag 11 already burned.
fn unclaimed_remainder(d:&[u8],reserve:u64,index:usize)->Result<u64,ProgramError>{
 let claimed=read64(d,OFF_CLAIMED+8*index)?;let burned=read64(d,OFF_BURNED+8*index)?;
 reserve.checked_sub(claimed).and_then(|n|n.checked_sub(burned)).ok_or(err(10))
}
/// Burns `amount` of the coin from launch custody, signed by the launch authority (Token instruction 8), and reads back
/// that custody lost exactly that amount.
fn burn<'a>(program:&Pubkey,c:&Campaign,campaign:&AccountInfo<'a>,authority:&AccountInfo<'a>,mint:&AccountInfo<'a>,source:&AccountInfo<'a>,token_program:&AccountInfo<'a>,amount:u64)->ProgramResult{
 require(*mint.key==c.child_mint&&*mint.owner==TOKEN&&*token_program.key==TOKEN&&token_program.executable)?;
 let(expected,bump)=Pubkey::find_program_address(&[b"launch_authority",campaign.key.as_ref()],program);require(*authority.key==expected)?;
 ata(source,&c.child_mint,&expected)?;let before=token(source,&c.child_mint,&expected)?;require(before>=amount)?;
 let mut data=vec![8];data.extend_from_slice(&amount.to_le_bytes());
 invoke_signed(&Instruction{program_id:TOKEN,accounts:vec![AccountMeta::new(*source.key,false),AccountMeta::new(*mint.key,false),AccountMeta::new_readonly(expected,true)],data},&[source.clone(),mint.clone(),authority.clone(),token_program.clone()],&[&[b"launch_authority",campaign.key.as_ref(),&[bump]]])?;
 require(token(source,&c.child_mint,&expected)?==before-amount)
}
/// Tag 11: once the parent claim window has closed, burn the unclaimed rest of both parent reserves from launch custody.
/// Accounts: 0 campaign, 1 parents config (writable), 2 launch authority, 3 coin mint (writable), 4 launch custody ATA
/// (writable), 5 Token program. No body, no signer: anyone may run it, and running it again burns nothing more.
/// Participant claims (tag 7), dev claims (tag 8) and refunds are not touched: only reserve minus claimed minus burned goes.
pub(super) fn burn_expired_parent_reserves(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(body.is_empty()&&a.len()==6)?;let c=Campaign::read(&a[0],program)?;c.refuse_claims_after_activation()?;require(c.phase==3)?;
 let now=Clock::get()?.unix_timestamp;if now<c.parent_claims_expire_at()?{return Err(err(E_PARENT_CLAIM_WINDOW_OPEN))}
 require(a[1].is_writable&&*a[1].owner==*program&&*a[1].key==Pubkey::find_program_address(&[b"parents",a[0].key.as_ref()],program).0)?;
 let reserve=parent_reserve(&c);
 let(remainder_a,remainder_b)={let d=a[1].try_borrow_data()?;require(d.len()==PARENTS_LEN&&&d[..8]==b"KIDSPAR1"&&key(&d,8)?==*a[0].key)?;(unclaimed_remainder(&d,reserve,0)?,unclaimed_remainder(&d,reserve,1)?)};
 let total=add(remainder_a,remainder_b)?;
 if total>0{burn(program,&c,&a[0],&a[2],&a[3],&a[4],&a[5],total)?;}
 let mut d=a[1].try_borrow_mut_data()?;
 for(index,remainder)in[(0usize,remainder_a),(1,remainder_b)]{let burned=add(read64(&d,OFF_BURNED+8*index)?,remainder)?;put64(&mut d,OFF_BURNED+8*index,burned);}
 if read64(&d,OFF_BURNED_AT)?==0{put64(&mut d,OFF_BURNED_AT,now as u64);}
 Ok(())
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn three_calendar_months_clamps_end_and_preserves_time(){let jan31=days_from_civil(2024,1,31)*86400+123;assert_eq!(three_month_end(jan31).unwrap(),days_from_civil(2024,4,30)*86400+123);let nov30=days_from_civil(2023,11,30)*86400;assert_eq!(three_month_end(nov30).unwrap(),days_from_civil(2024,2,29)*86400);let nov=days_from_civil(2024,11,30)*86400;assert_eq!(three_month_end(nov).unwrap(),days_from_civil(2025,2,28)*86400);}
 #[test]fn vesting_is_one_percent_then_two_percent_linear_capped(){let s=1_000_000_000_000_000;let start=days_from_civil(2024,1,31)*86400;let end=three_month_end(start).unwrap();assert_eq!(dev_entitled(s,start,start).unwrap(),s/100);assert_eq!(dev_entitled(s,start,start+(end-start)/2).unwrap(),s/50);assert_eq!(dev_entitled(s,start,end+10000).unwrap(),s*3/100);assert!(dev_entitled(s,start,start-1).is_err());}
 #[test]fn eligibility_threshold_rounds_up(){assert_eq!(threshold(1),1);assert_eq!(threshold(10001),6);assert_eq!(threshold(1_000_000_000),500000);assert!(proportional(100,11,10).is_err());assert!(proportional(100,1,0).is_err());assert_eq!(proportional(100,1,3).unwrap(),33);}
 #[test]fn unclaimed_remainder_reads_claimed_at_208_and_burned_at_224_per_parent(){
  let mut d=vec![0u8;PARENTS_LEN];put64(&mut d,208,30);put64(&mut d,216,7);put64(&mut d,224,20);put64(&mut d,232,0);
  assert_eq!(unclaimed_remainder(&d,100,0).unwrap(),50);assert_eq!(unclaimed_remainder(&d,100,1).unwrap(),93);
  put64(&mut d,232,93);assert_eq!(unclaimed_remainder(&d,100,1).unwrap(),0,"a recorded burn leaves nothing to burn again");
  put64(&mut d,224,71);assert!(unclaimed_remainder(&d,100,0).is_err(),"claimed plus burned above the reserve is corrupt");
  assert_eq!((OFF_CLAIMED,OFF_BURNED,OFF_BURNED_AT),(208,224,240));
 }
 #[test]fn merkle_binds_every_claim_identity_field(){let campaign=Pubkey::new_unique();let owner=Pubkey::new_unique();let leaf=merkle(&campaign,0,&owner,5,50,&[]);assert_ne!(leaf,merkle(&campaign,1,&owner,5,50,&[]));assert_ne!(leaf,merkle(&campaign,0,&owner,6,50,&[]));assert_ne!(leaf,merkle(&campaign,0,&owner,5,51,&[]));assert_ne!(leaf,merkle(&Pubkey::new_unique(),0,&owner,5,50,&[]));assert_ne!(leaf,merkle(&campaign,0,&Pubkey::new_unique(),5,50,&[]));let sibling=[42;32];let root=merkle(&campaign,0,&owner,5,50,&sibling);assert_eq!(root,if leaf<sibling{hashv(&[&leaf,&sibling])}else{hashv(&[&sibling,&leaf])}.to_bytes());}
}
