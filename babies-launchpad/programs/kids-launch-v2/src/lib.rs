//! KIDS public launches, program version 2: sealed-term SOL escrow for Standard and Family campaigns, proportional
//! settlement, permissionless refunds, and the state rules of the atomic launch. New campaigns only; the live
//! Family campaign stays on `programs/atomic-launch` and is never read or written by this program.
//!
//! Status (24 September 2026): create, commit, finalize, settle, refund, assert-ready, the launch (tag 6: Raydium
//! CPMM pool, permanent LP lock, authority revocation, `launch.rs`), the custody claims and the fee cycle (tags 20
//! to 26, `fees.rs`) are implemented with host tests, built for SBF and rehearsed on a localnet clone of the Raydium
//! programs (`localnet/start-v2-rehearsal.mjs`); not deployed to mainnet. Create refuses Family mode
//! (`E_FAMILY_NOT_AVAILABLE`) until a parent-claim path exists, and refuses a sealed distribution program
//! (`E_DISTRIBUTION_NOT_WIRED`) because `programs/kids-distribution` reads only the version-1 campaign layout; the
//! Family rules stay implemented and tested so the gate can lift without a layout change.
#![allow(unexpected_cfgs, deprecated)]
use solana_program::{account_info::AccountInfo,entrypoint,entrypoint::ProgramResult,program::{invoke,invoke_signed},program_error::ProgramError,pubkey::Pubkey,rent::Rent,system_instruction,system_program,sysvar::Sysvar};
#[cfg(not(feature="no-entrypoint"))]
entrypoint!(process_instruction);
pub mod policy;
pub mod state;
pub mod handlers;
pub mod launch;
pub mod fees;
#[cfg(test)]mod host_tests;
#[cfg(test)]mod vector_tests;

pub const TAG_CREATE:u8=0;
pub const TAG_COMMIT:u8=1;
pub const TAG_FINALIZE:u8=2;
pub const TAG_REFUND:u8=3;
pub const TAG_SETTLE:u8=4;
pub const TAG_ASSERT_READY:u8=5;
pub const TAG_LAUNCH:u8=6;
pub const TAG_CLAIM_PARTICIPANT:u8=7;
pub const TAG_CLAIM_DEV:u8=8;
/// Fee cycle (`fees.rs`). Tag 24 (parent buyback on a Raydium pool) is not assigned: parents are bought through
/// Jupiter (owner, 20 September 2026) against a floor derived from a Raydium pool; coin-side fees are burned
/// (owner, 23 September 2026). Tags 20, 22 and 25 need a signer (the sealed treasury for 22 and for 20 on Family campaigns, any payer for 20 on Standard campaigns, the recorded
/// operator for 25); tags 21, 23 and 26 are permissionless.
pub const TAG_FEES_INIT:u8=20;
pub const TAG_FEES_COLLECT:u8=21;
pub const TAG_FEES_ROTATE_OPERATOR:u8=22;
pub const TAG_FEES_DISTRIBUTE:u8=23;
pub const TAG_FEES_BUY_BURN:u8=25;
pub const TAG_FEES_BURN_CHILD:u8=26;

/// Error codes (`ProgramError::Custom`). Codes shared with `programs/atomic-launch` keep their numbers.
/// A sealed field is out of range or inconsistent with another sealed field.
pub const E_TERMS_INVALID:u32=1;
/// A commit after the funding deadline, or into a campaign that is no longer in phase 0.
pub const E_FUNDING_CLOSED:u32=2;
pub const E_ZERO_AMOUNT:u32=3;
/// The receipt sequence in the instruction is not the receipt's next sequence.
pub const E_RECEIPT_SEQUENCE:u32=4;
/// Finalize, settle or refund before the funding deadline.
pub const E_BEFORE_DEADLINE:u32=5;
/// The refund destination is not the receipt owner, or aliases the campaign or the receipt.
pub const E_REFUND_DESTINATION:u32=6;
pub const E_OVERFLOW:u32=10;
/// More receipts settled than registered, or more accepted than the campaign can accept.
pub const E_SETTLEMENT_COUNT:u32=11;
pub const E_NOT_READY:u32=12;
/// The genesis hash in the instruction differs from the sealed one: the client built against another network.
pub const E_NETWORK_MISMATCH:u32=13;
/// A commit before `opens_at`.
pub const E_FUNDING_NOT_OPEN_YET:u32=14;
/// `opens_at` lies more than `OPENS_AT_TOLERANCE_SECONDS` in the past at creation.
pub const E_OPENS_AT_IN_PAST:u32=15;
/// Standard terms carry parent state, Family terms lack it or carry WSOL as a parent, or tag 25 on a Standard campaign.
pub const E_MODE_PARENTS:u32=16;
/// The sealed split, vesting or fee-routing table is not the table its policy id describes.
pub const E_POLICY_TABLE:u32=17;
/// The AMM config account is not the sealed one or its contents differ from the sealed expectation.
pub const E_AMM_CONFIG:u32=18;
pub const E_ACCOUNT_COUNT:u32=19;
/// The metadata hash is zero or the URI is longer than the field, not printable ASCII, or padded with non-zero bytes.
pub const E_METADATA:u32=20;
/// A claim account is not what the campaign expects (custody, mint, destination, token program, phase).
pub const E_CLAIM_INVALID:u32=30;
pub const E_NOT_LAUNCHED:u32=31;
/// A dev claim before the launch time.
pub const E_NOT_YET_CLAIMABLE:u32=32;
/// Claims live in the distribution program once it is activated; custody claims are refused.
pub const E_DISTRIBUTION_ACTIVATED:u32=40;
/// The distribution program account is missing, not executable, not under the upgradeable loader, or is this program.
pub const E_DISTRIBUTION_PROGRAM_INVALID:u32=41;
/// A parent mint account is not a mint under the sealed token program.
pub const E_PARENT_MINT:u32=70;
/// A Token-2022 parent mint carries an extension that changes what a balance is worth or whether it can move.
pub const E_PARENT_MINT_EXTENSION:u32=71;
/// The child mint account does not match the sealed mint, supply and decimals, or has a foreign authority.
pub const E_CHILD_MINT:u32=72;
/// A fee-cycle account is not the one the campaign, the sealed terms or the fee state expect.
pub const E_FEE_ACCOUNT:u32=60;
/// Fee accounting underflow: a balance below the recorded liability, a spend above the pending budget.
pub const E_FEE_ARITHMETIC:u32=61;
/// Tag 22 (or tag 20 on a Family campaign) not signed by the sealed treasury, tag 25 not signed by the recorded operator, or an operator key
/// that is zero or the fee authority itself.
pub const E_FEE_OPERATOR:u32=63;
/// The Jupiter route bytes fail a header rule (kind, exact input, quote, slippage cap, platform fee, step count).
pub const E_FEE_ROUTE:u32=64;
/// Tag 25: `min_out` is below the floor derived from the reference pool (`policy::buyback_floor`).
pub const E_FEE_PRICE_FLOOR:u32=65;
/// Tag 25: the parent has no sealed reference pool, or the reference pool's reserves cannot quote the slice.
pub const E_FEE_REFERENCE:u32=66;
/// A tag 6 account is not the expected one (address, owner, seeds, executable flag) or a custody balance is off.
pub const E_LAUNCH_ACCOUNT:u32=80;
/// After the launch CPIs an account does not read back as the launch requires (pool, vaults, lock, mint, custody,
/// a pool with its creator fee switched on), or the pool creation the launch built is not the plain `initialize`.
pub const E_LAUNCH_VERIFY:u32=81;
/// The campaign cannot fund the accepted total and still cover its rent plus the outstanding refund liability.
pub const E_LAUNCH_FUNDS:u32=82;
/// A sealed distribution program: the activation CPI is not wired, so create refuses it (and tag 6 would).
pub const E_DISTRIBUTION_NOT_WIRED:u32=90;
/// Family mode at create: refused until an instruction pays the parent reserves (nothing could move them today).
pub const E_FAMILY_NOT_AVAILABLE:u32=91;
/// The sealed treasury is not `PLATFORM_TREASURY`.
pub const E_TREASURY_NOT_PLATFORM:u32=92;

/// How far in the past `opens_at` may lie at creation: the time between building and confirming the transaction.
pub const OPENS_AT_TOLERANCE_SECONDS:i64=60;

/// The platform treasury every campaign must seal: `treasuryWallet.address` of `deployment/MAINNET-IDENTITIES.json`
/// (`vector_tests` checks the two agree). It signs tags 20 and 22 and receives the treasury share of tag 23.
#[cfg(not(feature="localnet-treasury"))]
pub const PLATFORM_TREASURY:Pubkey=solana_program::pubkey!("91eLwFTAxkcQLPSMxbzdSFkTyEwyRYcoZk64HMZj8vX");
/// Localnet builds (`--features localnet-treasury`) take the treasury public key from `KIDS_LOCALNET_TREASURY_HEX`
/// at build time: 64 hexadecimal characters, the key's 32 bytes.
#[cfg(feature="localnet-treasury")]
pub const PLATFORM_TREASURY:Pubkey=Pubkey::new_from_array(key_from_hex(env!("KIDS_LOCALNET_TREASURY_HEX")));
/// 32 bytes from 64 hexadecimal characters, evaluated at compile time; a build with a malformed value fails.
pub const fn key_from_hex(text:&str)->[u8;32]{
 let bytes=text.as_bytes();assert!(bytes.len()==64,"a public key is 64 hexadecimal characters");
 let mut out=[0u8;32];let mut i=0;
 while i<32{out[i]=hex_digit(bytes[2*i])*16+hex_digit(bytes[2*i+1]);i+=1;}
 out
}
const fn hex_digit(c:u8)->u8{match c{b'0'..=b'9'=>c-b'0',b'a'..=b'f'=>c-b'a'+10,b'A'..=b'F'=>c-b'A'+10,_=>panic!("not a hexadecimal digit")}}
pub const BPF_LOADER_UPGRADEABLE:Pubkey=solana_program::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
pub const TOKEN_PROGRAM:Pubkey=solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM:Pubkey=solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ASSOCIATED_TOKEN_PROGRAM:Pubkey=solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const WSOL:Pubkey=solana_program::pubkey!("So11111111111111111111111111111111111111112");
/// Raydium CPMM and its permanent-lock program: the only pool venue and lock a campaign may seal.
pub const RAYDIUM_CPMM:Pubkey=solana_program::pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
pub const RAYDIUM_LOCK:Pubkey=solana_program::pubkey!("LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE");
/// Where the CPMM program sends its pool-creation fee (mainnet receiver, as `programs/atomic-launch`).
pub const CPMM_CREATE_POOL_FEE_RECEIVER:Pubkey=solana_program::pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
pub const METADATA_PROGRAM:Pubkey=solana_program::pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
pub const MEMO_PROGRAM:Pubkey=solana_program::pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/// Jupiter v6 aggregator, the parent buyback route (owner, 20 September 2026). A third-party upgradeable program:
/// the program forwards only a `route` or `route_v2` whose user accounts are the fee custody and checks the effects.
pub const JUPITER_PROGRAM:Pubkey=solana_program::pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
/// Approved AMM config tiers as (index, address, trade fee rate per 1,000,000): index 2 at 2 % is the localnet
/// clone, index 7 at 2.5 % is the mainnet tier agreed for new launches (owner, 23 September 2026).
pub const AMM_CONFIG_TIERS:[(u16,Pubkey,u64);2]=[(2,solana_program::pubkey!("2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5"),20_000),(7,solana_program::pubkey!("ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi"),25_000)];
/// Protocol and fund shares of the trade fee every approved tier carries (12 % and 4 %, per 1,000,000).
pub const AMM_PROTOCOL_FEE_RATE:u64=120_000;
pub const AMM_FUND_FEE_RATE:u64=40_000;

pub fn err(n:u32)->ProgramError{ProgramError::Custom(n)}
pub fn read64(d:&[u8],at:usize)->Result<u64,ProgramError>{Ok(u64::from_le_bytes(d.get(at..at+8).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap()))}
pub fn read_key(d:&[u8],at:usize)->Result<Pubkey,ProgramError>{Ok(Pubkey::new_from_array(d.get(at..at+32).ok_or(ProgramError::InvalidAccountData)?.try_into().unwrap()))}
pub fn put64(d:&mut[u8],at:usize,n:u64){d[at..at+8].copy_from_slice(&n.to_le_bytes());}
pub fn add(a:u64,b:u64)->Result<u64,ProgramError>{a.checked_add(b).ok_or(err(E_OVERFLOW))}
pub fn require(condition:bool,code:u32)->ProgramResult{if condition{Ok(())}else{Err(err(code))}}
pub fn system(a:&AccountInfo)->ProgramResult{if *a.key!=system_program::id(){Err(ProgramError::IncorrectProgramId)}else{Ok(())}}
pub fn is_token_program(k:&Pubkey)->bool{*k==TOKEN_PROGRAM||*k==TOKEN_2022_PROGRAM}
/// Funds, allocates and assigns a PDA. A third party can pre-fund the address; the allocate/assign path lets that
/// donation top up the rent instead of blocking creation.
pub fn create_pda<'a>(payer:&AccountInfo<'a>,target:&AccountInfo<'a>,system_info:&AccountInfo<'a>,program:&Pubkey,len:usize,seeds:&[&[u8]])->ProgramResult{
 if target.owner!=&system_program::id()||!target.data_is_empty(){return Err(ProgramError::AccountAlreadyInitialized)}
 let rent=Rent::get()?.minimum_balance(len);let needed=rent.saturating_sub(target.lamports());
 if needed>0{invoke(&system_instruction::transfer(payer.key,target.key,needed),&[payer.clone(),target.clone(),system_info.clone()])?;}
 invoke_signed(&system_instruction::allocate(target.key,len as u64),&[target.clone(),system_info.clone()],&[seeds])?;
 invoke_signed(&system_instruction::assign(target.key,program),&[target.clone(),system_info.clone()],&[seeds])
}
pub fn process_instruction(program:&Pubkey,accounts:&[AccountInfo],data:&[u8])->ProgramResult{
 let(&tag,body)=data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
 match tag{
  TAG_CREATE=>handlers::create(program,accounts,body),
  TAG_COMMIT=>handlers::commit(program,accounts,body),
  TAG_FINALIZE=>handlers::finalize(program,accounts,body),
  TAG_REFUND=>handlers::refund(program,accounts,body),
  TAG_SETTLE=>handlers::settle(program,accounts,body),
  TAG_ASSERT_READY=>handlers::assert_ready(program,accounts,body),
  TAG_LAUNCH=>launch::execute(program,accounts,body),
  TAG_CLAIM_PARTICIPANT=>handlers::claim_participant(program,accounts,body),
  TAG_CLAIM_DEV=>handlers::claim_dev(program,accounts,body),
  TAG_FEES_INIT|TAG_FEES_COLLECT|TAG_FEES_ROTATE_OPERATOR|TAG_FEES_DISTRIBUTE|TAG_FEES_BUY_BURN|TAG_FEES_BURN_CHILD=>fees::process(program,accounts,body,tag),
  _=>Err(ProgramError::InvalidInstructionData),
 }
}
