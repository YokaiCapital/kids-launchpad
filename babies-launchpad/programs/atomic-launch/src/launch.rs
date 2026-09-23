//! Atomic pool creation and permanent LP custody through canonical programs. A campaign that recorded a
//! distribution program at tag 0 also funds its four claim vaults and activates the distribution here, after the
//! pool and the LP lock and inside the same instruction, so a launched pool never exists with unfunded claims.
use super::*;
use solana_program::{instruction::{AccountMeta,Instruction},pubkey};
/// Tag 6 accounts: 0 campaign, 1 keeper (signer, pays rent), 2 launch authority PDA, 3 child mint, 4 child custody
/// ATA, 5 WSOL custody ATA, 6 fee NFT mint (signer), 7 fee NFT ATA of the campaign, 8 locked liquidity PDA,
/// 9 lock authority's LP ATA, 10 fee NFT metadata, 11 Token, 12 Associated Token, 13 System, 14 Rent, 15 CPMM,
/// 16 AMM config, 17 CPMM authority, 18 pool state, 19 LP mint, 20 launch authority's LP ATA, 21 vault 0,
/// 22 vault 1, 23 create-pool fee, 24 observation, 25 lock program, 26 lock authority, 27 Metadata, 28 WSOL mint.
/// With a recorded distribution program: 29 distribution program, 30 parents PDA, 31 distribution PDA,
/// 32..35 vault authorities 0..3, 36..39 vault ATAs 0..3 (created before the launch, empty).
pub(super) const LAUNCH_ACCOUNTS:usize=29;
pub(super) const LAUNCH_ACCOUNTS_WITH_DISTRIBUTION:usize=40;
pub(super) const DISTRIBUTION_LEN:usize=512;
const DISTRIBUTION_MAGIC:&[u8;8]=b"KIDSDST1";
/// Offsets inside the distribution program's record (programs/kids-distribution/src/lib.rs) read back after activation.
const DISTRIBUTION_OFF_CAMPAIGN:usize=8;
const DISTRIBUTION_OFF_MINT:usize=40;
const DISTRIBUTION_OFF_LAUNCH_PROGRAM:usize=72;
const DISTRIBUTION_OFF_SUPPLY:usize=104;
const DISTRIBUTION_OFF_ALLOCATION:usize=248;
const DISTRIBUTION_OFF_FLAGS:usize=336;
const DISTRIBUTION_FLAG_ACTIVATED:u8=1;
const DISTRIBUTION_TAG_ACTIVATE:u8=0;
/// Basis points of the supply per vault: participants 43.5 %, parent A 5 %, parent B 5 %, dev 3 %. With the
/// 43.5 % liquidity share the table sums to 10,000, so custody keeps only `supply % 10000` (zero for the fixed supply).
const VAULT_ALLOCATION_BPS:[u64;4]=[4350,500,500,300];
pub(super) const LIQUIDITY_BPS:u64=4350;
pub(super) fn share(supply:u64,bps:u64)->u64{supply/10000*bps}
pub(super) fn vault_allocations(supply:u64)->[u64;4]{[share(supply,VAULT_ALLOCATION_BPS[0]),share(supply,VAULT_ALLOCATION_BPS[1]),share(supply,VAULT_ALLOCATION_BPS[2]),share(supply,VAULT_ALLOCATION_BPS[3])]}
/// Tokens left in custody after liquidity and the four vaults: the documented dust, owed to nobody.
pub(super) fn custody_after_activation(supply:u64)->Result<u64,ProgramError>{
 let allocated=vault_allocations(supply).iter().try_fold(share(supply,LIQUIDITY_BPS),|acc,n|acc.checked_add(*n)).ok_or(err(10))?;
 supply.checked_sub(allocated).ok_or(err(10))
}
pub(super) fn launch_account_count(c:&Campaign)->usize{if c.distribution_program==Pubkey::default(){LAUNCH_ACCOUNTS}else{LAUNCH_ACCOUNTS_WITH_DISTRIBUTION}}
fn funded(value:bool)->ProgramResult{if value{Ok(())}else{Err(err(E_DISTRIBUTION_FUNDING_MISMATCH))}}
const TOKEN:Pubkey=pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA:Pubkey=pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CPMM:Pubkey=pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const LOCK:Pubkey=pubkey!("LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE");
const LOCK_AUTH:Pubkey=pubkey!("3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH");
const METADATA:Pubkey=pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const WSOL:Pubkey=pubkey!("So11111111111111111111111111111111111111112");
const CONFIGS:[Pubkey;2]=[pubkey!("2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5"),pubkey!("ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi")];
const FEE:Pubkey=pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
fn check(value:bool)->ProgramResult{if value{Ok(())}else{Err(err(21))}}
/// The Raydium AmmConfig a launch may create its pool on: enabled, one of the approved tiers (index 2 at 2 % or index 7 at
/// 2.5 %, owner decision 23 September 2026) with the standard protocol and fund shares. Returns the trade rate.
fn amm_config_rate(d:&[u8])->Result<u64,ProgramError>{
 check(d.len()==236&&d[..8]==solana_program::hash::hash(b"account:AmmConfig").to_bytes()[..8]&&d[9]==0)?;
 let index=u16::from_le_bytes([d[10],d[11]]);let rate=read64(d,12)?;
 check((index==2&&rate==20000)||(index==7&&rate==25000))?;
 check(read64(d,20)?==120000&&read64(d,28)?==40000)?;Ok(rate)
}
fn key(a:&AccountInfo,k:Pubkey)->ProgramResult{check(*a.key==k)}
fn pda(a:&AccountInfo,seeds:&[&[u8]],program:&Pubkey)->ProgramResult{key(a,Pubkey::find_program_address(seeds,program).0)}
fn ata(a:&AccountInfo,owner:&Pubkey,mint:&Pubkey)->ProgramResult{pda(a,&[owner.as_ref(),TOKEN.as_ref(),mint.as_ref()],&ATA)}
fn token(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey)->Result<u64,ProgramError>{
 check(*a.owner==TOKEN)?;let d=a.try_borrow_data()?;
 check(d.len()==165)?;
 check(read_key(&d,0)?==*mint&&read_key(&d,32)?==*owner&&d[108]==1)?;
 // No external delegate or close authority may act on campaign custody.
 check(d[72..76]==[0;4]&&d[129..133]==[0;4])?;read64(&d,64)
}
fn mint(a:&AccountInfo,supply:u64,authority:Option<&Pubkey>,decimals:u8)->ProgramResult{
 check(*a.owner==TOKEN)?;let d=a.try_borrow_data()?;check(d.len()==82)?;
 check(d[45]==1&&d[44]==decimals&&read64(&d,36)?==supply)?;
 match authority{Some(k)=>check(d[..4]==[1,0,0,0]&&read_key(&d,4)?==*k),None=>check(d[..4]==[0;4])}
}
fn cpi<'a>(a:&[AccountInfo<'a>],program:usize,spec:&[(usize,bool,bool)],data:Vec<u8>,seeds:&[&[u8]])->ProgramResult{
 let keys=spec.iter().map(|(i,s,w)|if *w{AccountMeta::new(*a[*i].key,*s)}else{AccountMeta::new_readonly(*a[*i].key,*s)}).collect();
 let mut infos:Vec<AccountInfo<'a>>=spec.iter().map(|(i,_,_)|a[*i].clone()).collect();infos.push(a[program].clone());
 invoke_signed(&Instruction{program_id:*a[program].key,accounts:keys,data},&infos,&[seeds])
}
fn native_vault_surplus(lamports:u64,rent:u64)->u64{lamports.saturating_sub(rent)}
fn native_sync<'a>(a:&[AccountInfo<'a>])->ProgramResult{invoke(&Instruction{program_id:TOKEN,accounts:vec![AccountMeta::new(*a[5].key,false)],data:vec![17]},&[a[5].clone(),a[11].clone()])}
pub(super) fn execute(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 check(body.is_empty())?;
 let mut c=Campaign::read(a.first().ok_or(ProgramError::NotEnoughAccountKeys)?,program)?;
 if a.len()!=launch_account_count(&c){return Err(err(E_LAUNCH_ACCOUNT_COUNT))}
 let now=Clock::get()?.unix_timestamp;
 check(ready(&c,now)&&a[0].try_borrow_data()?[98]==1&&a[1].is_signer&&a[6].is_signer)?;
 let(authority,bump)=Pubkey::find_program_address(&[b"launch_authority",a[0].key.as_ref()],program);
 key(&a[2],authority)?;check(*a[2].owner==system_program::id()&&a[2].data_is_empty())?;
 let bump_seed=[bump];let seeds:&[&[u8]]=&[b"launch_authority",a[0].key.as_ref(),&bump_seed];
 for(i,k)in[(3,c.child_mint),(11,TOKEN),(12,ATA),(13,system_program::id()),(14,solana_program::sysvar::rent::id()),(15,CPMM),(23,FEE),(25,LOCK),(26,LOCK_AUTH),(27,METADATA),(28,WSOL)]{key(&a[i],k)?;}
 for i in [11,12,13,15,25,27]{check(a[i].executable)?;}
 check(c.child_mint!=WSOL&&*a[6].key!=c.child_mint)?;
 check(a[18].data_is_empty()&&*a[18].owner==system_program::id())?;
 check(a[6].data_is_empty()&&*a[6].owner==system_program::id())?;
 ata(&a[4],&authority,&c.child_mint)?;ata(&a[5],&authority,&WSOL)?;
 mint(&a[3],c.supply,Some(&authority),6)?;
 let freeze={let d=a[3].try_borrow_data()?;if d[46..50]==[0;4]{false}else{check(d[46..50]==[1,0,0,0]&&read_key(&d,50)?==authority)?;true}};
 check(token(&a[4],&c.child_mint,&authority)?==c.supply)?;
 token(&a[5],&WSOL,&authority)?;
 // Synchronize donated WSOL before computing the source balance. Only the
 // settled contribution is moved into the new pool; donations stay in custody.
 native_sync(a)?;let prior_wsol=token(&a[5],&WSOL,&authority)?;
 {check(*a[16].owner==CPMM)?;let d=a[16].try_borrow_data()?;amm_config_rate(&d)?;}
 let (m0,m1)=if c.child_mint<WSOL{(c.child_mint,WSOL)}else{(WSOL,c.child_mint)};
 pda(&a[17],&[b"vault_and_lp_mint_auth_seed"],&CPMM)?;
 check(CONFIGS.contains(a[16].key)&&*a[16].owner==CPMM)?;let config=*a[16].key;
 pda(&a[18],&[b"pool",config.as_ref(),m0.as_ref(),m1.as_ref()],&CPMM)?;
 pda(&a[19],&[b"pool_lp_mint",a[18].key.as_ref()],&CPMM)?;
 ata(&a[20],&authority,a[19].key)?;
 pda(&a[21],&[b"pool_vault",a[18].key.as_ref(),m0.as_ref()],&CPMM)?;
 pda(&a[22],&[b"pool_vault",a[18].key.as_ref(),m1.as_ref()],&CPMM)?;
 pda(&a[24],&[b"observation",a[18].key.as_ref()],&CPMM)?;
 ata(&a[7],a[0].key,a[6].key)?;ata(&a[9],&LOCK_AUTH,a[19].key)?;
 pda(&a[8],&[b"locked_liquidity",a[6].key.as_ref()],&LOCK)?;
 pda(&a[10],&[b"metadata",METADATA.as_ref(),a[6].key.as_ref()],&METADATA)?;
 // Canonical vault addresses can be pre-funded by anybody. Raydium preserves
 // lamports above SPL account rent; a WSOL vault counts that surplus as native
 // liquidity. Its donation must not permanently block this campaign's pool.
 for i in [21,22]{check(*a[i].owner==system_program::id()&&a[i].data_is_empty())?;}
 let native_vault=if m0==WSOL{21}else{22};
 let donated_native=native_vault_surplus(a[native_vault].lamports(),Rent::get()?.minimum_balance(165));
 let liability=c.total.checked_sub(c.settled_accepted).and_then(|n|n.checked_sub(c.refunded)).ok_or(err(10))?;
 let reserve=add(Rent::get()?.minimum_balance(CAMPAIGN_LEN),liability)?;
 let balance=a[0].lamports().checked_sub(c.settled_accepted).ok_or(ProgramError::InsufficientFunds)?;check(balance>=reserve)?;
 // Credit the empty System-owned signer, then use System transfer to wrap.
 // Include the campaign debit in the CPI account set so the runtime observes
 // both sides of the direct movement before executing the signed transfer.
 // Unlike SPL SyncNative, System transfer accepts additional accounts.
 let target=add(a[2].lamports(),c.settled_accepted)?;
 **a[0].try_borrow_mut_lamports()?=balance;**a[2].try_borrow_mut_lamports()?=target;
 let funding=system_instruction::transfer(a[2].key,a[5].key,c.settled_accepted);
 cpi(a,13,&[(2,true,true),(5,false,true),(0,false,true)],funding.data,seeds)?;
 native_sync(a)?;check(token(&a[5],&WSOL,&authority)?==add(prior_wsol,c.settled_accepted)?)?;
 let base=c.supply/10000*4350;let(amount0,amount1,source0,source1,mi0,mi1)=if m0==c.child_mint{(base,c.settled_accepted,4,5,3,28)}else{(c.settled_accepted,base,5,4,28,3)};
 let mut init=vec![175,175,109,31,13,152,155,237];for v in [amount0,amount1,0]{init.extend_from_slice(&v.to_le_bytes());}
 cpi(a,15,&[(2,true,true),(16,false,false),(17,false,false),(18,false,true),(mi0,false,false),(mi1,false,false),(19,false,true),(source0,false,true),(source1,false,true),(20,false,true),(21,false,true),(22,false,true),(23,false,true),(24,false,true),(11,false,false),(11,false,false),(11,false,false),(12,false,false),(13,false,false),(14,false,false)],init,seeds)?;
 let lp_amount=token(&a[20],a[19].key,&authority)?;check(lp_amount>0)?;
 let mut lock_data=vec![216,157,29,78,38,51,31,26];lock_data.extend_from_slice(&lp_amount.to_le_bytes());lock_data.push(0);
 cpi(a,25,&[(26,false,false),(1,true,true),(2,true,false),(0,false,false),(6,true,true),(7,false,true),(18,false,false),(8,false,true),(19,false,false),(20,false,true),(9,false,true),(21,false,true),(22,false,true),(10,false,true),(14,false,false),(13,false,false),(11,false,false),(12,false,false),(27,false,false)],lock_data,seeds)?;
 // SPL SetAuthority encodes authority kind then an absent optional key.
 cpi(a,11,&[(3,false,true),(2,true,false)],vec![6,0,0],seeds)?;
 if freeze{cpi(a,11,&[(3,false,true),(2,true,false)],vec![6,1,0],seeds)?;}
 mint(&a[3],c.supply,None,6)?;{let d=a[3].try_borrow_data()?;check(d[46..50]==[0;4])?;}
 check(token(&a[4],&c.child_mint,&authority)?==c.supply-base)?;
 check(token(&a[5],&WSOL,&authority)?==prior_wsol)?;
 check(token(&a[20],a[19].key,&authority)?==0)?;
 check(token(&a[9],a[19].key,&LOCK_AUTH)?==lp_amount)?;
 check(token(&a[7],a[6].key,a[0].key)?==1)?;mint(&a[6],1,None,0)?;
 check(*a[8].owner==LOCK&&!a[8].data_is_empty())?;
 let expected0=if m0==WSOL{add(amount0,donated_native)?}else{amount0};
 let expected1=if m1==WSOL{add(amount1,donated_native)?}else{amount1};
 check(token(&a[21],&m0,a[17].key)?==expected0&&token(&a[22],&m1,a[17].key)?==expected1)?;
 {check(*a[18].owner==CPMM)?;let d=a[18].try_borrow_data()?;check(d.len()==637)?;
 check(d[..8]==solana_program::hash::hash(b"account:PoolState").to_bytes()[..8])?;
 for(at,k)in[(8,config),(40,authority),(72,*a[21].key),(104,*a[22].key),(136,*a[19].key),(168,m0),(200,m1),(232,TOKEN),(264,TOKEN),(296,*a[24].key)]{check(read_key(&d,at)?==k)?;}
 check(d[390]==0&&read64(&d,333)?==add(lp_amount,100)?)?;}
 check(a[0].lamports()>=reserve)?;
 c.phase=3;c.launch_time=now;c.pool=*a[18].key;c.fee_nft=*a[6].key;c.write(&a[0])?;
 if c.distribution_program==Pubkey::default(){return Ok(())}
 // The distribution program reads phase 3 and the launch time from the campaign, so the launched state is
 // persisted first. A failed activation fails the whole instruction and rolls that write back.
 activate_distribution(program,a,&c,&authority,seeds)?;
 c.distribution_activated=true;c.write(&a[0])
}
/// Activates the recorded distribution program for a campaign whose pool and lock are already in place. The four
/// vault ATAs must exist (error 44 otherwise): the pool creation and the LP lock leave too little of the runtime's
/// nested-instruction budget for account creation here, so the keeper creates them before the launch. The
/// distribution program's `activate` (tag 0, prior counters all zero) creates its record (rent from the keeper),
/// moves 43.5 % / 5 % / 5 % / 3 % of the supply from the child custody ATA into the vaults with the launch
/// authority PDA as the transfer signer, and burns anything a vault held beforehand. Afterwards every vault, the
/// custody, the mint and the record are read back against the allocation table.
pub(super) fn activate_distribution<'a>(program:&Pubkey,a:&[AccountInfo<'a>],c:&Campaign,authority:&Pubkey,seeds:&[&[u8]])->ProgramResult{
 let distribution_program=&a[29];
 if *distribution_program.key!=c.distribution_program||!distribution_program.executable{return Err(err(E_DISTRIBUTION_PROGRAM_INVALID))}
 pda(&a[30],&[b"parents",a[0].key.as_ref()],program)?;check(*a[30].owner==*program)?;
 pda(&a[31],&[b"distribution",a[0].key.as_ref()],&c.distribution_program)?;
 check(*a[31].owner==system_program::id()&&a[31].data_is_empty())?;
 let mut authorities=[Pubkey::default();4];
 for purpose in 0..4usize{
  authorities[purpose]=Pubkey::find_program_address(&[b"vault",a[0].key.as_ref(),&[purpose as u8]],&c.distribution_program).0;
  key(&a[32+purpose],authorities[purpose])?;ata(&a[36+purpose],&authorities[purpose],&c.child_mint)?;
  check(a[36+purpose].key!=a[4].key)?;
  if a[36+purpose].data_is_empty(){return Err(err(E_VAULT_NOT_CREATED))}
  token(&a[36+purpose],&c.child_mint,&authorities[purpose])?;
 }
 let mut data=vec![DISTRIBUTION_TAG_ACTIVATE];data.extend_from_slice(&[0u8;32]);
 // kids-distribution `activate` accounts: 0 signer (launch authority), 1 payer, 2 campaign, 3 parents, 4 child mint,
 // 5 source token account, 6 distribution PDA, 7..10 vault authorities, 11..14 vaults, 15 Token, 16 System.
 cpi(a,29,&[(2,true,false),(1,true,true),(0,false,false),(30,false,false),(3,false,true),(4,false,true),(31,false,true),(32,false,false),(33,false,false),(34,false,false),(35,false,false),(36,false,true),(37,false,true),(38,false,true),(39,false,true),(11,false,false),(13,false,false)],data,seeds)?;
 verify_activation(program,a,c,authority,&authorities)
}
/// Read-back after the activation CPI: custody holds only the dust, every vault holds its allocation, the mint
/// still has the original supply and no authorities, and the distribution record belongs to the recorded program.
pub(super) fn verify_activation(program:&Pubkey,a:&[AccountInfo],c:&Campaign,authority:&Pubkey,authorities:&[Pubkey;4])->ProgramResult{
 let allocation=vault_allocations(c.supply);
 funded(token(&a[4],&c.child_mint,authority)?==custody_after_activation(c.supply)?)?;
 for purpose in 0..4usize{funded(token(&a[36+purpose],&c.child_mint,&authorities[purpose])?==allocation[purpose])?;}
 mint(&a[3],c.supply,None,6)?;{let d=a[3].try_borrow_data()?;funded(d[46..50]==[0;4])?;}
 funded(*a[31].owner==c.distribution_program)?;
 let record=a[31].try_borrow_data()?;distribution_record_matches(&record,a[0].key,c,program,&allocation)
}
/// The distribution program's record after activation must name this campaign, mint and program, carry the
/// original supply and the allocation table, and be flagged active.
pub(super) fn distribution_record_matches(d:&[u8],campaign:&Pubkey,c:&Campaign,program:&Pubkey,allocation:&[u64;4])->ProgramResult{
 funded(d.len()==DISTRIBUTION_LEN&&&d[..8]==DISTRIBUTION_MAGIC)?;
 funded(read_key(d,DISTRIBUTION_OFF_CAMPAIGN)?==*campaign&&read_key(d,DISTRIBUTION_OFF_MINT)?==c.child_mint&&read_key(d,DISTRIBUTION_OFF_LAUNCH_PROGRAM)?==*program)?;
 funded(read64(d,DISTRIBUTION_OFF_SUPPLY)?==c.supply&&d[DISTRIBUTION_OFF_FLAGS]&DISTRIBUTION_FLAG_ACTIVATED!=0)?;
 for purpose in 0..4{funded(read64(d,DISTRIBUTION_OFF_ALLOCATION+8*purpose)?==allocation[purpose])?;}
 Ok(())
}
#[cfg(test)]mod tests{
 fn amm_config(index:u16,rate:u64,disabled:u8)->Vec<u8>{let mut d=vec![0u8;236];d[..8].copy_from_slice(&solana_program::hash::hash(b"account:AmmConfig").to_bytes()[..8]);d[9]=disabled;d[10..12].copy_from_slice(&index.to_le_bytes());d[12..20].copy_from_slice(&rate.to_le_bytes());d[20..28].copy_from_slice(&120000u64.to_le_bytes());d[28..36].copy_from_slice(&40000u64.to_le_bytes());d}
 #[test]fn launch_accepts_both_approved_fee_tiers_and_nothing_else(){
  assert_eq!(amm_config_rate(&amm_config(2,20000,0)).unwrap(),20000);
  assert_eq!(amm_config_rate(&amm_config(7,25000,0)).unwrap(),25000);
  assert!(amm_config_rate(&amm_config(7,20000,0)).is_err(),"index and rate are bound");
  assert!(amm_config_rate(&amm_config(2,25000,0)).is_err());
  assert!(amm_config_rate(&amm_config(3,30000,0)).is_err(),"3 % is not an approved tier");
  assert!(amm_config_rate(&amm_config(7,25000,1)).is_err(),"disabled config");
  let mut wrong_fund=amm_config(7,25000,0);wrong_fund[28..36].copy_from_slice(&50000u64.to_le_bytes());assert!(amm_config_rate(&wrong_fund).is_err());
  assert!(amm_config_rate(&amm_config(7,25000,0)[..200]).is_err());
 }
 use super::*;
 #[test]fn predicted_native_vault_donations_preserve_surplus_only(){let rent=2_039_280;assert_eq!(native_vault_surplus(1,rent),0);assert_eq!(native_vault_surplus(rent,rent),0);assert_eq!(native_vault_surplus(rent+1,rent),1);assert_eq!(native_vault_surplus(rent+1_000_000,rent),1_000_000);assert_eq!(native_vault_surplus(u64::MAX,rent),u64::MAX-rent);}
 #[test]fn campaign_custody_rejects_delegate_frozen_and_close_authority(){
  let mint_key=Pubkey::new_unique();let owner=Pubkey::new_unique();let address=Pubkey::new_unique();
  for mutation in [0,1,2,3,4]{let mut data=vec![0u8;165];data[..32].copy_from_slice(mint_key.as_ref());data[32..64].copy_from_slice(owner.as_ref());put64(&mut data,64,42);data[108]=1;
   match mutation{1=>data[72]=1,2=>data[108]=2,3=>data[129]=1,4=>data[32]^=1,_=>{}}
   let mut lamports=1;let account=AccountInfo::new(&address,false,true,&mut lamports,&mut data,&TOKEN,false,0);
   if mutation==0{assert_eq!(token(&account,&mint_key,&owner).unwrap(),42)}else{assert!(token(&account,&mint_key,&owner).is_err());}
  }
 }
 #[test]fn mint_supply_authority_and_decimals_are_bound(){
  let authority=Pubkey::new_unique();let key=Pubkey::new_unique();
  for mutation in [0,1,2,3]{let mut data=vec![0u8;82];data[0]=1;data[4..36].copy_from_slice(authority.as_ref());put64(&mut data,36,10000);data[44]=6;data[45]=1;
   match mutation{1=>put64(&mut data,36,10001),2=>data[4]^=1,3=>data[44]=9,_=>{}}
   let mut lamports=1;let account=AccountInfo::new(&key,false,true,&mut lamports,&mut data,&TOKEN,false,0);
   assert_eq!(mint(&account,10000,Some(&authority),6).is_ok(),mutation==0);
  }
 }
}
