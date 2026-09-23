//! Fixed-term SOL escrow with atomic canonical CPMM creation and LP lock.
//! No administrative withdrawal exists. Unlaunched campaigns time out to refunds.
#![allow(unexpected_cfgs, deprecated)]
use solana_program::{account_info::{next_account_info,AccountInfo},clock::Clock,entrypoint,entrypoint::ProgramResult,program::{invoke,invoke_signed},program_error::ProgramError,pubkey::Pubkey,rent::Rent,system_instruction,system_program,sysvar::Sysvar};
#[cfg(not(feature="no-entrypoint"))]
entrypoint!(process_instruction);
mod launch;
mod claims;
mod fees;
const FIXED_SUPPLY:u64=1_000_000_000_000_000;
const CAMPAIGN_LEN:usize=384;
const RECEIPT_LEN:usize=112;
const CAMPAIGN_MAGIC:&[u8;8]=b"KIDSESC3";
const RECEIPT_MAGIC:&[u8;8]=b"KIDSREC3";
fn err(n:u32)->ProgramError{ProgramError::Custom(n)}
fn read64(d:&[u8],at:usize)->Result<u64,ProgramError>{Ok(u64::from_le_bytes(d.get(at..at+8).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap()))}
fn read_key(d:&[u8],at:usize)->Result<Pubkey,ProgramError>{Ok(Pubkey::new_from_array(d.get(at..at+32).ok_or(ProgramError::InvalidAccountData)?.try_into().unwrap()))}
fn put64(d:&mut[u8],at:usize,n:u64){d[at..at+8].copy_from_slice(&n.to_le_bytes());}
fn add(a:u64,b:u64)->Result<u64,ProgramError>{a.checked_add(b).ok_or(err(10))}
// Parent mints may live under the classic token program or Token-2022 (Buttcoin is Token-2022 with embedded
// metadata). Child custody stays classic. A Token-2022 parent may carry ONLY these mint extensions; anything
// that changes what a balance is worth or whether it can move (transfer fee, hook, permanent delegate,
// confidential, non-transferable, default frozen, pausable) is refused on chain.
const TOKEN_PROGRAM:Pubkey=solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM:Pubkey=solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ALLOWED_PARENT_MINT_EXTENSIONS:[u16;3]=[3,18,19]; // MintCloseAuthority, MetadataPointer, TokenMetadata
fn is_token_program(k:&Pubkey)->bool{*k==TOKEN_PROGRAM||*k==TOKEN_2022_PROGRAM}
/// Supply of a classic or Token-2022 parent mint plus its token program. Classic: exactly 82 bytes.
/// Token-2022: 82 bytes, or the extended layout (166+ bytes, type byte 1 at 165) with an allowed TLV only.
fn parent_mint_supply(a:&AccountInfo)->Result<(u64,Pubkey),ProgramError>{
 if !is_token_program(a.owner){return Err(err(70))}
 let d=a.try_borrow_data()?;
 if d.len()<82||d[45]!=1{return Err(err(70))}
 if d.len()>82{
  if *a.owner!=TOKEN_2022_PROGRAM||d.len()<166||d[165]!=1{return Err(err(70))}
  let mut at=166;
  while at+4<=d.len(){
   let kind=u16::from_le_bytes([d[at],d[at+1]]);let len=u16::from_le_bytes([d[at+2],d[at+3]]) as usize;
   if kind==0{break}
   if !ALLOWED_PARENT_MINT_EXTENSIONS.contains(&kind){return Err(err(71))}
   at=at.checked_add(4+len).ok_or(err(70))?;
  }
  if at>d.len(){return Err(err(70))}
 }else if *a.owner==TOKEN_2022_PROGRAM&&d.len()!=82{return Err(err(70))}
 Ok((read64(&d,36)?,*a.owner))
}
/// Balance of a classic or Token-2022 token account holding `mint` for `owner`, initialized, not frozen,
/// with no delegate and no close authority. Token-2022 accounts carry type byte 2 at 165 and a TLV after it.
fn parent_token(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey,token_program:&Pubkey)->Result<u64,ProgramError>{
 if a.owner!=token_program||!is_token_program(token_program){return Err(err(72))}
 let d=a.try_borrow_data()?;
 if d.len()<165{return Err(err(72))}
 if d.len()>165&&(*token_program!=TOKEN_2022_PROGRAM||d[165]!=2){return Err(err(72))}
 if read_key(&d,0)?!=*mint||read_key(&d,32)?!=*owner||d[108]!=1||d[72..76]!=[0;4]||d[129..133]!=[0;4]{return Err(err(72))}
 read64(&d,64)
}
fn parent_ata(a:&AccountInfo,owner:&Pubkey,mint:&Pubkey,token_program:&Pubkey)->ProgramResult{
 let ata=solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
 if *a.key==Pubkey::find_program_address(&[owner.as_ref(),token_program.as_ref(),mint.as_ref()],&ata).0{Ok(())}else{Err(err(72))}
}
#[cfg(test)]mod parent_token_tests{use super::*;use solana_program::account_info::AccountInfo;
 fn mint_data(supply:u64,len:usize,tlv:&[(u16,usize)])->Vec<u8>{let mut d=vec![0u8;len.max(82)];d[36..44].copy_from_slice(&supply.to_le_bytes());d[45]=1;if len>82{d[165]=1;let mut at=166;for (k,l) in tlv{d.extend_from_slice(&[0;0]);if at+4+l>d.len(){d.resize(at+4+l,0);}d[at..at+2].copy_from_slice(&k.to_le_bytes());d[at+2..at+4].copy_from_slice(&(*l as u16).to_le_bytes());at+=4+l;}}d}
 fn info<'a>(key:&'a Pubkey,owner:&'a Pubkey,data:&'a mut Vec<u8>,lamports:&'a mut u64)->AccountInfo<'a>{AccountInfo::new(key,false,false,lamports,data,owner,false,0)}
 #[test]fn classic_and_token_2022_parent_mints_are_read_and_bad_extensions_refused(){
  let key=Pubkey::new_unique();let mut l=1u64;
  let mut classic=mint_data(7,82,&[]);assert_eq!(parent_mint_supply(&info(&key,&TOKEN_PROGRAM,&mut classic,&mut l)).unwrap(),(7,TOKEN_PROGRAM));
  let mut meta=mint_data(9,166,&[(18,64),(19,120)]);assert_eq!(parent_mint_supply(&info(&key,&TOKEN_2022_PROGRAM,&mut meta,&mut l)).unwrap(),(9,TOKEN_2022_PROGRAM));
  let mut fee=mint_data(9,166,&[(1,108)]);assert_eq!(parent_mint_supply(&info(&key,&TOKEN_2022_PROGRAM,&mut fee,&mut l)).unwrap_err(),err(71));
  let mut hook=mint_data(9,166,&[(18,64),(14,64)]);assert_eq!(parent_mint_supply(&info(&key,&TOKEN_2022_PROGRAM,&mut hook,&mut l)).unwrap_err(),err(71));
  let mut long_classic=mint_data(9,166,&[]);assert_eq!(parent_mint_supply(&info(&key,&TOKEN_PROGRAM,&mut long_classic,&mut l)).unwrap_err(),err(70));
  let other=Pubkey::new_unique();assert_eq!(parent_mint_supply(&info(&key,&other,&mut classic,&mut l)).unwrap_err(),err(70));
 }
 #[test]fn parent_token_accounts_bind_program_layout_mint_owner_and_authorities(){
  let key=Pubkey::new_unique();let mint=Pubkey::new_unique();let owner=Pubkey::new_unique();let mut l=1u64;
  let mut base=vec![0u8;165];base[..32].copy_from_slice(mint.as_ref());base[32..64].copy_from_slice(owner.as_ref());base[64..72].copy_from_slice(&5u64.to_le_bytes());base[108]=1;
  assert_eq!(parent_token(&info(&key,&TOKEN_PROGRAM,&mut base.clone(),&mut l),&mint,&owner,&TOKEN_PROGRAM).unwrap(),5);
  let mut ext=base.clone();ext.push(2);ext.extend_from_slice(&[7,0,0,0]);assert_eq!(parent_token(&info(&key,&TOKEN_2022_PROGRAM,&mut ext.clone(),&mut l),&mint,&owner,&TOKEN_2022_PROGRAM).unwrap(),5);
  assert!(parent_token(&info(&key,&TOKEN_PROGRAM,&mut ext.clone(),&mut l),&mint,&owner,&TOKEN_PROGRAM).is_err(),"classic program with an extended layout");
  assert!(parent_token(&info(&key,&TOKEN_2022_PROGRAM,&mut base.clone(),&mut l),&mint,&owner,&TOKEN_PROGRAM).is_err(),"program mismatch");
  let mut frozen=base.clone();frozen[108]=2;assert!(parent_token(&info(&key,&TOKEN_PROGRAM,&mut frozen,&mut l),&mint,&owner,&TOKEN_PROGRAM).is_err());
  let mut delegated=base.clone();delegated[72]=1;assert!(parent_token(&info(&key,&TOKEN_PROGRAM,&mut delegated,&mut l),&mint,&owner,&TOKEN_PROGRAM).is_err());
 }
}
#[derive(Clone,Copy)]
struct Campaign{creator:Pubkey,nonce:u64,soft:u64,hard:u64,deadline:i64,launch_deadline:i64,total:u64,refunded:u64,phase:u8,bump:u8,receipt_count:u64,settled_count:u64,settled_accepted:u64,child_mint:Pubkey,supply:u64,dev:Pubkey,treasury:Pubkey,launch_time:i64,pool:Pubkey,fee_nft:Pubkey}
impl Campaign{
 fn read(account:&AccountInfo,program:&Pubkey)->Result<Self,ProgramError>{
  if account.owner!=program{return Err(ProgramError::IncorrectProgramId)}
  let d=account.try_borrow_data()?;
  if d.len()!=CAMPAIGN_LEN||&d[..8]!=CAMPAIGN_MAGIC{return Err(ProgramError::InvalidAccountData)}
  let s=Self{creator:Pubkey::new_from_array(d[8..40].try_into().unwrap()),nonce:read64(&d,40)?,soft:read64(&d,48)?,hard:read64(&d,56)?,deadline:read64(&d,64)? as i64,launch_deadline:read64(&d,72)? as i64,total:read64(&d,80)?,refunded:read64(&d,88)?,phase:d[96],bump:d[97],receipt_count:read64(&d,104)?,settled_count:read64(&d,112)?,settled_accepted:read64(&d,120)?,child_mint:read_key(&d,128)?,supply:read64(&d,160)?,dev:read_key(&d,168)?,treasury:read_key(&d,200)?,launch_time:read64(&d,232)? as i64,pool:read_key(&d,240)?,fee_nft:read_key(&d,272)?};
  let (expected,bump)=Pubkey::find_program_address(&[b"campaign",s.creator.as_ref(),&s.nonce.to_le_bytes()],program);
  if expected!=*account.key||bump!=s.bump{return Err(ProgramError::InvalidSeeds)}
  Ok(s)
 }
 fn write(&self,a:&AccountInfo)->ProgramResult{let mut d=a.try_borrow_mut_data()?;d[..8].copy_from_slice(CAMPAIGN_MAGIC);d[8..40].copy_from_slice(self.creator.as_ref());for(at,n)in[(40,self.nonce),(48,self.soft),(56,self.hard),(64,self.deadline as u64),(72,self.launch_deadline as u64),(80,self.total),(88,self.refunded)]{put64(&mut d,at,n)}d[96]=self.phase;d[97]=self.bump;put64(&mut d,104,self.receipt_count);put64(&mut d,112,self.settled_count);put64(&mut d,120,self.settled_accepted);put64(&mut d,160,self.supply);put64(&mut d,232,self.launch_time as u64);for(at,key)in[(128,self.child_mint),(168,self.dev),(200,self.treasury),(240,self.pool),(272,self.fee_nft)]{d[at..at+32].copy_from_slice(key.as_ref());}Ok(())}
}
#[derive(Clone,Copy)]
struct Receipt{campaign:Pubkey,owner:Pubkey,committed:u64,refunded:u64,sequence:u64,bump:u8,settled:bool,accepted:u64,claimed:bool}
impl Receipt{
 fn read(a:&AccountInfo,program:&Pubkey,campaign:&Pubkey)->Result<Self,ProgramError>{
  if a.owner!=program{return Err(ProgramError::IncorrectProgramId)}let d=a.try_borrow_data()?;
  if d.len()!=RECEIPT_LEN||&d[..8]!=RECEIPT_MAGIC{return Err(ProgramError::InvalidAccountData)}
  let s=Self{campaign:Pubkey::new_from_array(d[8..40].try_into().unwrap()),owner:Pubkey::new_from_array(d[40..72].try_into().unwrap()),committed:read64(&d,72)?,refunded:read64(&d,80)?,sequence:read64(&d,88)?,bump:d[96],settled:d[97]!=0,accepted:read64(&d,104)?,claimed:d[98]!=0};
  let(expected,bump)=Pubkey::find_program_address(&[b"commitment",campaign.as_ref(),s.owner.as_ref()],program);
  if s.campaign!=*campaign||expected!=*a.key||bump!=s.bump{return Err(ProgramError::InvalidSeeds)}Ok(s)
 }
 fn write(&self,a:&AccountInfo)->ProgramResult{let mut d=a.try_borrow_mut_data()?;d[..8].copy_from_slice(RECEIPT_MAGIC);d[8..40].copy_from_slice(self.campaign.as_ref());d[40..72].copy_from_slice(self.owner.as_ref());for(at,n)in[(72,self.committed),(80,self.refunded),(88,self.sequence)]{put64(&mut d,at,n)}d[96]=self.bump;d[97]=self.settled as u8;d[98]=self.claimed as u8;put64(&mut d,104,self.accepted);Ok(())}
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
// Launch readiness; the atomic adapter must preserve outstanding refund liability.
fn ready(c:&Campaign,now:i64)->bool{
 now>=c.deadline&&now<c.launch_deadline&&c.phase!=2&&c.phase!=3&&c.total>=c.soft
 &&c.receipt_count>0&&c.settled_count==c.receipt_count&&c.settled_accepted>=c.soft
}
pub fn process_instruction(program:&Pubkey,accounts:&[AccountInfo],data:&[u8])->ProgramResult{
 let (&tag,body)=data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
 let iter=&mut accounts.iter();
 match tag{
  0=>{
   if body.len()!=144{return Err(ProgramError::InvalidInstructionData)}
   let creator=next_account_info(iter)?;let campaign=next_account_info(iter)?;let sys=next_account_info(iter)?;system(sys)?;
   if !creator.is_signer{return Err(ProgramError::MissingRequiredSignature)}
   let nonce=read64(body,0)?;let soft=read64(body,8)?;let hard=read64(body,16)?;let deadline=read64(body,24)? as i64;let launch_deadline=read64(body,32)? as i64;
   let child_mint=read_key(body,40)?;let supply=read64(body,72)?;let dev=read_key(body,80)?;let treasury=read_key(body,112)?;
   if supply!=FIXED_SUPPLY||child_mint==Pubkey::default()||dev==Pubkey::default()||treasury==Pubkey::default(){return Err(err(20))}
   if soft==0||soft>hard||deadline<=Clock::get()?.unix_timestamp||launch_deadline<=deadline{return Err(err(1))}
   let (expected,bump)=Pubkey::find_program_address(&[b"campaign",creator.key.as_ref(),&nonce.to_le_bytes()],program);if expected!=*campaign.key{return Err(ProgramError::InvalidSeeds)}
   create_pda(creator,campaign,sys,program,CAMPAIGN_LEN,&[b"campaign",creator.key.as_ref(),&nonce.to_le_bytes(),&[bump]])?;
   Campaign{creator:*creator.key,nonce,soft,hard,deadline,launch_deadline,total:0,refunded:0,phase:0,bump,receipt_count:0,settled_count:0,settled_accepted:0,child_mint,supply,dev,treasury,launch_time:0,pool:Pubkey::default(),fee_nft:Pubkey::default()}.write(campaign)
  },
  1=>{
   if body.len()!=16{return Err(ProgramError::InvalidInstructionData)}
   let owner=next_account_info(iter)?;let campaign=next_account_info(iter)?;let receipt=next_account_info(iter)?;let sys=next_account_info(iter)?;system(sys)?;
   if !owner.is_signer{return Err(ProgramError::MissingRequiredSignature)}
   let mut c=Campaign::read(campaign,program)?;
   if c.phase!=0||Clock::get()?.unix_timestamp>=c.deadline{return Err(err(2))}
   if campaign.try_borrow_data()?[98]!=1{return Err(err(22))}
   let amount=read64(body,0)?;let sequence=read64(body,8)?;if amount==0{return Err(err(3))}
   let(expected,bump)=Pubkey::find_program_address(&[b"commitment",campaign.key.as_ref(),owner.key.as_ref()],program);if expected!=*receipt.key{return Err(ProgramError::InvalidSeeds)}
   let mut r=if receipt.owner==&system_program::id()&&receipt.data_is_empty(){
    if sequence!=0{return Err(err(4))}
    create_pda(owner,receipt,sys,program,RECEIPT_LEN,&[b"commitment",campaign.key.as_ref(),owner.key.as_ref(),&[bump]])?;
    c.receipt_count=add(c.receipt_count,1)?;
    Receipt{campaign:*campaign.key,owner:*owner.key,committed:0,refunded:0,sequence:0,bump,settled:false,accepted:0,claimed:false}
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
  6=>launch::execute(program,accounts,body),
  7=>claims::participant(program,accounts,body),
  8=>claims::dev(program,accounts,body),
  9=>claims::configure(program,accounts,body),
  10=>claims::parent(program,accounts,body),
  20..=26=>fees::process(program,accounts,body,tag),
  _=>Err(ProgramError::InvalidInstructionData),
 }
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn rounding_and_full_refund(){assert_eq!(refundable(11,761,500,false),4);assert_eq!(refundable(11,761,500,true),11);assert_eq!(refundable(11,400,500,false),0);}
 #[test]fn no_overflow_at_u64_max(){assert_eq!(refundable(u64::MAX,u64::MAX,u64::MAX-1,false),1);}
 #[test]fn pro_rata_conserves_and_never_over_retains(){for a in 1..20{for b in 1..20{for cap in 1..40{let total=a+b;let ra=refundable(a,total,cap,false);let rb=refundable(b,total,cap,false);assert!(total-ra-rb<=cap.min(total));assert!(ra<=a&&rb<=b);}}}}
}

#[cfg(test)]mod settlement_tests{use super::*;
 fn campaign()->Campaign{Campaign{creator:Pubkey::new_unique(),nonce:1,soft:1,hard:3,deadline:10,launch_deadline:20,total:4,refunded:0,phase:1,bump:0,receipt_count:2,settled_count:0,settled_accepted:0,child_mint:Pubkey::new_unique(),supply:10000,dev:Pubkey::new_unique(),treasury:Pubkey::new_unique(),launch_time:0,pool:Pubkey::default(),fee_nft:Pubkey::default()}}
 fn receipt()->Receipt{Receipt{campaign:Pubkey::new_unique(),owner:Pubkey::new_unique(),committed:2,refunded:0,sequence:1,bump:0,settled:false,accepted:0,claimed:false}}
 #[test]fn exact_rounding_idempotence_and_complete_count(){let mut c=campaign();let mut a=receipt();let mut b=receipt();assert!(!ready(&c,10));settle(&mut c,&mut a,10).unwrap();assert_eq!(a.accepted,1);assert!(!ready(&c,10));settle(&mut c,&mut a,10).unwrap();assert_eq!(c.settled_count,1);settle(&mut c,&mut b,10).unwrap();assert_eq!(c.settled_accepted,2);assert_eq!(c.total-c.settled_accepted,2);assert!(ready(&c,10));assert!(!ready(&c,20));}
 #[test]fn premature_settlement_and_unregistered_count_rejected(){let mut c=campaign();let mut r=receipt();assert!(settle(&mut c,&mut r,9).is_err());assert!(!r.settled);c.receipt_count=0;assert!(settle(&mut c,&mut r,10).is_err());assert_eq!(c.settled_count,0);}
 #[test]fn soft_failure_timeout_and_rounding_below_soft_never_ready(){let mut c=campaign();c.soft=3;let mut a=receipt();let mut b=receipt();settle(&mut c,&mut a,10).unwrap();settle(&mut c,&mut b,10).unwrap();assert!(!ready(&c,10));c.soft=1;c.phase=2;assert!(!ready(&c,10));assert_eq!(refundable(a.committed,c.total,c.hard,true),2);}
}
#[cfg(test)]mod fixed_supply_tests{
 use super::*;
 #[test]fn rejects_alternate_supply_before_allocating_campaign(){
  let program=Pubkey::new_unique();let creator=Pubkey::new_unique();let campaign=Pubkey::new_unique();let sys=system_program::id();
  let(mut a,mut b,mut d)=(0,0,0);let(mut x,mut y,mut z)=(vec![],vec![],vec![]);
  let accounts=[AccountInfo::new(&creator,true,true,&mut a,&mut x,&sys,false,0),AccountInfo::new(&campaign,false,true,&mut b,&mut y,&sys,false,0),AccountInfo::new(&sys,false,false,&mut d,&mut z,&sys,true,0)];
  let mut instruction=vec![0u8;145];instruction[41..73].copy_from_slice(Pubkey::new_unique().as_ref());instruction[81..113].copy_from_slice(Pubkey::new_unique().as_ref());instruction[113..145].copy_from_slice(Pubkey::new_unique().as_ref());
  for supply in [0,10_000,FIXED_SUPPLY-10_000,FIXED_SUPPLY+10_000]{instruction[73..81].copy_from_slice(&supply.to_le_bytes());assert_eq!(process_instruction(&program,&accounts,&instruction),Err(err(20)));}
  assert_eq!(accounts[1].lamports(),0);assert!(accounts[1].data_is_empty());
 }
}
