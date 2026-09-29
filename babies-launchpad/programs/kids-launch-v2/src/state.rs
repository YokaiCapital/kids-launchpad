//! Account layouts. The campaign is 1,024 bytes: a sealed terms region (bytes 8 to 808, written once by `create`
//! and hashed into `terms_hash`), then the mutable state. Every offset is a named constant; `host_tests`
//! checks the table against the bytes a write produces.
//!
//! Campaign layout (`CAMPAIGN_LEN` = 1024, magic `KIDSLV2C`):
//!   0 magic[8]                        8 layout_version u16              10 mode u8 (0 Standard, 1 Family)
//!  11 decimals u8                    12 split_policy u8                 13 vesting_rule u8
//!  14 fee_routing_version u8         15 creator_fee_enabled u8 (0)      16 genesis[32]
//!  48 creator[32]                    80 nonce u64                       88 dev[32]
//! 120 treasury[32]                  152 child_mint[32]                 184 supply u64
//! 192 opens_at i64                  200 deadline i64                   208 launch_deadline i64
//! 216 soft u64                      224 hard u64                       232 amm_program[32]
//! 264 amm_config[32]                296 amm_trade_fee_rate u64 (per 1,000,000, Raydium's unit)
//! 304 amm_config_index u16          306 fee weights 4 × u16 (treasury, dev, parent A, parent B)
//! 314 split bps 5 × u16 (participants, liquidity, parent A, parent B, dev)
//! 324 vesting instant_bps u16       326 vesting linear_bps u16         328 vesting months u8
//! 329 buyback_max_slippage_bps u16 (Family: 1 to 500; Standard: 0)    331 zero[1]
//! 332 lock_program[32]              364 distribution_program[32] (zero = none)
//! 396 parent_mint[2][32]            460 parent_program[2][32]          524 parent_snapshot_slot[2] u64
//! 540 parent_root[2][32]            604 parent_supply[2] u64           620 parent_eligible[2] u64
//! 636 parent_expiry_seconds u64 (0 = never)                            644 metadata_hash[32]
//! 676 metadata_uri_len u8           677 metadata_uri[128]
//! 805 parent_reference_config[2] u8 (0 = no reference pool, n = Raydium CPMM AMM config index n - 1 of the
//!     parent/WSOL pool tag 25 quotes against)                          807 zero[1]
//! --- end of the sealed region (bytes 8..808 are hashed) ---
//! 808 terms_hash[32]                840 phase u8                       841 bump u8
//! 842 activation flags u8 (bit 0 distribution activated)              843 zero[5]
//! 848 total u64                     856 refunded u64                   864 receipt_count u64
//! 872 settled_count u64             880 settled_accepted u64           888 participant_claimed u64
//! 896 dev_claimed u64               904 parent_claimed[2] u64          920 launch_time i64
//! 928 pool[32]                      960 fee_nft[32]                    992 accounting_version u8 (0 original, 2 funding-first)
//! 993 reserved[31] (zero)
//!
//! Receipt layout (`RECEIPT_LEN` = 128, magic `KIDSLV2R`):
//!   0 magic[8]   8 campaign[32]   40 owner[32]   72 committed u64   80 refunded u64   88 sequence u64
//!  96 accepted u64   104 claimed_tokens u64   112 bump u8   113 settled u8   114 claimed u8   115 accounted u8   116 zero[12]
use crate::{err,policy::*,read64,read_key,put64,E_TERMS_INVALID};
use solana_program::{account_info::AccountInfo,entrypoint::ProgramResult,program_error::ProgramError,pubkey::Pubkey};

pub const CAMPAIGN_LEN:usize=1024;
pub const RECEIPT_LEN:usize=128;
pub const CAMPAIGN_MAGIC:&[u8;8]=b"KIDSLV2C";
pub const RECEIPT_MAGIC:&[u8;8]=b"KIDSLV2R";
pub const LAYOUT_VERSION:u16=2;
pub const SEALED_START:usize=8;
pub const SEALED_END:usize=808;
pub const SEALED_LEN:usize=SEALED_END-SEALED_START;
pub const METADATA_URI_MAX:usize=128;
pub const CAMPAIGN_SEED:&[u8]=b"campaign";
pub const RECEIPT_SEED:&[u8]=b"commitment";
pub const LAUNCH_AUTHORITY_SEED:&[u8]=b"launch_authority";
pub const FLAG_DISTRIBUTION_ACTIVATED:u8=1;

pub const OFF_LAYOUT_VERSION:usize=8;
pub const OFF_MODE:usize=10;
pub const OFF_DECIMALS:usize=11;
pub const OFF_SPLIT_POLICY:usize=12;
pub const OFF_VESTING_RULE:usize=13;
pub const OFF_FEE_ROUTING_VERSION:usize=14;
pub const OFF_CREATOR_FEE_ENABLED:usize=15;
pub const OFF_GENESIS:usize=16;
pub const OFF_CREATOR:usize=48;
pub const OFF_NONCE:usize=80;
pub const OFF_DEV:usize=88;
pub const OFF_TREASURY:usize=120;
pub const OFF_CHILD_MINT:usize=152;
pub const OFF_SUPPLY:usize=184;
pub const OFF_OPENS_AT:usize=192;
pub const OFF_DEADLINE:usize=200;
pub const OFF_LAUNCH_DEADLINE:usize=208;
pub const OFF_SOFT:usize=216;
pub const OFF_HARD:usize=224;
pub const OFF_AMM_PROGRAM:usize=232;
pub const OFF_AMM_CONFIG:usize=264;
pub const OFF_AMM_TRADE_FEE_RATE:usize=296;
pub const OFF_AMM_CONFIG_INDEX:usize=304;
pub const OFF_FEE_WEIGHTS:usize=306;
pub const OFF_SPLIT_BPS:usize=314;
pub const OFF_VESTING_INSTANT_BPS:usize=324;
pub const OFF_VESTING_LINEAR_BPS:usize=326;
pub const OFF_VESTING_MONTHS:usize=328;
pub const OFF_BUYBACK_MAX_SLIPPAGE_BPS:usize=329;
pub const OFF_LOCK_PROGRAM:usize=332;
pub const OFF_DISTRIBUTION_PROGRAM:usize=364;
pub const OFF_PARENT_MINT:usize=396;
pub const OFF_PARENT_PROGRAM:usize=460;
pub const OFF_PARENT_SLOT:usize=524;
pub const OFF_PARENT_ROOT:usize=540;
pub const OFF_PARENT_SUPPLY:usize=604;
pub const OFF_PARENT_ELIGIBLE:usize=620;
pub const OFF_PARENT_EXPIRY_SECONDS:usize=636;
pub const OFF_METADATA_HASH:usize=644;
pub const OFF_METADATA_URI_LEN:usize=676;
pub const OFF_METADATA_URI:usize=677;
pub const OFF_PARENT_REFERENCE_CONFIG:usize=805;
pub const OFF_TERMS_HASH:usize=808;
pub const OFF_PHASE:usize=840;
pub const OFF_BUMP:usize=841;
pub const OFF_FLAGS:usize=842;
pub const OFF_TOTAL:usize=848;
pub const OFF_REFUNDED:usize=856;
pub const OFF_RECEIPT_COUNT:usize=864;
pub const OFF_SETTLED_COUNT:usize=872;
pub const OFF_SETTLED_ACCEPTED:usize=880;
pub const OFF_PARTICIPANT_CLAIMED:usize=888;
pub const OFF_DEV_CLAIMED:usize=896;
pub const OFF_PARENT_CLAIMED:usize=904;
pub const OFF_LAUNCH_TIME:usize=920;
pub const OFF_POOL:usize=928;
pub const OFF_FEE_NFT:usize=960;
pub const OFF_RESERVED:usize=992;
/// Accounting version of the record, the first reserved byte: 0 for every record created by tags 0 and 40, 2 for the
/// funding-first accounting (tag 41). Decoded and re-encoded like every other field, so no handler can erase it.
pub const OFF_ACCOUNTING_VERSION:usize=992;
pub const ACCOUNTING_VERSION_ORIGINAL:u8=0;
pub const ACCOUNTING_VERSION_FUNDING_FIRST:u8=2;

pub const OFF_RECEIPT_CAMPAIGN:usize=8;
pub const OFF_RECEIPT_OWNER:usize=40;
pub const OFF_RECEIPT_COMMITTED:usize=72;
pub const OFF_RECEIPT_REFUNDED:usize=80;
pub const OFF_RECEIPT_SEQUENCE:usize=88;
pub const OFF_RECEIPT_ACCEPTED:usize=96;
pub const OFF_RECEIPT_CLAIMED_TOKENS:usize=104;
pub const OFF_RECEIPT_BUMP:usize=112;
pub const OFF_RECEIPT_SETTLED:usize=113;
pub const OFF_RECEIPT_CLAIMED:usize=114;
/// Set once by the exact-once accounting step of the funding-first accounting (tag 46); never used by version-0 handlers.
pub const OFF_RECEIPT_ACCOUNTED:usize=115;

/// The sealed terms of a campaign. `Terms::decode` reads them from the 800 sealed bytes, which is also the body
/// of the create instruction, so the client and the program share one encoding.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct Terms{
 pub layout_version:u16,pub mode:u8,pub decimals:u8,pub split_policy:u8,pub vesting_rule:u8,pub fee_routing_version:u8,pub creator_fee_enabled:u8,
 pub genesis:[u8;32],pub creator:Pubkey,pub nonce:u64,pub dev:Pubkey,pub treasury:Pubkey,pub child_mint:Pubkey,pub supply:u64,
 pub opens_at:i64,pub deadline:i64,pub launch_deadline:i64,pub soft:u64,pub hard:u64,
 pub amm_program:Pubkey,pub amm_config:Pubkey,pub amm_trade_fee_rate:u64,pub amm_config_index:u16,
 pub fee_weights:FeeWeights,pub split_bps:SplitBps,pub vesting:VestingRule,pub buyback_max_slippage_bps:u16,
 pub lock_program:Pubkey,pub distribution_program:Pubkey,
 pub parent_mint:[Pubkey;2],pub parent_program:[Pubkey;2],pub parent_slot:[u64;2],pub parent_root:[[u8;32];2],pub parent_supply:[u64;2],pub parent_eligible:[u64;2],pub parent_expiry_seconds:u64,
 pub metadata_hash:[u8;32],pub metadata_uri_len:u8,pub metadata_uri:[u8;METADATA_URI_MAX],
 /// Per parent: 0 = no reference pool, n = Raydium CPMM AMM config index n - 1 (`reference_config_index`).
 pub parent_reference_config:[u8;2],
}
fn read16(d:&[u8],at:usize)->Result<u16,ProgramError>{Ok(u16::from_le_bytes(d.get(at..at+2).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap()))}
fn put16(d:&mut[u8],at:usize,n:u16){d[at..at+2].copy_from_slice(&n.to_le_bytes());}
fn read_bytes32(d:&[u8],at:usize)->Result<[u8;32],ProgramError>{Ok(d.get(at..at+32).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap())}
impl Terms{
 /// Reads the sealed region from a full campaign buffer, or from a create body positioned at `SEALED_START`.
 pub fn decode(d:&[u8])->Result<Self,ProgramError>{
  if d.len()<SEALED_END{return Err(ProgramError::InvalidInstructionData)}
  let mut metadata_uri=[0u8;METADATA_URI_MAX];metadata_uri.copy_from_slice(&d[OFF_METADATA_URI..OFF_METADATA_URI+METADATA_URI_MAX]);
  Ok(Self{
   layout_version:read16(d,OFF_LAYOUT_VERSION)?,mode:d[OFF_MODE],decimals:d[OFF_DECIMALS],split_policy:d[OFF_SPLIT_POLICY],vesting_rule:d[OFF_VESTING_RULE],fee_routing_version:d[OFF_FEE_ROUTING_VERSION],creator_fee_enabled:d[OFF_CREATOR_FEE_ENABLED],
   genesis:read_bytes32(d,OFF_GENESIS)?,creator:read_key(d,OFF_CREATOR)?,nonce:read64(d,OFF_NONCE)?,dev:read_key(d,OFF_DEV)?,treasury:read_key(d,OFF_TREASURY)?,child_mint:read_key(d,OFF_CHILD_MINT)?,supply:read64(d,OFF_SUPPLY)?,
   opens_at:read64(d,OFF_OPENS_AT)? as i64,deadline:read64(d,OFF_DEADLINE)? as i64,launch_deadline:read64(d,OFF_LAUNCH_DEADLINE)? as i64,soft:read64(d,OFF_SOFT)?,hard:read64(d,OFF_HARD)?,
   amm_program:read_key(d,OFF_AMM_PROGRAM)?,amm_config:read_key(d,OFF_AMM_CONFIG)?,amm_trade_fee_rate:read64(d,OFF_AMM_TRADE_FEE_RATE)?,amm_config_index:read16(d,OFF_AMM_CONFIG_INDEX)?,
   fee_weights:FeeWeights{treasury:read16(d,OFF_FEE_WEIGHTS)?,dev:read16(d,OFF_FEE_WEIGHTS+2)?,parent_a:read16(d,OFF_FEE_WEIGHTS+4)?,parent_b:read16(d,OFF_FEE_WEIGHTS+6)?},
   split_bps:SplitBps{participants:read16(d,OFF_SPLIT_BPS)?,liquidity:read16(d,OFF_SPLIT_BPS+2)?,parent_a:read16(d,OFF_SPLIT_BPS+4)?,parent_b:read16(d,OFF_SPLIT_BPS+6)?,dev:read16(d,OFF_SPLIT_BPS+8)?},
   vesting:VestingRule{instant_bps:read16(d,OFF_VESTING_INSTANT_BPS)?,linear_bps:read16(d,OFF_VESTING_LINEAR_BPS)?,months:d[OFF_VESTING_MONTHS]},buyback_max_slippage_bps:read16(d,OFF_BUYBACK_MAX_SLIPPAGE_BPS)?,
   lock_program:read_key(d,OFF_LOCK_PROGRAM)?,distribution_program:read_key(d,OFF_DISTRIBUTION_PROGRAM)?,
   parent_mint:[read_key(d,OFF_PARENT_MINT)?,read_key(d,OFF_PARENT_MINT+32)?],parent_program:[read_key(d,OFF_PARENT_PROGRAM)?,read_key(d,OFF_PARENT_PROGRAM+32)?],
   parent_slot:[read64(d,OFF_PARENT_SLOT)?,read64(d,OFF_PARENT_SLOT+8)?],parent_root:[read_bytes32(d,OFF_PARENT_ROOT)?,read_bytes32(d,OFF_PARENT_ROOT+32)?],
   parent_supply:[read64(d,OFF_PARENT_SUPPLY)?,read64(d,OFF_PARENT_SUPPLY+8)?],parent_eligible:[read64(d,OFF_PARENT_ELIGIBLE)?,read64(d,OFF_PARENT_ELIGIBLE+8)?],parent_expiry_seconds:read64(d,OFF_PARENT_EXPIRY_SECONDS)?,
   metadata_hash:read_bytes32(d,OFF_METADATA_HASH)?,metadata_uri_len:d[OFF_METADATA_URI_LEN],metadata_uri,
   parent_reference_config:[d[OFF_PARENT_REFERENCE_CONFIG],d[OFF_PARENT_REFERENCE_CONFIG+1]],
  })
 }
 pub fn encode(&self,d:&mut[u8]){
  d[SEALED_START..SEALED_END].fill(0);
  put16(d,OFF_LAYOUT_VERSION,self.layout_version);d[OFF_MODE]=self.mode;d[OFF_DECIMALS]=self.decimals;d[OFF_SPLIT_POLICY]=self.split_policy;d[OFF_VESTING_RULE]=self.vesting_rule;d[OFF_FEE_ROUTING_VERSION]=self.fee_routing_version;d[OFF_CREATOR_FEE_ENABLED]=self.creator_fee_enabled;
  d[OFF_GENESIS..OFF_GENESIS+32].copy_from_slice(&self.genesis);
  for(at,key)in[(OFF_CREATOR,self.creator),(OFF_DEV,self.dev),(OFF_TREASURY,self.treasury),(OFF_CHILD_MINT,self.child_mint),(OFF_AMM_PROGRAM,self.amm_program),(OFF_AMM_CONFIG,self.amm_config),(OFF_LOCK_PROGRAM,self.lock_program),(OFF_DISTRIBUTION_PROGRAM,self.distribution_program),(OFF_PARENT_MINT,self.parent_mint[0]),(OFF_PARENT_MINT+32,self.parent_mint[1]),(OFF_PARENT_PROGRAM,self.parent_program[0]),(OFF_PARENT_PROGRAM+32,self.parent_program[1])]{d[at..at+32].copy_from_slice(key.as_ref());}
  for(at,n)in[(OFF_NONCE,self.nonce),(OFF_SUPPLY,self.supply),(OFF_OPENS_AT,self.opens_at as u64),(OFF_DEADLINE,self.deadline as u64),(OFF_LAUNCH_DEADLINE,self.launch_deadline as u64),(OFF_SOFT,self.soft),(OFF_HARD,self.hard),(OFF_AMM_TRADE_FEE_RATE,self.amm_trade_fee_rate),(OFF_PARENT_SLOT,self.parent_slot[0]),(OFF_PARENT_SLOT+8,self.parent_slot[1]),(OFF_PARENT_SUPPLY,self.parent_supply[0]),(OFF_PARENT_SUPPLY+8,self.parent_supply[1]),(OFF_PARENT_ELIGIBLE,self.parent_eligible[0]),(OFF_PARENT_ELIGIBLE+8,self.parent_eligible[1]),(OFF_PARENT_EXPIRY_SECONDS,self.parent_expiry_seconds)]{put64(d,at,n);}
  put16(d,OFF_AMM_CONFIG_INDEX,self.amm_config_index);
  for(i,w)in[self.fee_weights.treasury,self.fee_weights.dev,self.fee_weights.parent_a,self.fee_weights.parent_b].iter().enumerate(){put16(d,OFF_FEE_WEIGHTS+2*i,*w);}
  for(i,b)in[self.split_bps.participants,self.split_bps.liquidity,self.split_bps.parent_a,self.split_bps.parent_b,self.split_bps.dev].iter().enumerate(){put16(d,OFF_SPLIT_BPS+2*i,*b);}
  put16(d,OFF_VESTING_INSTANT_BPS,self.vesting.instant_bps);put16(d,OFF_VESTING_LINEAR_BPS,self.vesting.linear_bps);d[OFF_VESTING_MONTHS]=self.vesting.months;
  put16(d,OFF_BUYBACK_MAX_SLIPPAGE_BPS,self.buyback_max_slippage_bps);d[OFF_PARENT_REFERENCE_CONFIG..OFF_PARENT_REFERENCE_CONFIG+2].copy_from_slice(&self.parent_reference_config);
  d[OFF_PARENT_ROOT..OFF_PARENT_ROOT+32].copy_from_slice(&self.parent_root[0]);d[OFF_PARENT_ROOT+32..OFF_PARENT_ROOT+64].copy_from_slice(&self.parent_root[1]);
  d[OFF_METADATA_HASH..OFF_METADATA_HASH+32].copy_from_slice(&self.metadata_hash);d[OFF_METADATA_URI_LEN]=self.metadata_uri_len;d[OFF_METADATA_URI..OFF_METADATA_URI+METADATA_URI_MAX].copy_from_slice(&self.metadata_uri);
 }
 pub fn hash(&self)->[u8;32]{let mut d=vec![0u8;SEALED_END];self.encode(&mut d);terms_hash(&d[SEALED_START..SEALED_END])}
 pub fn is_family(&self)->bool{self.mode==MODE_FAMILY}
 pub fn has_distribution(&self)->bool{self.distribution_program!=Pubkey::default()}
 /// The Raydium CPMM AMM config index of the parent's reference pool, if the terms seal one.
 pub fn reference_config_index(&self,parent:usize)->Option<u16>{self.parent_reference_config[parent].checked_sub(1).map(u16::from)}
 pub fn split(&self)->Result<Split,ProgramError>{split(self.supply,self.split_bps)}
 pub fn metadata_uri(&self)->&[u8]{&self.metadata_uri[..self.metadata_uri_len as usize]}
 pub fn campaign_address(&self,program:&Pubkey)->(Pubkey,u8){Pubkey::find_program_address(&[CAMPAIGN_SEED,self.creator.as_ref(),&self.nonce.to_le_bytes()],program)}
}
/// Mutable state written by every instruction after `create`.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct State{
 pub terms_hash:[u8;32],pub phase:u8,pub bump:u8,pub flags:u8,
 pub total:u64,pub refunded:u64,pub receipt_count:u64,pub settled_count:u64,pub settled_accepted:u64,
 pub participant_claimed:u64,pub dev_claimed:u64,pub parent_claimed:[u64;2],pub launch_time:i64,pub pool:Pubkey,pub fee_nft:Pubkey,
 pub accounting_version:u8,
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct Campaign{pub terms:Terms,pub state:State}
impl Campaign{
 pub fn fresh(terms:Terms,bump:u8)->Self{
  Self{terms,state:State{terms_hash:terms.hash(),phase:PHASE_FUNDING,bump,flags:0,total:0,refunded:0,receipt_count:0,settled_count:0,settled_accepted:0,participant_claimed:0,dev_claimed:0,parent_claimed:[0;2],launch_time:0,pool:Pubkey::default(),fee_nft:Pubkey::default(),accounting_version:ACCOUNTING_VERSION_ORIGINAL}}
 }
 pub fn decode(d:&[u8])->Result<Self,ProgramError>{
  if d.len()!=CAMPAIGN_LEN||&d[..8]!=CAMPAIGN_MAGIC{return Err(ProgramError::InvalidAccountData)}
  let terms=Terms::decode(d)?;
  if terms.layout_version!=LAYOUT_VERSION{return Err(ProgramError::InvalidAccountData)}
  let state=State{terms_hash:read_bytes32(d,OFF_TERMS_HASH)?,phase:d[OFF_PHASE],bump:d[OFF_BUMP],flags:d[OFF_FLAGS],
   total:read64(d,OFF_TOTAL)?,refunded:read64(d,OFF_REFUNDED)?,receipt_count:read64(d,OFF_RECEIPT_COUNT)?,settled_count:read64(d,OFF_SETTLED_COUNT)?,settled_accepted:read64(d,OFF_SETTLED_ACCEPTED)?,
   participant_claimed:read64(d,OFF_PARTICIPANT_CLAIMED)?,dev_claimed:read64(d,OFF_DEV_CLAIMED)?,parent_claimed:[read64(d,OFF_PARENT_CLAIMED)?,read64(d,OFF_PARENT_CLAIMED+8)?],
   launch_time:read64(d,OFF_LAUNCH_TIME)? as i64,pool:read_key(d,OFF_POOL)?,fee_nft:read_key(d,OFF_FEE_NFT)?,accounting_version:d[OFF_ACCOUNTING_VERSION]};
  // The stored hash must be the hash of the stored terms: a campaign whose terms bytes were altered is unreadable.
  if state.terms_hash!=terms_hash(&d[SEALED_START..SEALED_END]){return Err(err(E_TERMS_INVALID))}
  Ok(Self{terms,state})
 }
 /// Reads a campaign owned by this program at its derived address.
 pub fn read(account:&AccountInfo,program:&Pubkey)->Result<Self,ProgramError>{
  if account.owner!=program{return Err(ProgramError::IncorrectProgramId)}
  let d=account.try_borrow_data()?;let c=Self::decode(&d)?;
  let(expected,bump)=c.terms.campaign_address(program);
  if expected!=*account.key||bump!=c.state.bump{return Err(ProgramError::InvalidSeeds)}
  Ok(c)
 }
 pub fn encode(&self,d:&mut[u8]){
  d[..8].copy_from_slice(CAMPAIGN_MAGIC);self.terms.encode(d);
  d[OFF_TERMS_HASH..OFF_TERMS_HASH+32].copy_from_slice(&self.state.terms_hash);d[OFF_PHASE]=self.state.phase;d[OFF_BUMP]=self.state.bump;d[OFF_FLAGS]=self.state.flags;d[OFF_FLAGS+1..OFF_TOTAL].fill(0);
  for(at,n)in[(OFF_TOTAL,self.state.total),(OFF_REFUNDED,self.state.refunded),(OFF_RECEIPT_COUNT,self.state.receipt_count),(OFF_SETTLED_COUNT,self.state.settled_count),(OFF_SETTLED_ACCEPTED,self.state.settled_accepted),(OFF_PARTICIPANT_CLAIMED,self.state.participant_claimed),(OFF_DEV_CLAIMED,self.state.dev_claimed),(OFF_PARENT_CLAIMED,self.state.parent_claimed[0]),(OFF_PARENT_CLAIMED+8,self.state.parent_claimed[1]),(OFF_LAUNCH_TIME,self.state.launch_time as u64)]{put64(d,at,n);}
  d[OFF_POOL..OFF_POOL+32].copy_from_slice(self.state.pool.as_ref());d[OFF_FEE_NFT..OFF_FEE_NFT+32].copy_from_slice(self.state.fee_nft.as_ref());d[OFF_RESERVED..].fill(0);d[OFF_ACCOUNTING_VERSION]=self.state.accounting_version;
 }
 pub fn write(&self,account:&AccountInfo)->ProgramResult{let mut d=account.try_borrow_mut_data()?;if d.len()!=CAMPAIGN_LEN{return Err(ProgramError::InvalidAccountData)}self.encode(&mut d);Ok(())}
 pub fn readiness(&self)->Readiness{
  Readiness{phase:self.state.phase,soft:self.terms.soft,deadline:self.terms.deadline,launch_deadline:self.terms.launch_deadline,total:self.state.total,receipt_count:self.state.receipt_count,settled_count:self.state.settled_count,settled_accepted:self.state.settled_accepted}
 }
 pub fn funding_open(&self,now:i64)->bool{funding_open(self.state.phase,self.terms.opens_at,self.terms.deadline,now)}
 pub fn failed(&self,now:i64)->bool{launch_failed(self.state.phase,self.state.total,self.terms.soft,self.terms.launch_deadline,now)}
 pub fn ready(&self,now:i64)->bool{launch_ready(self.readiness(),now)}
 pub fn distribution_activated(&self)->bool{self.state.flags&FLAG_DISTRIBUTION_ACTIVATED!=0}
 pub fn launch_authority(&self,campaign:&Pubkey,program:&Pubkey)->(Pubkey,u8){Pubkey::find_program_address(&[LAUNCH_AUTHORITY_SEED,campaign.as_ref()],program)}
}

#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct Receipt{pub campaign:Pubkey,pub owner:Pubkey,pub committed:u64,pub refunded:u64,pub sequence:u64,pub accepted:u64,pub claimed_tokens:u64,pub bump:u8,pub settled:bool,pub claimed:bool,pub accounted:bool}
impl Receipt{
 pub fn address(program:&Pubkey,campaign:&Pubkey,owner:&Pubkey)->(Pubkey,u8){Pubkey::find_program_address(&[RECEIPT_SEED,campaign.as_ref(),owner.as_ref()],program)}
 pub fn new(campaign:Pubkey,owner:Pubkey,bump:u8)->Self{Self{campaign,owner,committed:0,refunded:0,sequence:0,accepted:0,claimed_tokens:0,bump,settled:false,claimed:false,accounted:false}}
 pub fn decode(d:&[u8])->Result<Self,ProgramError>{
  if d.len()!=RECEIPT_LEN||&d[..8]!=RECEIPT_MAGIC{return Err(ProgramError::InvalidAccountData)}
  Ok(Self{campaign:read_key(d,OFF_RECEIPT_CAMPAIGN)?,owner:read_key(d,OFF_RECEIPT_OWNER)?,committed:read64(d,OFF_RECEIPT_COMMITTED)?,refunded:read64(d,OFF_RECEIPT_REFUNDED)?,sequence:read64(d,OFF_RECEIPT_SEQUENCE)?,accepted:read64(d,OFF_RECEIPT_ACCEPTED)?,claimed_tokens:read64(d,OFF_RECEIPT_CLAIMED_TOKENS)?,bump:d[OFF_RECEIPT_BUMP],settled:d[OFF_RECEIPT_SETTLED]!=0,claimed:d[OFF_RECEIPT_CLAIMED]!=0,accounted:d[OFF_RECEIPT_ACCOUNTED]!=0})
 }
 /// Reads a receipt of this program for exactly this campaign at its derived address.
 pub fn read(account:&AccountInfo,program:&Pubkey,campaign:&Pubkey)->Result<Self,ProgramError>{
  if account.owner!=program{return Err(ProgramError::IncorrectProgramId)}
  let d=account.try_borrow_data()?;let r=Self::decode(&d)?;
  let(expected,bump)=Self::address(program,campaign,&r.owner);
  if r.campaign!=*campaign||expected!=*account.key||bump!=r.bump{return Err(ProgramError::InvalidSeeds)}
  Ok(r)
 }
 pub fn encode(&self,d:&mut[u8]){
  d.fill(0);d[..8].copy_from_slice(RECEIPT_MAGIC);d[OFF_RECEIPT_CAMPAIGN..OFF_RECEIPT_CAMPAIGN+32].copy_from_slice(self.campaign.as_ref());d[OFF_RECEIPT_OWNER..OFF_RECEIPT_OWNER+32].copy_from_slice(self.owner.as_ref());
  for(at,n)in[(OFF_RECEIPT_COMMITTED,self.committed),(OFF_RECEIPT_REFUNDED,self.refunded),(OFF_RECEIPT_SEQUENCE,self.sequence),(OFF_RECEIPT_ACCEPTED,self.accepted),(OFF_RECEIPT_CLAIMED_TOKENS,self.claimed_tokens)]{put64(d,at,n);}
  d[OFF_RECEIPT_BUMP]=self.bump;d[OFF_RECEIPT_SETTLED]=self.settled as u8;d[OFF_RECEIPT_CLAIMED]=self.claimed as u8;d[OFF_RECEIPT_ACCOUNTED]=self.accounted as u8;
 }
 pub fn write(&self,account:&AccountInfo)->ProgramResult{let mut d=account.try_borrow_mut_data()?;if d.len()!=RECEIPT_LEN{return Err(ProgramError::InvalidAccountData)}self.encode(&mut d);Ok(())}
}
