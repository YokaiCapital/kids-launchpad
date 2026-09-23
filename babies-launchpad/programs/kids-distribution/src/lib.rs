//! Claim vaults with distribution terms frozen at activation. Four purpose vaults per campaign
//! (participants, parent A, parent B, dev) pay claims under fixed terms; only the two parent
//! allocations expire, 30 days after the on-chain launch time, and are then burnable by anyone.
//! No withdraw, reset, root replacement, deadline change or close instruction exists.
#![allow(unexpected_cfgs, deprecated)]
use solana_program::{account_info::{next_account_info,AccountInfo},clock::Clock,entrypoint,entrypoint::ProgramResult,instruction::{AccountMeta,Instruction},program::{invoke,invoke_signed},program_error::ProgramError,pubkey,pubkey::Pubkey,rent::Rent,system_instruction,system_program,sysvar::Sysvar};
#[cfg(not(feature="no-entrypoint"))]
entrypoint!(process_instruction);
mod math;
mod claims;
#[cfg(test)]mod tests;
pub use math::*;
pub const DISTRIBUTION_LEN:usize=512;
pub const CLAIM_LEN:usize=88;
pub const DISTRIBUTION_MAGIC:&[u8;8]=b"KIDSDST1";
pub const CLAIM_MAGIC:&[u8;8]=b"KIDSDCL1";
/// Seconds from the on-chain launch time until the two free parent allocations expire (30 days).
pub const PARENT_EXPIRY_SECONDS:i64=2_592_000;
pub const PURPOSE_PARTICIPANTS:u8=0;
pub const PURPOSE_PARENT_A:u8=1;
pub const PURPOSE_PARENT_B:u8=2;
pub const PURPOSE_DEV:u8=3;
pub const FLAG_ACTIVATED:u8=1;
/// Bit 1 for parent A, bit 2 for parent B: `FLAG_ACTIVATED<<(1+index)`.
pub fn burned_flag(index:u8)->u8{FLAG_ACTIVATED<<(1+index)}
// Launch program account layouts (programs/atomic-launch/src/lib.rs and claims.rs). Read-only trust.
pub const LAUNCH_CAMPAIGN_LEN:usize=384;
pub const LAUNCH_RECEIPT_LEN:usize=112;
pub const LAUNCH_PARENTS_LEN:usize=256;
pub const LAUNCH_CAMPAIGN_MAGIC:&[u8;8]=b"KIDSESC3";
pub const LAUNCH_RECEIPT_MAGIC:&[u8;8]=b"KIDSREC3";
pub const LAUNCH_PARENTS_MAGIC:&[u8;8]=b"KIDSPAR1";
pub const LAUNCH_PHASE_LAUNCHED:u8=3;
pub const TOKEN:Pubkey=pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA:Pubkey=pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const CHILD_DECIMALS:u8=6;
// Error codes (ProgramError::Custom).
pub const E_CAMPAIGN_NOT_LAUNCHED:u32=1;
pub const E_UNAUTHORIZED:u32=2;
pub const E_PRIOR_COUNTER_MISMATCH:u32=3;
pub const E_VAULT_BALANCE_MISMATCH:u32=4;
pub const E_NOT_ACTIVATED:u32=5;
pub const E_NOT_SETTLED:u32=6;
pub const E_ALREADY_CLAIMED:u32=7;
pub const E_NOT_YET_CLAIMABLE:u32=8;
pub const E_EXPIRED:u32=9;
pub const E_OVERFLOW:u32=10;
pub const E_NOT_EXPIRED:u32=11;
pub const E_ALREADY_BURNED:u32=12;
pub const E_PROOF_MISMATCH:u32=13;
pub const E_BELOW_THRESHOLD:u32=14;
pub const E_ALLOCATION_MISMATCH:u32=15;
pub const E_OVERDRAW:u32=16;
pub const E_INVALID_TOKEN_ACCOUNT:u32=17;
pub const E_INVALID_MINT:u32=18;
pub const E_INVALID_PURPOSE:u32=19;
pub const E_INVALID_ACCOUNT:u32=20;
/// A vault token account does not exist yet. `activate` runs inside the launch instruction, close to the runtime's
/// nested-instruction limit, so the four vaults are created before the launch and only validated here.
pub const E_VAULT_MISSING:u32=21;
pub fn err(n:u32)->ProgramError{ProgramError::Custom(n)}
pub fn require(b:bool,code:u32)->ProgramResult{if b{Ok(())}else{Err(err(code))}}
pub fn read64(d:&[u8],at:usize)->Result<u64,ProgramError>{Ok(u64::from_le_bytes(d.get(at..at+8).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap()))}
pub fn read_key(d:&[u8],at:usize)->Result<Pubkey,ProgramError>{Ok(Pubkey::new_from_array(d.get(at..at+32).ok_or(ProgramError::InvalidAccountData)?.try_into().unwrap()))}
pub fn put64(d:&mut[u8],at:usize,n:u64){d[at..at+8].copy_from_slice(&n.to_le_bytes());}
pub fn add(a:u64,b:u64)->Result<u64,ProgramError>{a.checked_add(b).ok_or(err(E_OVERFLOW))}
pub fn sub(a:u64,b:u64)->Result<u64,ProgramError>{a.checked_sub(b).ok_or(err(E_OVERFLOW))}
// Distribution layout offsets (docs/CLAIM-VAULTS-DESIGN.md §2). Written once at activation; afterwards only
// counters (claimed, burned) and flags change. Nothing below OFF_CLAIMED is ever rewritten.
pub const OFF_CAMPAIGN:usize=8;
pub const OFF_MINT:usize=40;
pub const OFF_LAUNCH_PROGRAM:usize=72;
pub const OFF_SUPPLY:usize=104;
pub const OFF_SETTLED_ACCEPTED:usize=112;
pub const OFF_LAUNCH_TIME:usize=120;
pub const OFF_PARENT_EXPIRY:usize=128;
pub const OFF_DEV_START:usize=136;
pub const OFF_DEV_END:usize=144;
pub const OFF_ROOTS:usize=152;
pub const OFF_PARENT_SUPPLY:usize=216;
pub const OFF_ELIGIBLE:usize=232;
pub const OFF_ALLOCATION:usize=248;
pub const OFF_CLAIMED:usize=280;
pub const OFF_BURNED:usize=312;
pub const OFF_DEV_PRIOR:usize=328;
pub const OFF_FLAGS:usize=336;
pub const OFF_BUMPS:usize=337;
/// Dev wallet copied from the campaign at activation, so a later change to the launch program cannot
/// redirect the dev vault. Placed after the design's bump bytes (337..342), aligned to 8.
pub const OFF_DEV:usize=344;
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct Distribution{pub campaign:Pubkey,pub mint:Pubkey,pub launch_program:Pubkey,pub supply:u64,pub settled_accepted:u64,pub launch_time:i64,pub parent_expiry:i64,pub dev_start:i64,pub dev_end:i64,pub roots:[[u8;32];2],pub parent_supply:[u64;2],pub eligible:[u64;2],pub allocation:[u64;4],pub claimed:[u64;4],pub burned:[u64;2],pub dev_prior:u64,pub flags:u8,pub bumps:[u8;5],pub dev:Pubkey}
impl Distribution{
 pub fn read(account:&AccountInfo,program:&Pubkey)->Result<Self,ProgramError>{
  if account.owner!=program{return Err(ProgramError::IncorrectProgramId)}
  let d=account.try_borrow_data()?;
  if d.len()!=DISTRIBUTION_LEN||&d[..8]!=DISTRIBUTION_MAGIC{return Err(ProgramError::InvalidAccountData)}
  let s=Self::decode(&d)?;
  let (expected,bump)=Pubkey::find_program_address(&[b"distribution",s.campaign.as_ref()],program);
  if expected!=*account.key||bump!=s.bumps[0]{return Err(ProgramError::InvalidSeeds)}
  require(s.flags&FLAG_ACTIVATED!=0,E_NOT_ACTIVATED)?;
  Ok(s)
 }
 pub fn decode(d:&[u8])->Result<Self,ProgramError>{
  let mut roots=[[0u8;32];2];for i in 0..2{roots[i].copy_from_slice(&d[OFF_ROOTS+32*i..OFF_ROOTS+32*i+32]);}
  let mut parent_supply=[0u64;2];let mut eligible=[0u64;2];let mut burned=[0u64;2];let mut allocation=[0u64;4];let mut claimed=[0u64;4];
  for i in 0..2{parent_supply[i]=read64(d,OFF_PARENT_SUPPLY+8*i)?;eligible[i]=read64(d,OFF_ELIGIBLE+8*i)?;burned[i]=read64(d,OFF_BURNED+8*i)?;}
  for p in 0..4{allocation[p]=read64(d,OFF_ALLOCATION+8*p)?;claimed[p]=read64(d,OFF_CLAIMED+8*p)?;}
  let mut bumps=[0u8;5];bumps.copy_from_slice(&d[OFF_BUMPS..OFF_BUMPS+5]);
  Ok(Self{campaign:read_key(d,OFF_CAMPAIGN)?,mint:read_key(d,OFF_MINT)?,launch_program:read_key(d,OFF_LAUNCH_PROGRAM)?,supply:read64(d,OFF_SUPPLY)?,settled_accepted:read64(d,OFF_SETTLED_ACCEPTED)?,launch_time:read64(d,OFF_LAUNCH_TIME)? as i64,parent_expiry:read64(d,OFF_PARENT_EXPIRY)? as i64,dev_start:read64(d,OFF_DEV_START)? as i64,dev_end:read64(d,OFF_DEV_END)? as i64,roots,parent_supply,eligible,allocation,claimed,burned,dev_prior:read64(d,OFF_DEV_PRIOR)?,flags:d[OFF_FLAGS],bumps,dev:read_key(d,OFF_DEV)?})
 }
 pub fn encode(&self,d:&mut[u8]){
  d.fill(0);d[..8].copy_from_slice(DISTRIBUTION_MAGIC);
  for(at,key)in[(OFF_CAMPAIGN,self.campaign),(OFF_MINT,self.mint),(OFF_LAUNCH_PROGRAM,self.launch_program),(OFF_DEV,self.dev)]{d[at..at+32].copy_from_slice(key.as_ref());}
  for(at,n)in[(OFF_SUPPLY,self.supply),(OFF_SETTLED_ACCEPTED,self.settled_accepted),(OFF_LAUNCH_TIME,self.launch_time as u64),(OFF_PARENT_EXPIRY,self.parent_expiry as u64),(OFF_DEV_START,self.dev_start as u64),(OFF_DEV_END,self.dev_end as u64),(OFF_DEV_PRIOR,self.dev_prior)]{put64(d,at,n)}
  for i in 0..2{d[OFF_ROOTS+32*i..OFF_ROOTS+32*i+32].copy_from_slice(&self.roots[i]);put64(d,OFF_PARENT_SUPPLY+8*i,self.parent_supply[i]);put64(d,OFF_ELIGIBLE+8*i,self.eligible[i]);put64(d,OFF_BURNED+8*i,self.burned[i]);}
  for p in 0..4{put64(d,OFF_ALLOCATION+8*p,self.allocation[p]);put64(d,OFF_CLAIMED+8*p,self.claimed[p]);}
  d[OFF_FLAGS]=self.flags;d[OFF_BUMPS..OFF_BUMPS+5].copy_from_slice(&self.bumps);
 }
 /// Only the counters and flags may change after activation; the terms in 0..OFF_CLAIMED are written once.
 pub fn write_counters(&self,account:&AccountInfo)->ProgramResult{
  let mut d=account.try_borrow_mut_data()?;
  for p in 0..4{put64(&mut d,OFF_CLAIMED+8*p,self.claimed[p]);}
  for i in 0..2{put64(&mut d,OFF_BURNED+8*i,self.burned[i]);}
  d[OFF_FLAGS]=self.flags;Ok(())
 }
 pub fn is_burned(&self,index:u8)->bool{self.flags&burned_flag(index)!=0}
 /// Tokens still owed from a vault: allocation minus claimed, or nothing once a parent vault is burned.
 pub fn remaining_entitled(&self,purpose:u8)->Result<u64,ProgramError>{
  if (purpose==PURPOSE_PARENT_A||purpose==PURPOSE_PARENT_B)&&self.is_burned(purpose-1){return Ok(0)}
  sub(self.allocation[purpose as usize],self.claimed[purpose as usize])
 }
}
/// Fields of the launch program's campaign account (384 bytes, `KIDSESC3`) that the distribution reads.
#[derive(Clone,Copy,Debug)]
pub struct LaunchCampaign{pub creator:Pubkey,pub nonce:u64,pub phase:u8,pub bump:u8,pub settled_accepted:u64,pub child_mint:Pubkey,pub supply:u64,pub dev:Pubkey,pub launch_time:i64,pub dev_claimed:u64,pub distribution_program:Pubkey}
/// Campaign offset of the distribution program the launch program recorded at creation (zero when none).
pub const LAUNCH_CAMPAIGN_OFF_DISTRIBUTION_PROGRAM:usize=312;
impl LaunchCampaign{
 pub fn read(account:&AccountInfo,launch_program:&Pubkey)->Result<Self,ProgramError>{
  if account.owner!=launch_program{return Err(ProgramError::IncorrectProgramId)}
  let d=account.try_borrow_data()?;
  if d.len()!=LAUNCH_CAMPAIGN_LEN||&d[..8]!=LAUNCH_CAMPAIGN_MAGIC{return Err(ProgramError::InvalidAccountData)}
  let s=Self{creator:read_key(&d,8)?,nonce:read64(&d,40)?,phase:d[96],bump:d[97],settled_accepted:read64(&d,120)?,child_mint:read_key(&d,128)?,supply:read64(&d,160)?,dev:read_key(&d,168)?,launch_time:read64(&d,232)? as i64,dev_claimed:read64(&d,304)?,distribution_program:read_key(&d,LAUNCH_CAMPAIGN_OFF_DISTRIBUTION_PROGRAM)?};
  let (expected,bump)=Pubkey::find_program_address(&[b"campaign",s.creator.as_ref(),&s.nonce.to_le_bytes()],launch_program);
  if expected!=*account.key||bump!=s.bump{return Err(ProgramError::InvalidSeeds)}
  Ok(s)
 }
}
/// The launch program's parents account (256 bytes, `KIDSPAR1`): roots, snapshot supplies, eligible totals and
/// the amounts already claimed under the launch program's own parent claim.
#[derive(Clone,Copy,Debug)]
pub struct LaunchParents{pub roots:[[u8;32];2],pub supply:[u64;2],pub eligible:[u64;2],pub claimed:[u64;2]}
impl LaunchParents{
 pub fn read(account:&AccountInfo,launch_program:&Pubkey,campaign:&Pubkey)->Result<Self,ProgramError>{
  if account.owner!=launch_program{return Err(ProgramError::IncorrectProgramId)}
  let d=account.try_borrow_data()?;
  if d.len()!=LAUNCH_PARENTS_LEN||&d[..8]!=LAUNCH_PARENTS_MAGIC||read_key(&d,8)?!=*campaign{return Err(ProgramError::InvalidAccountData)}
  if *account.key!=Pubkey::find_program_address(&[b"parents",campaign.as_ref()],launch_program).0{return Err(ProgramError::InvalidSeeds)}
  let mut s=Self{roots:[[0;32];2],supply:[0;2],eligible:[0;2],claimed:[0;2]};
  for i in 0..2{s.roots[i].copy_from_slice(&d[104+32*i..136+32*i]);s.supply[i]=read64(&d,168+8*i)?;s.eligible[i]=read64(&d,192+8*i)?;s.claimed[i]=read64(&d,208+8*i)?;}
  Ok(s)
 }
}
/// The launch program's participant receipt (112 bytes, `KIDSREC3`).
#[derive(Clone,Copy,Debug)]
pub struct LaunchReceipt{pub owner:Pubkey,pub settled:bool,pub accepted:u64,pub claimed_under_launch_program:bool}
impl LaunchReceipt{
 pub fn read(account:&AccountInfo,launch_program:&Pubkey,campaign:&Pubkey)->Result<Self,ProgramError>{
  if account.owner!=launch_program{return Err(ProgramError::IncorrectProgramId)}
  let d=account.try_borrow_data()?;
  if d.len()!=LAUNCH_RECEIPT_LEN||&d[..8]!=LAUNCH_RECEIPT_MAGIC||read_key(&d,8)?!=*campaign{return Err(ProgramError::InvalidAccountData)}
  let owner=read_key(&d,40)?;
  let (expected,bump)=Pubkey::find_program_address(&[b"commitment",campaign.as_ref(),owner.as_ref()],launch_program);
  if expected!=*account.key||bump!=d[96]{return Err(ProgramError::InvalidSeeds)}
  Ok(Self{owner,settled:d[97]!=0,accepted:read64(&d,104)?,claimed_under_launch_program:d[98]!=0})
 }
}
pub fn system(a:&AccountInfo)->ProgramResult{if *a.key!=system_program::id(){Err(ProgramError::IncorrectProgramId)}else{Ok(())}}
pub fn create_pda<'a>(payer:&AccountInfo<'a>,target:&AccountInfo<'a>,system_info:&AccountInfo<'a>,program:&Pubkey,len:usize,seeds:&[&[u8]])->ProgramResult{
 if target.owner!=&system_program::id()||!target.data_is_empty(){return Err(ProgramError::AccountAlreadyInitialized)}
 let rent=Rent::get()?.minimum_balance(len);
 // An unfunded account takes a single System CPI. A third party can pre-fund a PDA; that donation must not block
 // creation, so a funded account is topped up, allocated and assigned instead.
 if target.lamports()==0{
  return invoke_signed(&system_instruction::create_account(payer.key,target.key,rent,len as u64,program),&[payer.clone(),target.clone(),system_info.clone()],&[seeds])
 }
 let needed=rent.saturating_sub(target.lamports());
 if needed>0{invoke(&system_instruction::transfer(payer.key,target.key,needed),&[payer.clone(),target.clone(),system_info.clone()])?;}
 invoke_signed(&system_instruction::allocate(target.key,len as u64),&[target.clone(),system_info.clone()],&[seeds])?;
 invoke_signed(&system_instruction::assign(target.key,program),&[target.clone(),system_info.clone()],&[seeds])
}
/// Balance of a classic token account holding `mint` for `owner`: initialized, not frozen, no delegate, no close authority.
pub fn token(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey)->Result<u64,ProgramError>{
 require(*a.owner==TOKEN,E_INVALID_TOKEN_ACCOUNT)?;let d=a.try_borrow_data()?;
 require(d.len()==165,E_INVALID_TOKEN_ACCOUNT)?;
 require(read_key(&d,0)?==*mint&&read_key(&d,32)?==*owner&&d[108]==1&&d[72..76]==[0;4]&&d[129..133]==[0;4],E_INVALID_TOKEN_ACCOUNT)?;
 read64(&d,64)
}
pub fn ata(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey)->ProgramResult{require(*a.key==Pubkey::find_program_address(&[owner.as_ref(),TOKEN.as_ref(),mint.as_ref()],&ATA).0,E_INVALID_TOKEN_ACCOUNT)}
/// The child mint: classic Token program, six decimals, no mint or freeze authority, supply never above the
/// original (holders may burn; entitlements stay based on the original supply). Returns the current supply.
pub fn child_mint(a:&AccountInfo,expected:&Pubkey,original_supply:u64)->Result<u64,ProgramError>{
 require(*a.key==*expected&&*a.owner==TOKEN,E_INVALID_MINT)?;let d=a.try_borrow_data()?;
 require(d.len()==82&&d[45]==1&&d[44]==CHILD_DECIMALS&&d[..4]==[0;4]&&d[46..50]==[0;4],E_INVALID_MINT)?;
 let supply=read64(&d,36)?;require(supply<=original_supply,E_INVALID_MINT)?;Ok(supply)
}
pub fn vault_authority(program:&Pubkey,campaign:&Pubkey,purpose:u8)->(Pubkey,u8){Pubkey::find_program_address(&[b"vault",campaign.as_ref(),&[purpose]],program)}
/// Checks the vault authority PDA against the stored bump and returns its seeds' bump byte.
pub(crate) fn bound_vault_authority(program:&Pubkey,d:&Distribution,purpose:u8,authority:&AccountInfo)->Result<u8,ProgramError>{
 require(purpose<4,E_INVALID_PURPOSE)?;let bump=d.bumps[1+purpose as usize];
 let expected=Pubkey::create_program_address(&[b"vault",d.campaign.as_ref(),&[purpose],&[bump]],program).map_err(|_|err(E_INVALID_ACCOUNT))?;
 require(*authority.key==expected,E_INVALID_ACCOUNT)?;Ok(bump)
}
/// Transfer `amount` from the purpose vault to the owner's associated token account, signed by the vault authority.
pub fn pay_from_vault<'a>(program:&Pubkey,d:&Distribution,purpose:u8,mint:&AccountInfo<'a>,authority:&AccountInfo<'a>,vault:&AccountInfo<'a>,destination:&AccountInfo<'a>,owner:&Pubkey,token_program:&AccountInfo<'a>,amount:u64)->ProgramResult{
 require(*token_program.key==TOKEN&&token_program.executable,E_INVALID_ACCOUNT)?;
 child_mint(mint,&d.mint,d.supply)?;
 let bump=bound_vault_authority(program,d,purpose,authority)?;
 ata(vault,&d.mint,authority.key)?;ata(destination,&d.mint,owner)?;require(vault.key!=destination.key,E_INVALID_TOKEN_ACCOUNT)?;
 let before=token(vault,&d.mint,authority.key)?;require(before>=amount,E_OVERDRAW)?;token(destination,&d.mint,owner)?;
 let mut data=vec![3];data.extend_from_slice(&amount.to_le_bytes());
 invoke_signed(&Instruction{program_id:TOKEN,accounts:vec![AccountMeta::new(*vault.key,false),AccountMeta::new(*destination.key,false),AccountMeta::new_readonly(*authority.key,true)],data},&[vault.clone(),destination.clone(),authority.clone(),token_program.clone()],&[&[b"vault",d.campaign.as_ref(),&[purpose],&[bump]]])?;
 require(token(vault,&d.mint,authority.key)?==sub(before,amount)?,E_VAULT_BALANCE_MISMATCH)
}
/// Burn `amount` from the purpose vault, signed by the vault authority. Checks the vault balance and the mint
/// supply both fell by exactly `amount` and that mint and freeze authorities are still absent.
pub fn burn_from_vault<'a>(program:&Pubkey,d:&Distribution,purpose:u8,mint:&AccountInfo<'a>,authority:&AccountInfo<'a>,vault:&AccountInfo<'a>,token_program:&AccountInfo<'a>,amount:u64)->ProgramResult{
 require(*token_program.key==TOKEN&&token_program.executable,E_INVALID_ACCOUNT)?;
 let supply_before=child_mint(mint,&d.mint,d.supply)?;
 let bump=bound_vault_authority(program,d,purpose,authority)?;
 ata(vault,&d.mint,authority.key)?;
 let before=token(vault,&d.mint,authority.key)?;require(before>=amount,E_OVERDRAW)?;
 if amount==0{return Ok(())}
 let mut data=vec![8];data.extend_from_slice(&amount.to_le_bytes());
 invoke_signed(&Instruction{program_id:TOKEN,accounts:vec![AccountMeta::new(*vault.key,false),AccountMeta::new(*mint.key,false),AccountMeta::new_readonly(*authority.key,true)],data},&[vault.clone(),mint.clone(),authority.clone(),token_program.clone()],&[&[b"vault",d.campaign.as_ref(),&[purpose],&[bump]]])?;
 require(token(vault,&d.mint,authority.key)?==sub(before,amount)?,E_VAULT_BALANCE_MISMATCH)?;
 require(child_mint(mint,&d.mint,d.supply)?==sub(supply_before,amount)?,E_INVALID_MINT)
}
/// Parsed instruction data. Tags follow docs/CLAIM-VAULTS-DESIGN.md §3; every other tag is refused.
#[derive(Debug,PartialEq,Eq)]
pub enum InstructionData<'a>{
 /// `prior` = tokens already paid per purpose under the launch program before this activation (all zero for a
 /// fresh launch). Parents and dev are checked against the launch program's own counters.
 Activate{prior:[u64;4]},
 ClaimParticipant,
 ClaimParent{index:u8,balance:u64,allocation:u64,proof:&'a [u8]},
 ClaimDev,
 BurnExpired{index:u8},
 SweepDonationToBurn{purpose:u8},
}
pub const TAG_ACTIVATE:u8=0;
pub const TAG_CLAIM_PARTICIPANT:u8=1;
pub const TAG_CLAIM_PARENT:u8=2;
pub const TAG_CLAIM_DEV:u8=3;
pub const TAG_BURN_EXPIRED:u8=4;
pub const TAG_SWEEP_DONATION_TO_BURN:u8=5;
pub const MAX_PROOF_DEPTH:usize=32;
pub fn parse(data:&[u8])->Result<InstructionData<'_>,ProgramError>{
 let bad=||ProgramError::InvalidInstructionData;
 let (&tag,body)=data.split_first().ok_or_else(bad)?;
 match tag{
  TAG_ACTIVATE=>{if body.len()!=32{return Err(bad())}let mut prior=[0u64;4];for p in 0..4{prior[p]=read64(body,8*p)?;}Ok(InstructionData::Activate{prior})},
  TAG_CLAIM_PARTICIPANT=>if body.is_empty(){Ok(InstructionData::ClaimParticipant)}else{Err(bad())},
  TAG_CLAIM_PARENT=>{
   if body.len()<18{return Err(bad())}
   let index=body[0];let balance=read64(body,1)?;let allocation=read64(body,9)?;let count=body[17] as usize;
   if index>=2||count>MAX_PROOF_DEPTH||body.len()!=18+32*count{return Err(bad())}
   Ok(InstructionData::ClaimParent{index,balance,allocation,proof:&body[18..]})
  },
  TAG_CLAIM_DEV=>if body.is_empty(){Ok(InstructionData::ClaimDev)}else{Err(bad())},
  TAG_BURN_EXPIRED=>if body.len()==1&&body[0]<2{Ok(InstructionData::BurnExpired{index:body[0]})}else{Err(bad())},
  TAG_SWEEP_DONATION_TO_BURN=>if body.len()==1&&body[0]<4{Ok(InstructionData::SweepDonationToBurn{purpose:body[0]})}else{Err(bad())},
  _=>Err(bad()),
 }
}
pub fn process_instruction(program:&Pubkey,accounts:&[AccountInfo],data:&[u8])->ProgramResult{
 match parse(data)?{
  InstructionData::Activate{prior}=>activate(program,accounts,prior),
  InstructionData::ClaimParticipant=>claims::participant(program,accounts),
  InstructionData::ClaimParent{index,balance,allocation,proof}=>claims::parent(program,accounts,index,balance,allocation,proof),
  InstructionData::ClaimDev=>claims::dev(program,accounts),
  InstructionData::BurnExpired{index}=>claims::burn_expired(program,accounts,index),
  InstructionData::SweepDonationToBurn{purpose}=>claims::sweep_donation_to_burn(program,accounts,purpose),
 }
}
/// Tag 0. Accounts: 0 signer (launch authority PDA of the launch program, or the campaign creator), 1 payer
/// (signer, rent for the distribution record), 2 campaign, 3 parents, 4 child mint, 5 source: the signer's
/// associated token account for the child mint (the launch custody ATA on the launch authority path),
/// 6 distribution PDA, 7..10 vault authorities 0..3, 11..14 vaults 0..3, 15 Token program, 16 System program.
/// A campaign that recorded a distribution program at creation may only be activated by that program.
/// Each vault is its authority's associated token account for the child mint and must already exist, initialised,
/// owned by the authority, without delegate or close authority (`E_VAULT_MISSING` when absent,
/// `E_INVALID_TOKEN_ACCOUNT` otherwise). Every check runs before the first CPI. Then the distribution record is
/// created, any balance a vault held beforehand is burned (a donation cannot inflate an entitlement), and
/// `allocation − prior` moves into each vault from the source, which must leave each vault holding exactly that.
/// CPIs on a fresh launch: one System `create_account` and four Token transfers, plus one burn per donated vault.
pub fn activate(program:&Pubkey,accounts:&[AccountInfo],prior:[u64;4])->ProgramResult{
 require(accounts.len()==17,E_INVALID_ACCOUNT)?;
 let iter=&mut accounts.iter();
 let signer=next_account_info(iter)?;let payer=next_account_info(iter)?;let campaign=next_account_info(iter)?;let parents=next_account_info(iter)?;
 let mint=next_account_info(iter)?;let source=next_account_info(iter)?;let distribution=next_account_info(iter)?;
 let authorities:Vec<&AccountInfo>=(0..4).map(|_|next_account_info(iter)).collect::<Result<_,_>>()?;
 let vaults:Vec<&AccountInfo>=(0..4).map(|_|next_account_info(iter)).collect::<Result<_,_>>()?;
 let token_program=next_account_info(iter)?;let sys=next_account_info(iter)?;
 system(sys)?;require(*token_program.key==TOKEN&&token_program.executable,E_INVALID_ACCOUNT)?;
 if !signer.is_signer||!payer.is_signer{return Err(ProgramError::MissingRequiredSignature)}
 let launch_program=*campaign.owner;
 let c=LaunchCampaign::read(campaign,&launch_program)?;
 require(c.phase==LAUNCH_PHASE_LAUNCHED&&c.launch_time>0,E_CAMPAIGN_NOT_LAUNCHED)?;
 let p=LaunchParents::read(parents,&launch_program,campaign.key)?;
 let launch_authority=Pubkey::find_program_address(&[b"launch_authority",campaign.key.as_ref()],&launch_program).0;
 require(*signer.key==launch_authority||*signer.key==c.creator,E_UNAUTHORIZED)?;
 require(c.distribution_program==Pubkey::default()||c.distribution_program==*program,E_INVALID_ACCOUNT)?;
 child_mint(mint,&c.child_mint,c.supply)?;
 ata(source,&c.child_mint,signer.key)?;let source_balance=token(source,&c.child_mint,signer.key)?;
 let allocation=allocations(c.supply);
 require(prior[1]==p.claimed[0]&&prior[2]==p.claimed[1]&&prior[3]==c.dev_claimed,E_PRIOR_COUNTER_MISMATCH)?;
 let mut owed=0u64;for purpose in 0..4{require(prior[purpose]<=allocation[purpose],E_PRIOR_COUNTER_MISMATCH)?;owed=add(owed,sub(allocation[purpose],prior[purpose])?)?;}
 require(source_balance>=owed,E_VAULT_BALANCE_MISMATCH)?;
 let (distribution_key,distribution_bump)=Pubkey::find_program_address(&[b"distribution",campaign.key.as_ref()],program);
 require(*distribution.key==distribution_key,E_INVALID_ACCOUNT)?;
 let mut bumps=[distribution_bump,0,0,0,0];
 let mut d=Distribution{campaign:*campaign.key,mint:c.child_mint,launch_program,supply:c.supply,settled_accepted:c.settled_accepted,launch_time:c.launch_time,parent_expiry:parent_expiry(c.launch_time)?,dev_start:c.launch_time,dev_end:three_month_end(c.launch_time)?,roots:p.roots,parent_supply:p.supply,eligible:p.eligible,allocation,claimed:prior,burned:[0;2],dev_prior:prior[3],flags:FLAG_ACTIVATED,bumps,dev:c.dev};
 for purpose in 0..4u8{
  let (authority_key,bump)=vault_authority(program,campaign.key,purpose);bumps[1+purpose as usize]=bump;
  let vault=vaults[purpose as usize];
  require(*authorities[purpose as usize].key==authority_key,E_INVALID_ACCOUNT)?;ata(vault,&c.child_mint,&authority_key)?;
  require(source.key!=vault.key,E_INVALID_TOKEN_ACCOUNT)?;
  require(!(*vault.owner==system_program::id()&&vault.data_is_empty()),E_VAULT_MISSING)?;
  token(vault,&c.child_mint,&authority_key)?;
 }
 d.bumps=bumps;
 create_pda(payer,distribution,sys,program,DISTRIBUTION_LEN,&[b"distribution",campaign.key.as_ref(),&[distribution_bump]])?;
 for purpose in 0..4u8{
  let authority=authorities[purpose as usize];let vault=vaults[purpose as usize];
  let donated=token(vault,&c.child_mint,authority.key)?;
  if donated>0{burn_from_vault(program,&d,purpose,mint,authority,vault,token_program,donated)?;}
  let amount=sub(allocation[purpose as usize],prior[purpose as usize])?;
  require(token(source,&c.child_mint,signer.key)?>=amount,E_VAULT_BALANCE_MISMATCH)?;
  let mut data=vec![3];data.extend_from_slice(&amount.to_le_bytes());
  invoke(&Instruction{program_id:TOKEN,accounts:vec![AccountMeta::new(*source.key,false),AccountMeta::new(*vault.key,false),AccountMeta::new_readonly(*signer.key,true)],data},&[source.clone(),vault.clone(),signer.clone(),token_program.clone()])?;
  require(token(vault,&c.child_mint,authority.key)?==amount,E_VAULT_BALANCE_MISMATCH)?;
 }
 d.encode(&mut distribution.try_borrow_mut_data()?);Ok(())
}
