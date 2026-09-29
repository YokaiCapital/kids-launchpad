//! Tag 6: the atomic launch. Mirrors the reviewed path of `programs/atomic-launch/src/launch.rs` with the sealed
//! terms in place of that program's constants: the accepted SOL is wrapped, a Raydium CPMM pool is created on the
//! sealed `amm_program` and `amm_config` with the launch authority PDA as pool creator, every LP token is locked
//! forever through the sealed `lock_program` (the fee NFT is held by the campaign PDA), the mint and freeze
//! authorities are revoked, and every account is read back before the campaign is written. Any failed check fails
//! the whole instruction, so no partial launch can exist.
//!
//! Supply split (`policy::split`): the liquidity reserve (its bps share plus the `supply % 10000` dust) goes to
//! the pool with the accepted SOL; participants, dev and, in Family mode, the two parent reserves stay in the
//! launch custody for the claims of tags 7 and 8 (Standard has zero parent reserves).
use crate::{handlers::*,policy::*,state::*,*};
use solana_program::{instruction::{AccountMeta,Instruction},program::invoke_signed};

/// Tag 6 accounts: 0 campaign, 1 keeper (signer, pays the lock rent), 2 launch authority PDA (System-owned, empty;
/// holds the sponsored setup budget: pool rent and the create-pool fee), 3 child mint, 4 child custody ATA (holds
/// the whole supply), 5 WSOL custody ATA, 6 fee NFT mint (fresh signer), 7 fee NFT ATA of the campaign, 8 locked
/// liquidity PDA, 9 lock authority's LP ATA, 10 fee NFT metadata, 11 Token, 12 Associated Token, 13 System,
/// 14 Rent, 15 the sealed AMM program, 16 the sealed AMM config, 17 AMM authority, 18 pool state, 19 LP mint,
/// 20 launch authority's LP ATA, 21 vault 0, 22 vault 1, 23 create-pool fee receiver, 24 observation, 25 the
/// sealed lock program, 26 lock authority, 27 Metadata, 28 WSOL mint.
pub const LAUNCH_ACCOUNTS:usize=29;
pub const CPMM_AUTH_SEED:&[u8]=b"vault_and_lp_mint_auth_seed";
pub const CPMM_POOL_SEED:&[u8]=b"pool";
pub const CPMM_LP_MINT_SEED:&[u8]=b"pool_lp_mint";
pub const CPMM_VAULT_SEED:&[u8]=b"pool_vault";
pub const CPMM_OBSERVATION_SEED:&[u8]=b"observation";
pub const LOCK_AUTH_SEED:&[u8]=b"lock_cp_authority_seed";
pub const LOCKED_LIQUIDITY_SEED:&[u8]=b"locked_liquidity";
pub const METADATA_SEED:&[u8]=b"metadata";
/// Anchor discriminators (`sha256("global:<name>")[..8]`, `sha256("account:<Name>")[..8]`).
pub const CPMM_INITIALIZE:[u8;8]=[175,175,109,31,13,152,155,237];
pub const LOCK_CP_LIQUIDITY:[u8;8]=[216,157,29,78,38,51,31,26];
pub fn pool_state_discriminator()->[u8;8]{solana_program::hash::hash(b"account:PoolState").to_bytes()[..8].try_into().unwrap()}
pub fn locked_state_discriminator()->[u8;8]{solana_program::hash::hash(b"account:LockedCpLiquidityState").to_bytes()[..8].try_into().unwrap()}
/// Raydium CPMM `PoolState` (637 bytes): 8 amm_config, 40 pool_creator, 72 token_0_vault, 104 token_1_vault,
/// 136 lp_mint, 168 token_0_mint, 200 token_1_mint, 232 token_0_program, 264 token_1_program, 296 observation,
/// 328 auth_bump, 329 status, 330 lp decimals, 331 mint_0 decimals, 332 mint_1 decimals, 333 lp_supply,
/// 341 protocol_fees_0, 349 protocol_fees_1, 357 fund_fees_0, 365 fund_fees_1, 373 open_time, 381 recent_epoch,
/// 389 creator_fee_on, 390 enable_creator_fee, 391 padding, 397 creator_fees_0, 405 creator_fees_1.
pub const POOL_STATE_LEN:usize=637;
pub const POOL_OFF_STATUS:usize=329;
pub const POOL_OFF_LP_SUPPLY:usize=333;
pub const POOL_OFF_PROTOCOL_FEES_0:usize=341;
pub const POOL_OFF_PROTOCOL_FEES_1:usize=349;
pub const POOL_OFF_FUND_FEES_0:usize=357;
pub const POOL_OFF_FUND_FEES_1:usize=365;
pub const POOL_OFF_ENABLE_CREATOR_FEE:usize=390;
pub const POOL_OFF_CREATOR_FEES_0:usize=397;
pub const POOL_OFF_CREATOR_FEES_1:usize=405;
/// Raydium lock `LockedCpLiquidityState` (256 bytes): 8 locked_lp_amount, 16 claimed, 24 unclaimed, 32 last_lp,
/// 40 last_k u128, 56 recent_epoch, 64 pool_id, 96 fee_nft_mint, 128 locked_owner, 160 locked_lp_mint, 192 padding.
pub const LOCKED_STATE_LEN:usize=256;
pub const LOCKED_OFF_LP_AMOUNT:usize=8;
pub const LOCKED_OFF_POOL:usize=64;
pub const LOCKED_OFF_FEE_NFT_MINT:usize=96;
pub const LOCKED_OFF_OWNER:usize=128;
pub const LOCKED_OFF_LP_MINT:usize=160;
/// LP units the CPMM program keeps locked in the pool at initialization; the creator receives sqrt(a0 × a1) minus this.
pub const CPMM_INITIAL_LOCKED_LP:u64=100;
/// Body of the CPMM `initialize` the launch sends: the discriminator, `init_amount_0`, `init_amount_1` and
/// `open_time`, 32 bytes. Plain `initialize` takes no creator-fee argument and writes the pool with
/// `enable_creator_fee` off; the only pool creation that can switch it on is `initialize_with_permission`, whose
/// body carries a `creator_fee_on` argument after `open_time` (Raydium cp-swap 0.2.0).
pub const CPMM_INITIALIZE_LEN:usize=32;
pub fn cpmm_initialize_data(amount0:u64,amount1:u64,open_time:u64)->Vec<u8>{
 let mut data=CPMM_INITIALIZE.to_vec();for v in [amount0,amount1,open_time]{data.extend_from_slice(&v.to_le_bytes());}data
}
/// True when `data` is exactly a plain `initialize` body. Checked before the pool-creation CPI so that no other
/// instruction, and no extra argument, can reach the AMM program from this launch.
pub fn cpmm_initialize_keeps_creator_fee_off(data:&[u8])->bool{data.len()==CPMM_INITIALIZE_LEN&&data[..8]==CPMM_INITIALIZE}

fn account(a:&AccountInfo,k:Pubkey)->ProgramResult{require(*a.key==k,E_LAUNCH_ACCOUNT)}
fn pda(a:&AccountInfo,seeds:&[&[u8]],program:&Pubkey)->ProgramResult{account(a,Pubkey::find_program_address(seeds,program).0)}
fn ata(a:&AccountInfo,owner:&Pubkey,mint:&Pubkey)->ProgramResult{account(a,associated_token_address(owner,mint))}
fn untouched(a:&AccountInfo)->ProgramResult{require(*a.owner==system_program::id()&&a.data_is_empty(),E_LAUNCH_ACCOUNT)}
fn token(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey)->Result<u64,ProgramError>{token_account(a,mint,owner).map_err(|_|err(E_LAUNCH_ACCOUNT))}
fn verify(value:bool)->ProgramResult{require(value,E_LAUNCH_VERIFY)}
/// A classic mint with exactly `supply`, `decimals`, and no mint authority when `revoked`.
fn mint_reads(a:&AccountInfo,supply:u64,decimals:u8,revoked_mint_authority:bool)->Result<bool,ProgramError>{
 if *a.owner!=TOKEN_PROGRAM{return Ok(false)}let d=a.try_borrow_data()?;
 Ok(d.len()==82&&d[45]==1&&d[44]==decimals&&read64(&d,36)?==supply&&(!revoked_mint_authority||d[..4]==[0;4]))
}
fn freeze_authority_revoked(a:&AccountInfo)->Result<bool,ProgramError>{let d=a.try_borrow_data()?;Ok(d.len()==82&&d[46..50]==[0;4])}
pub fn cpi<'a>(a:&[AccountInfo<'a>],program:usize,spec:&[(usize,bool,bool)],data:Vec<u8>,seeds:&[&[u8]])->ProgramResult{
 let keys=spec.iter().map(|(i,s,w)|if *w{AccountMeta::new(*a[*i].key,*s)}else{AccountMeta::new_readonly(*a[*i].key,*s)}).collect();
 let mut infos:Vec<AccountInfo<'a>>=spec.iter().map(|(i,_,_)|a[*i].clone()).collect();infos.push(a[program].clone());
 invoke_signed(&Instruction{program_id:*a[program].key,accounts:keys,data},&infos,&[seeds])
}
/// Lamports a WSOL vault would count as native liquidity beyond its rent: a donation to the canonical vault address.
pub fn native_vault_surplus(lamports:u64,rent:u64)->u64{lamports.saturating_sub(rent)}
fn native_sync<'a>(a:&[AccountInfo<'a>])->ProgramResult{invoke(&Instruction{program_id:TOKEN_PROGRAM,accounts:vec![AccountMeta::new(*a[5].key,false)],data:vec![17]},&[a[5].clone(),a[11].clone()])}

pub fn execute(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(body.is_empty(),E_TERMS_INVALID)?;require(a.len()==LAUNCH_ACCOUNTS,E_ACCOUNT_COUNT)?;
 let mut c=Campaign::read(&a[0],program)?;
 let now=now()?;require(c.ready(now),E_NOT_READY)?;
 // Refund liability of the settled excess that is still unpaid stays in the campaign, together with its rent.
 let liability=c.state.total.checked_sub(c.state.settled_accepted).and_then(|n|n.checked_sub(c.state.refunded)).ok_or(err(E_OVERFLOW))?;
 let accepted=c.state.settled_accepted;
 launch_body(program,a,&mut c,now,accepted,liability)
}
/// The launch itself, from the signer checks to the final record write, for a campaign whose readiness the caller has
/// established: `accepted` lamports leave the campaign for the pool and `liability` lamports (plus rent) must remain.
/// Tag 6 passes the settled total and the unpaid settled excess; the funding-first launch (version 2) passes the sealed
/// accepted target and its own liability. The first `LAUNCH_ACCOUNTS` accounts are the tag-6 accounts; a caller may
/// append more accounts after them, they are ignored here.
pub fn launch_body<'a>(program:&Pubkey,a:&[AccountInfo<'a>],c:&mut Campaign,now:i64,accepted:u64,liability:u64)->ProgramResult{
 require(a.len()>=LAUNCH_ACCOUNTS,E_ACCOUNT_COUNT)?;let t=&c.terms;
 if !a[1].is_signer||!a[6].is_signer{return Err(ProgramError::MissingRequiredSignature)}
 // The distribution program of this repository reads the version-1 campaign only; a campaign that sealed one
 // stays unlaunched (and refundable after its launch deadline) until an activation interface for this layout exists.
 require(!t.has_distribution(),E_DISTRIBUTION_NOT_WIRED)?;
 let(authority,bump)=c.launch_authority(a[0].key,program);
 if *a[2].key!=authority{return Err(ProgramError::InvalidSeeds)}untouched(&a[2])?;
 let bump_seed=[bump];let seeds:&[&[u8]]=&[LAUNCH_AUTHORITY_SEED,a[0].key.as_ref(),&bump_seed];
 child_mint_matches(&a[3],t,&authority)?;
 amm_config_account(&a[16],t)?;
 for(i,k)in[(11,TOKEN_PROGRAM),(12,ASSOCIATED_TOKEN_PROGRAM),(13,system_program::id()),(14,solana_program::sysvar::rent::id()),(15,t.amm_program),(23,CPMM_CREATE_POOL_FEE_RECEIVER),(25,t.lock_program),(27,METADATA_PROGRAM),(28,WSOL)]{account(&a[i],k)?;}
 for i in [11,12,13,15,25,27]{require(a[i].executable,E_LAUNCH_ACCOUNT)?;}
 require(*a[6].key!=t.child_mint&&*a[6].key!=WSOL,E_LAUNCH_ACCOUNT)?;untouched(&a[6])?;untouched(&a[18])?;
 ata(&a[4],&authority,&t.child_mint)?;ata(&a[5],&authority,&WSOL)?;
 // Mint and freeze authorities may already be revoked at creation; when still set they are the launch authority
 // (checked by `child_mint_matches`) and are revoked below.
 let(mintable,freezable)={let d=a[3].try_borrow_data()?;(d[..4]!=[0;4],d[46..50]!=[0;4])};
 require(token(&a[4],&t.child_mint,&authority)?==t.supply,E_LAUNCH_ACCOUNT)?;
 token(&a[5],&WSOL,&authority)?;
 let(m0,m1)=if t.child_mint<WSOL{(t.child_mint,WSOL)}else{(WSOL,t.child_mint)};
 pda(&a[17],&[CPMM_AUTH_SEED],&t.amm_program)?;
 pda(&a[18],&[CPMM_POOL_SEED,t.amm_config.as_ref(),m0.as_ref(),m1.as_ref()],&t.amm_program)?;
 pda(&a[19],&[CPMM_LP_MINT_SEED,a[18].key.as_ref()],&t.amm_program)?;
 ata(&a[20],&authority,a[19].key)?;
 pda(&a[21],&[CPMM_VAULT_SEED,a[18].key.as_ref(),m0.as_ref()],&t.amm_program)?;
 pda(&a[22],&[CPMM_VAULT_SEED,a[18].key.as_ref(),m1.as_ref()],&t.amm_program)?;
 pda(&a[24],&[CPMM_OBSERVATION_SEED,a[18].key.as_ref()],&t.amm_program)?;
 let lock_authority=Pubkey::find_program_address(&[LOCK_AUTH_SEED],&t.lock_program).0;account(&a[26],lock_authority)?;
 ata(&a[7],a[0].key,a[6].key)?;ata(&a[9],&lock_authority,a[19].key)?;
 pda(&a[8],&[LOCKED_LIQUIDITY_SEED,a[6].key.as_ref()],&t.lock_program)?;
 pda(&a[10],&[METADATA_SEED,METADATA_PROGRAM.as_ref(),a[6].key.as_ref()],&METADATA_PROGRAM)?;
 // Canonical vault addresses can be pre-funded by anybody; a WSOL vault counts lamports above its rent as native
 // liquidity, so that surplus is expected in the read-back instead of blocking the launch.
 for i in [21,22]{untouched(&a[i])?;}
 let reserve=add(Rent::get()?.minimum_balance(CAMPAIGN_LEN),liability)?;
 let balance=a[0].lamports().checked_sub(accepted).ok_or(err(E_LAUNCH_FUNDS))?;require(balance>=reserve,E_LAUNCH_FUNDS)?;
 // Every identity and funds check is done; the first CPI follows. Donated WSOL is synchronized before the source
 // balance is read, so only the accepted total moves into the pool and a donation stays in custody.
 native_sync(a)?;let prior_wsol=token(&a[5],&WSOL,&authority)?;
 let token_rent=Rent::get()?.minimum_balance(165);
 let native_vault=if m0==WSOL{21}else{22};
 let donated_native=native_vault_surplus(a[native_vault].lamports(),token_rent);
 // The campaign (program-owned) is debited directly and the System-owned launch authority credited, then the
 // authority wraps the amount with a signed System transfer that lists the campaign so the runtime sees both sides.
 let target=add(a[2].lamports(),accepted)?;
 **a[0].try_borrow_mut_lamports()?=balance;**a[2].try_borrow_mut_lamports()?=target;
 cpi(a,13,&[(2,true,true),(5,false,true),(0,false,true)],system_instruction::transfer(a[2].key,a[5].key,accepted).data,seeds)?;
 native_sync(a)?;verify(token(&a[5],&WSOL,&authority)?==add(prior_wsol,accepted)?)?;
 let split=t.split()?;let liquidity=split.liquidity;
 let(amount0,amount1,source0,source1,mint0,mint1)=if m0==t.child_mint{(liquidity,accepted,4,5,3,28)}else{(accepted,liquidity,5,4,28,3)};
 let init=cpmm_initialize_data(amount0,amount1,0);require(cpmm_initialize_keeps_creator_fee_off(&init),E_LAUNCH_VERIFY)?;
 // CPMM `initialize`: creator, amm_config, authority, pool_state, token_0_mint, token_1_mint, lp_mint, creator_token_0,
 // creator_token_1, creator_lp_token, token_0_vault, token_1_vault, create_pool_fee, observation_state, token_program,
 // token_0_program, token_1_program, associated_token_program, system_program, rent.
 cpi(a,15,&[(2,true,true),(16,false,false),(17,false,false),(18,false,true),(mint0,false,false),(mint1,false,false),(19,false,true),(source0,false,true),(source1,false,true),(20,false,true),(21,false,true),(22,false,true),(23,false,true),(24,false,true),(11,false,false),(11,false,false),(11,false,false),(12,false,false),(13,false,false),(14,false,false)],init,seeds)?;
 let lp_amount=token(&a[20],a[19].key,&authority)?;verify(lp_amount>0)?;
 let mut lock=LOCK_CP_LIQUIDITY.to_vec();lock.extend_from_slice(&lp_amount.to_le_bytes());lock.push(0);
 // Lock `lock_cp_liquidity`: authority, payer, liquidity_owner, fee_nft_owner, fee_nft_mint, fee_nft_account, pool_state,
 // locked_liquidity, lp_mint, liquidity_owner_lp, locked_lp_vault, token_0_vault, token_1_vault, metadata_account, rent,
 // system_program, token_program, associated_token_program, metadata_program. Body: lp_amount, with_metadata = false.
 cpi(a,25,&[(26,false,false),(1,true,true),(2,true,false),(0,false,false),(6,true,true),(7,false,true),(18,false,false),(8,false,true),(19,false,false),(20,false,true),(9,false,true),(21,false,true),(22,false,true),(10,false,true),(14,false,false),(13,false,false),(11,false,false),(12,false,false),(27,false,false)],lock,seeds)?;
 // Token `SetAuthority`: authority type (0 mint tokens, 1 freeze account) then an absent new authority.
 if mintable{cpi(a,11,&[(3,false,true),(2,true,false)],vec![6,0,0],seeds)?;}
 if freezable{cpi(a,11,&[(3,false,true),(2,true,false)],vec![6,1,0],seeds)?;}
 verify(mint_reads(&a[3],t.supply,t.decimals,true)?&&freeze_authority_revoked(&a[3])?)?;
 verify(token(&a[4],&t.child_mint,&authority)?==t.supply.checked_sub(liquidity).ok_or(err(E_OVERFLOW))?)?;
 verify(token(&a[5],&WSOL,&authority)?==prior_wsol)?;
 verify(token(&a[20],a[19].key,&authority)?==0)?;
 verify(token(&a[9],a[19].key,&lock_authority)?==lp_amount)?;
 verify(token(&a[7],a[6].key,a[0].key)?==1&&mint_reads(&a[6],1,0,true)?)?;
 {verify(*a[8].owner==t.lock_program)?;let d=a[8].try_borrow_data()?;verify(d.len()==LOCKED_STATE_LEN&&d[..8]==locked_state_discriminator())?;
  verify(read64(&d,LOCKED_OFF_LP_AMOUNT)?==lp_amount)?;
  for(at,k)in[(LOCKED_OFF_POOL,*a[18].key),(LOCKED_OFF_FEE_NFT_MINT,*a[6].key),(LOCKED_OFF_OWNER,authority),(LOCKED_OFF_LP_MINT,*a[19].key)]{verify(read_key(&d,at)?==k)?;}}
 let expected0=if m0==WSOL{add(amount0,donated_native)?}else{amount0};
 let expected1=if m1==WSOL{add(amount1,donated_native)?}else{amount1};
 verify(token(&a[21],&m0,a[17].key)?==expected0&&token(&a[22],&m1,a[17].key)?==expected1)?;
 {verify(*a[18].owner==t.amm_program)?;let d=a[18].try_borrow_data()?;verify(d.len()==POOL_STATE_LEN&&d[..8]==pool_state_discriminator())?;
  for(at,k)in[(8,t.amm_config),(40,authority),(72,*a[21].key),(104,*a[22].key),(136,*a[19].key),(168,m0),(200,m1),(232,TOKEN_PROGRAM),(264,TOKEN_PROGRAM),(296,*a[24].key)]{verify(read_key(&d,at)?==k)?;}
  // A pool made by plain `initialize` has the creator fee switched off whatever its config's creator fee rate says.
  verify(d[POOL_OFF_STATUS]==0&&d[POOL_OFF_ENABLE_CREATOR_FEE]==0&&read64(&d,POOL_OFF_LP_SUPPLY)?==add(lp_amount,CPMM_INITIAL_LOCKED_LP)?)?;}
 verify(a[0].lamports()>=reserve)?;
 c.state.phase=PHASE_LIVE;c.state.launch_time=now;c.state.pool= *a[18].key;c.state.fee_nft= *a[6].key;c.write(&a[0])
}
