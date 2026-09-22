//! Fixed-term SOL escrow. No admin withdrawal instruction exists.
//! Accepted funds remain locked pending a future audited pool adapter; the
//! immutable launch timeout guarantees full refunds if no launch occurs.
#![allow(unexpected_cfgs, deprecated)]
use solana_program::{account_info::{next_account_info,AccountInfo},clock::Clock,entrypoint,entrypoint::ProgramResult,program::{invoke,invoke_signed},program_error::ProgramError,pubkey::Pubkey,rent::Rent,system_instruction,system_program,sysvar::Sysvar};
#[cfg(not(feature="no-entrypoint"))]
entrypoint!(process_instruction);
const CAMPAIGN_LEN:usize=128;
const RECEIPT_LEN:usize=112;
const CAMPAIGN_MAGIC:&[u8;8]=b"KIDSESC2";
const RECEIPT_MAGIC:&[u8;8]=b"KIDSREC2";
fn err(n:u32)->ProgramError{ProgramError::Custom(n)}
fn read64(d:&[u8],at:usize)->Result<u64,ProgramError>{Ok(u64::from_le_bytes(d.get(at..at+8).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap()))}
fn put64(d:&mut[u8],at:usize,n:u64){d[at..at+8].copy_from_slice(&n.to_le_bytes());}
fn add(a:u64,b:u64)->Result<u64,ProgramError>{a.checked_add(b).ok_or(err(10))}
#[derive(Clone,Copy)]
struct Campaign{creator:Pubkey,nonce:u64,soft:u64,hard:u64,deadline:i64,launch_deadline:i64,total:u64,refunded:u64,phase:u8,bump:u8,receipt_count:u64,settled_count:u64,settled_accepted:u64}
impl Campaign{
 fn read(account:&AccountInfo,program:&Pubkey)->Result<Self,ProgramError>{
  if account.owner!=program{return Err(ProgramError::IncorrectProgramId)}
  let d=account.try_borrow_data()?;
  if d.len()!=CAMPAIGN_LEN||&d[..8]!=CAMPAIGN_MAGIC{return Err(ProgramError::InvalidAccountData)}
  let s=Self{creator:Pubkey::new_from_array(d[8..40].try_into().unwrap()),nonce:read64(&d,40)?,soft:read64(&d,48)?,hard:read64(&d,56)?,deadline:read64(&d,64)? as i64,launch_deadline:read64(&d,72)? as i64,total:read64(&d,80)?,refunded:read64(&d,88)?,phase:d[96],bump:d[97],receipt_count:read64(&d,104)?,settled_count:read64(&d,112)?,settled_accepted:read64(&d,120)?};
  let (expected,bump)=Pubkey::find_program_address(&[b"campaign",s.creator.as_ref(),&s.nonce.to_le_bytes()],program);
  if expected!=*account.key||bump!=s.bump{return Err(ProgramError::InvalidSeeds)}
  Ok(s)
 }
 fn write(&self,a:&AccountInfo)->ProgramResult{let mut d=a.try_borrow_mut_data()?;d[..8].copy_from_slice(CAMPAIGN_MAGIC);d[8..40].copy_from_slice(self.creator.as_ref());for(at,n)in[(40,self.nonce),(48,self.soft),(56,self.hard),(64,self.deadline as u64),(72,self.launch_deadline as u64),(80,self.total),(88,self.refunded)]{put64(&mut d,at,n)}d[96]=self.phase;d[97]=self.bump;put64(&mut d,104,self.receipt_count);put64(&mut d,112,self.settled_count);put64(&mut d,120,self.settled_accepted);Ok(())}
}
#[derive(Clone,Copy)]
struct Receipt{campaign:Pubkey,owner:Pubkey,committed:u64,refunded:u64,sequence:u64,bump:u8,settled:bool,accepted:u64}
impl Receipt{
 fn read(a:&AccountInfo,program:&Pubkey,campaign:&Pubkey)->Result<Self,ProgramError>{
  if a.owner!=program{return Err(ProgramError::IncorrectProgramId)}let d=a.try_borrow_data()?;
  if d.len()!=RECEIPT_LEN||&d[..8]!=RECEIPT_MAGIC{return Err(ProgramError::InvalidAccountData)}
  let s=Self{campaign:Pubkey::new_from_array(d[8..40].try_into().unwrap()),owner:Pubkey::new_from_array(d[40..72].try_into().unwrap()),committed:read64(&d,72)?,refunded:read64(&d,80)?,sequence:read64(&d,88)?,bump:d[96],settled:d[97]!=0,accepted:read64(&d,104)?};
  let(expected,bump)=Pubkey::find_program_address(&[b"commitment",campaign.as_ref(),s.owner.as_ref()],program);
  if s.campaign!=*campaign||expected!=*a.key||bump!=s.bump{return Err(ProgramError::InvalidSeeds)}Ok(s)
 }
 fn write(&self,a:&AccountInfo)->ProgramResult{let mut d=a.try_borrow_mut_data()?;d[..8].copy_from_slice(RECEIPT_MAGIC);d[8..40].copy_from_slice(self.campaign.as_ref());d[40..72].copy_from_slice(self.owner.as_ref());for(at,n)in[(72,self.committed),(80,self.refunded),(88,self.sequence)]{put64(&mut d,at,n)}d[96]=self.bump;d[97]=self.settled as u8;put64(&mut d,104,self.accepted);Ok(())}
}
fn system(a:&AccountInfo)->ProgramResult{if *a.key!=system_program::id(){Err(ProgramError::IncorrectProgramId)}else{Ok(())}}
fn create_pda<'a>(payer:&AccountInfo<'a>,target:&AccountInfo<'a>,system_info:&AccountInfo<'a>,program:&Pubkey,len:usize,seeds:&[&[u8]])->ProgramResult{
 // A third party can pre-fund a PDA. Allocate/assign rather than letting that
 // donation permanently block campaign or commitment creation.
 if target.owner!=&system_program::id()||!target.data_is_empty(){return Err(ProgramError::AccountAlreadyInitialized)}
 let rent=Rent::get()?.minimum_balance(len);let needed=rent.saturating_sub(target.lamports());
 if needed>0{invoke(&system_instruction::transfer(payer.key,target.key,needed),&[payer.clone(),target.clone(),system_info.clone()])?;}
 invoke_signed(&system_instruction::allocate(target.key,len as u64),&[target.clone(),system_info.clone()],&[seeds])?;
 invoke_signed(&system_instruction::assign(target.key,program),&[target.clone(),system_info.clone()],&[seeds])
}
fn refundable(committed:u64,total:u64,hard:u64,failed:bool)->u64{
 if failed{return committed}if total<=hard{return 0}committed-((committed as u128*hard as u128)/total as u128) as u64
}
// Every receipt is registered once at creation and remains allocated forever.
// A settlement pass cannot skip or double-count a registered participant.
fn settle(c:&mut Campaign,r:&mut Receipt,now:i64)->ProgramResult{
 if now<c.deadline{return Err(err(5))}
 if r.settled{return Ok(())}
 let accepted=r.committed-refundable(r.committed,c.total,c.hard,false);
 let count=add(c.settled_count,1)?;let aggregate=add(c.settled_accepted,accepted)?;
 if count>c.receipt_count||aggregate>c.total.min(c.hard){return Err(err(11))}
 c.settled_count=count;c.settled_accepted=aggregate;r.accepted=accepted;r.settled=true;
 Ok(())
}
// Funding readiness ONLY. There is intentionally no instruction that releases
// accepted SOL or marks a launch successful until a real atomic adapter exists.
fn ready(c:&Campaign,now:i64)->bool{
 now>=c.deadline&&now<c.launch_deadline&&c.phase!=2&&c.phase!=3&&c.total>=c.soft
 &&c.receipt_count>0&&c.settled_count==c.receipt_count&&c.settled_accepted>=c.soft
}
pub fn process_instruction(program:&Pubkey,accounts:&[AccountInfo],data:&[u8])->ProgramResult{
 let (&tag,body)=data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
 let iter=&mut accounts.iter();
 match tag{
  0=>{
   if body.len()!=40{return Err(ProgramError::InvalidInstructionData)}
   let creator=next_account_info(iter)?;let campaign=next_account_info(iter)?;let sys=next_account_info(iter)?;system(sys)?;
   if !creator.is_signer{return Err(ProgramError::MissingRequiredSignature)}
   let nonce=read64(body,0)?;let soft=read64(body,8)?;let hard=read64(body,16)?;let deadline=read64(body,24)? as i64;let launch_deadline=read64(body,32)? as i64;
   if soft==0||soft>hard||deadline<=Clock::get()?.unix_timestamp||launch_deadline<=deadline{return Err(err(1))}
   let (expected,bump)=Pubkey::find_program_address(&[b"campaign",creator.key.as_ref(),&nonce.to_le_bytes()],program);if expected!=*campaign.key{return Err(ProgramError::InvalidSeeds)}
   create_pda(creator,campaign,sys,program,CAMPAIGN_LEN,&[b"campaign",creator.key.as_ref(),&nonce.to_le_bytes(),&[bump]])?;
   Campaign{creator:*creator.key,nonce,soft,hard,deadline,launch_deadline,total:0,refunded:0,phase:0,bump,receipt_count:0,settled_count:0,settled_accepted:0}.write(campaign)
  },
  1=>{
   if body.len()!=16{return Err(ProgramError::InvalidInstructionData)}
   let owner=next_account_info(iter)?;let campaign=next_account_info(iter)?;let receipt=next_account_info(iter)?;let sys=next_account_info(iter)?;system(sys)?;
   if !owner.is_signer{return Err(ProgramError::MissingRequiredSignature)}
   let mut c=Campaign::read(campaign,program)?;
   if c.phase!=0||Clock::get()?.unix_timestamp>=c.deadline{return Err(err(2))}
   let amount=read64(body,0)?;let sequence=read64(body,8)?;if amount==0{return Err(err(3))}
   let(expected,bump)=Pubkey::find_program_address(&[b"commitment",campaign.key.as_ref(),owner.key.as_ref()],program);if expected!=*receipt.key{return Err(ProgramError::InvalidSeeds)}
   let mut r=if receipt.owner==&system_program::id()&&receipt.data_is_empty(){
    if sequence!=0{return Err(err(4))}
    create_pda(owner,receipt,sys,program,RECEIPT_LEN,&[b"commitment",campaign.key.as_ref(),owner.key.as_ref(),&[bump]])?;
    c.receipt_count=add(c.receipt_count,1)?;
    Receipt{campaign:*campaign.key,owner:*owner.key,committed:0,refunded:0,sequence:0,bump,settled:false,accepted:0}
   }else{Receipt::read(receipt,program,campaign.key)?};
   if r.owner!=*owner.key||r.sequence!=sequence{return Err(err(4))}
   c.total=add(c.total,amount)?;r.committed=add(r.committed,amount)?;r.sequence=add(r.sequence,1)?;
   invoke(&system_instruction::transfer(owner.key,campaign.key,amount),&[owner.clone(),campaign.clone(),sys.clone()])?;
   c.write(campaign)?;r.write(receipt)
  },
  2=>{
   if !body.is_empty(){return Err(ProgramError::InvalidInstructionData)}let campaign=next_account_info(iter)?;let mut c=Campaign::read(campaign,program)?;
   let now=Clock::get()?.unix_timestamp;if now<c.deadline{return Err(err(5))}
   if c.phase==0{c.phase=if c.total<c.soft{2}else{1};}
   if now>=c.launch_deadline&&c.phase!=3{c.phase=2;}
   c.write(campaign)
  },
  3=>{
   if !body.is_empty(){return Err(ProgramError::InvalidInstructionData)}
   let campaign=next_account_info(iter)?;let receipt=next_account_info(iter)?;let destination=next_account_info(iter)?;
   let mut c=Campaign::read(campaign,program)?;let mut r=Receipt::read(receipt,program,campaign.key)?;
   if r.owner!=*destination.key||destination.key==campaign.key||destination.key==receipt.key{return Err(err(6))}
   let now=Clock::get()?.unix_timestamp;if now<c.deadline{return Err(err(5))}
   let failed=c.total<c.soft||(now>=c.launch_deadline&&c.phase!=3);
   if failed{c.phase=2}else if c.phase==0{c.phase=1}
   let entitled=refundable(r.committed,c.total,c.hard,failed);
   let amount=entitled.checked_sub(r.refunded).ok_or(err(10))?;
   // Idempotent no-op after prior payout. Destination is bound to the receipt,
   // so any keeper can safely pay the refund, never redirect it.
   if amount==0{return Ok(())}
   let remaining=campaign.lamports().checked_sub(amount).ok_or(ProgramError::InsufficientFunds)?;
   if remaining<Rent::get()?.minimum_balance(CAMPAIGN_LEN){return Err(ProgramError::InsufficientFunds)}
   let destination_balance=add(destination.lamports(),amount)?;
   **campaign.try_borrow_mut_lamports()?=remaining;**destination.try_borrow_mut_lamports()?=destination_balance;
   c.refunded=add(c.refunded,amount)?;r.refunded=entitled;c.write(campaign)?;r.write(receipt)
  },
  4=>{
   if !body.is_empty(){return Err(ProgramError::InvalidInstructionData)}
   let campaign=next_account_info(iter)?;let receipt=next_account_info(iter)?;
   let mut c=Campaign::read(campaign,program)?;let mut r=Receipt::read(receipt,program,campaign.key)?;
   settle(&mut c,&mut r,Clock::get()?.unix_timestamp)?;c.write(campaign)?;r.write(receipt)
  },
  5=>{
   if !body.is_empty(){return Err(ProgramError::InvalidInstructionData)}
   let campaign=next_account_info(iter)?;let c=Campaign::read(campaign,program)?;
   if ready(&c,Clock::get()?.unix_timestamp){Ok(())}else{Err(err(12))}
  },
  _=>Err(ProgramError::InvalidInstructionData),
 }
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn rounding_and_full_refund(){assert_eq!(refundable(11,761,500,false),4);assert_eq!(refundable(11,761,500,true),11);assert_eq!(refundable(11,400,500,false),0);}
 #[test]fn no_overflow_at_u64_max(){assert_eq!(refundable(u64::MAX,u64::MAX,u64::MAX-1,false),1);}
 #[test]fn pro_rata_conserves_and_never_over_retains(){for a in 1..20{for b in 1..20{for cap in 1..40{let total=a+b;let ra=refundable(a,total,cap,false);let rb=refundable(b,total,cap,false);assert!(total-ra-rb<=cap.min(total));assert!(ra<=a&&rb<=b);}}}}
}

#[cfg(test)]mod settlement_tests{use super::*;
 fn campaign()->Campaign{Campaign{creator:Pubkey::new_unique(),nonce:1,soft:1,hard:3,deadline:10,launch_deadline:20,total:4,refunded:0,phase:1,bump:0,receipt_count:2,settled_count:0,settled_accepted:0}}
 fn receipt()->Receipt{Receipt{campaign:Pubkey::new_unique(),owner:Pubkey::new_unique(),committed:2,refunded:0,sequence:1,bump:0,settled:false,accepted:0}}
 #[test]fn exact_rounding_idempotence_and_complete_count(){let mut c=campaign();let mut a=receipt();let mut b=receipt();assert!(!ready(&c,10));settle(&mut c,&mut a,10).unwrap();assert_eq!(a.accepted,1);assert!(!ready(&c,10));settle(&mut c,&mut a,10).unwrap();assert_eq!(c.settled_count,1);settle(&mut c,&mut b,10).unwrap();assert_eq!(c.settled_accepted,2);assert_eq!(c.total-c.settled_accepted,2);assert!(ready(&c,10));assert!(!ready(&c,20));}
 #[test]fn premature_settlement_and_unregistered_count_rejected(){let mut c=campaign();let mut r=receipt();assert!(settle(&mut c,&mut r,9).is_err());assert!(!r.settled);c.receipt_count=0;assert!(settle(&mut c,&mut r,10).is_err());assert_eq!(c.settled_count,0);}
 #[test]fn soft_failure_timeout_and_rounding_below_soft_never_ready(){let mut c=campaign();c.soft=3;let mut a=receipt();let mut b=receipt();settle(&mut c,&mut a,10).unwrap();settle(&mut c,&mut b,10).unwrap();assert!(!ready(&c,10));c.soft=1;c.phase=2;assert!(!ready(&c,10));assert_eq!(refundable(a.committed,c.total,c.hard,true),2);}
}
