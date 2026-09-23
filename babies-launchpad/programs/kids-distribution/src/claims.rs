//! Claims, expiry burns and donation sweeps. Every payment leaves a vault through `pay_from_vault`, every burn
//! through `burn_from_vault`; both are signed by the purpose vault's authority PDA and bind campaign, mint,
//! purpose and token program.
use super::*;
/// Claim receipt of this program (88 bytes, `KIDSDCL1`): campaign, owner, purpose, bump, claimed byte, amount.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct ClaimReceipt{pub campaign:Pubkey,pub owner:Pubkey,pub purpose:u8,pub bump:u8,pub amount:u64}
pub const OFF_CLAIM_CAMPAIGN:usize=8;
pub const OFF_CLAIM_OWNER:usize=40;
pub const OFF_CLAIM_PURPOSE:usize=72;
pub const OFF_CLAIM_BUMP:usize=73;
pub const OFF_CLAIM_CLAIMED:usize=74;
pub const OFF_CLAIM_AMOUNT:usize=80;
impl ClaimReceipt{
 pub fn seeds<'a>(campaign:&'a Pubkey,purpose:&'a [u8;1],owner:&'a Pubkey)->[&'a [u8];4]{[b"claim",campaign.as_ref(),purpose,owner.as_ref()]}
 pub fn decode(d:&[u8])->Result<Self,ProgramError>{
  require(d.len()==CLAIM_LEN&&&d[..8]==CLAIM_MAGIC&&d[OFF_CLAIM_CLAIMED]==1,E_INVALID_ACCOUNT)?;
  Ok(Self{campaign:read_key(d,OFF_CLAIM_CAMPAIGN)?,owner:read_key(d,OFF_CLAIM_OWNER)?,purpose:d[OFF_CLAIM_PURPOSE],bump:d[OFF_CLAIM_BUMP],amount:read64(d,OFF_CLAIM_AMOUNT)?})
 }
 pub fn encode(&self,d:&mut[u8]){d.fill(0);d[..8].copy_from_slice(CLAIM_MAGIC);d[OFF_CLAIM_CAMPAIGN..OFF_CLAIM_CAMPAIGN+32].copy_from_slice(self.campaign.as_ref());d[OFF_CLAIM_OWNER..OFF_CLAIM_OWNER+32].copy_from_slice(self.owner.as_ref());d[OFF_CLAIM_PURPOSE]=self.purpose;d[OFF_CLAIM_BUMP]=self.bump;d[OFF_CLAIM_CLAIMED]=1;put64(d,OFF_CLAIM_AMOUNT,self.amount);}
}
/// Existing receipt for this exact claim: `Ok(Some(amount))` when a valid receipt already exists (idempotent
/// replay), `Ok(None)` when the account is still an empty System account, an error for any other account.
fn existing_claim(program:&Pubkey,account:&AccountInfo,campaign:&Pubkey,purpose:u8,owner:&Pubkey)->Result<(u8,Option<u64>),ProgramError>{
 let purpose_seed=[purpose];
 let (expected,bump)=Pubkey::find_program_address(&ClaimReceipt::seeds(campaign,&purpose_seed,owner),program);
 require(*account.key==expected,E_INVALID_ACCOUNT)?;
 if *account.owner==*program{
  let d=account.try_borrow_data()?;let r=ClaimReceipt::decode(&d)?;
  require(r.campaign==*campaign&&r.owner==*owner&&r.purpose==purpose&&r.bump==bump,E_INVALID_ACCOUNT)?;
  return Ok((bump,Some(r.amount)))
 }
 require(*account.owner==system_program::id()&&account.data_is_empty(),E_INVALID_ACCOUNT)?;
 Ok((bump,None))
}
fn write_claim<'a>(program:&Pubkey,payer:&AccountInfo<'a>,account:&AccountInfo<'a>,sys:&AccountInfo<'a>,campaign:&Pubkey,purpose:u8,bump:u8,owner:&Pubkey,amount:u64)->ProgramResult{
 let purpose_seed=[purpose];let bump_seed=[bump];
 let seeds=ClaimReceipt::seeds(campaign,&purpose_seed,owner);
 create_pda(payer,account,sys,program,CLAIM_LEN,&[seeds[0],seeds[1],seeds[2],seeds[3],&bump_seed])?;
 ClaimReceipt{campaign:*campaign,owner:*owner,purpose,bump,amount}.encode(&mut account.try_borrow_mut_data()?);Ok(())
}
fn now()->Result<i64,ProgramError>{Ok(Clock::get()?.unix_timestamp)}
/// Tag 1. Accounts: 0 owner (signer, pays the receipt rent), 1 distribution, 2 launch receipt, 3 claim receipt,
/// 4 mint, 5 vault authority 0, 6 vault 0, 7 owner's associated token account, 8 Token program, 9 System program.
/// Pays `allocation × accepted / settled_accepted` once; a repeat with the same accounts is a no-op.
pub(super) fn participant(program:&Pubkey,a:&[AccountInfo])->ProgramResult{
 require(a.len()==10,E_INVALID_ACCOUNT)?;system(&a[9])?;
 let owner=&a[0];if !owner.is_signer{return Err(ProgramError::MissingRequiredSignature)}
 let mut d=Distribution::read(&a[1],program)?;
 require(now()?>=d.launch_time,E_NOT_YET_CLAIMABLE)?;
 let receipt=LaunchReceipt::read(&a[2],&d.launch_program,&d.campaign)?;
 require(receipt.owner==*owner.key,E_UNAUTHORIZED)?;
 require(receipt.settled,E_NOT_SETTLED)?;
 require(!receipt.claimed_under_launch_program,E_ALREADY_CLAIMED)?;
 let (bump,existing)=existing_claim(program,&a[3],&d.campaign,PURPOSE_PARTICIPANTS,owner.key)?;
 if existing.is_some(){return Ok(())}
 let amount=proportional(d.allocation[0],receipt.accepted,d.settled_accepted)?;
 let claimed=add(d.claimed[0],amount)?;require(claimed<=d.allocation[0],E_OVERDRAW)?;
 write_claim(program,owner,&a[3],&a[9],&d.campaign,PURPOSE_PARTICIPANTS,bump,owner.key,amount)?;
 pay_from_vault(program,&d,PURPOSE_PARTICIPANTS,&a[4],&a[5],&a[6],&a[7],owner.key,&a[8],amount)?;
 d.claimed[0]=claimed;d.write_counters(&a[1])
}
/// Tag 2. Accounts: 0 owner (signer, pays the receipt rent), 1 distribution, 2 claim receipt, 3 mint,
/// 4 vault authority 1+index, 5 vault 1+index, 6 owner's associated token account, 7 Token program, 8 System program.
/// Body: index, balance, allocation, proof. Open in `[launch_time, parent_expiry)` and only while unburned.
pub(super) fn parent(program:&Pubkey,a:&[AccountInfo],index:u8,balance:u64,allocation:u64,proof:&[u8])->ProgramResult{
 require(a.len()==9,E_INVALID_ACCOUNT)?;system(&a[8])?;require(index<2,E_INVALID_PURPOSE)?;
 let owner=&a[0];if !owner.is_signer{return Err(ProgramError::MissingRequiredSignature)}
 let purpose=PURPOSE_PARENT_A+index;let slot=purpose as usize;let i=index as usize;
 let mut d=Distribution::read(&a[1],program)?;
 parent_claim_window(now()?,d.launch_time,d.parent_expiry)?;require(!d.is_burned(index),E_EXPIRED)?;
 require(balance>=threshold(d.parent_supply[i]),E_BELOW_THRESHOLD)?;
 require(allocation==proportional(d.allocation[slot],balance,d.eligible[i])?,E_ALLOCATION_MISMATCH)?;
 require(merkle(&d.campaign,index,owner.key,balance,allocation,proof)==d.roots[i],E_PROOF_MISMATCH)?;
 let (bump,existing)=existing_claim(program,&a[2],&d.campaign,purpose,owner.key)?;
 if existing.is_some(){return Ok(())}
 let claimed=add(d.claimed[slot],allocation)?;require(claimed<=d.allocation[slot],E_OVERDRAW)?;
 write_claim(program,owner,&a[2],&a[8],&d.campaign,purpose,bump,owner.key,allocation)?;
 pay_from_vault(program,&d,purpose,&a[3],&a[4],&a[5],&a[6],owner.key,&a[7],allocation)?;
 d.claimed[slot]=claimed;d.write_counters(&a[1])
}
/// Tag 3. Accounts: 0 dev (signer), 1 distribution, 2 mint, 3 vault authority 3, 4 vault 3, 5 dev's associated
/// token account, 6 Token program. Pays `entitled(now) − claimed`; nothing to pay is a no-op.
pub(super) fn dev(program:&Pubkey,a:&[AccountInfo])->ProgramResult{
 require(a.len()==7,E_INVALID_ACCOUNT)?;
 let dev=&a[0];if !dev.is_signer{return Err(ProgramError::MissingRequiredSignature)}
 let mut d=Distribution::read(&a[1],program)?;require(*dev.key==d.dev,E_UNAUTHORIZED)?;
 let entitled=dev_entitled(d.supply,d.dev_start,d.dev_end,now()?)?;require(entitled<=d.allocation[3],E_OVERDRAW)?;
 let amount=sub(entitled,d.claimed[3])?;if amount==0{return Ok(())}
 pay_from_vault(program,&d,PURPOSE_DEV,&a[2],&a[3],&a[4],&a[5],dev.key,&a[6],amount)?;
 d.claimed[3]=entitled;d.write_counters(&a[1])
}
/// Tag 4. Accounts: 0 distribution, 1 mint, 2 vault authority 1+index, 3 vault 1+index, 4 Token program.
/// Anyone may call from `parent_expiry` on. Burns the whole vault balance once; a repeat is `AlreadyBurned`.
pub(super) fn burn_expired(program:&Pubkey,a:&[AccountInfo],index:u8)->ProgramResult{
 require(a.len()==5,E_INVALID_ACCOUNT)?;require(index<2,E_INVALID_PURPOSE)?;
 let purpose=PURPOSE_PARENT_A+index;
 let mut d=Distribution::read(&a[0],program)?;
 burn_decision(now()?,d.parent_expiry,d.is_burned(index))?;
 bound_vault_authority(program,&d,purpose,&a[2])?;ata(&a[3],&d.mint,a[2].key)?;
 let balance=token(&a[3],&d.mint,a[2].key)?;
 burn_from_vault(program,&d,purpose,&a[1],&a[2],&a[3],&a[4],balance)?;
 d.burned[index as usize]=balance;d.flags|=burned_flag(index);d.write_counters(&a[0])
}
/// Tag 5. Accounts: 0 distribution, 1 mint, 2 vault authority, 3 vault, 4 Token program. Anyone may call.
/// Burns whatever a vault holds above what is still owed; a vault with no excess is a no-op.
pub(super) fn sweep_donation_to_burn(program:&Pubkey,a:&[AccountInfo],purpose:u8)->ProgramResult{
 require(a.len()==5,E_INVALID_ACCOUNT)?;require(purpose<4,E_INVALID_PURPOSE)?;
 let d=Distribution::read(&a[0],program)?;
 bound_vault_authority(program,&d,purpose,&a[2])?;ata(&a[3],&d.mint,a[2].key)?;
 let balance=token(&a[3],&d.mint,a[2].key)?;let owed=d.remaining_entitled(purpose)?;
 if balance<=owed{return Ok(())}
 burn_from_vault(program,&d,purpose,&a[1],&a[2],&a[3],&a[4],sub(balance,owed)?)?;
 require(token(&a[3],&d.mint,a[2].key)?==owed,E_VAULT_BALANCE_MISMATCH)
}
