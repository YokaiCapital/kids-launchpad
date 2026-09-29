//! Instruction handlers. Account tables are in the doc comment of each handler; the README repeats them.
use crate::{policy::*,state::*,*};
use solana_program::{clock::Clock,instruction::{AccountMeta,Instruction},program::invoke_signed};

pub(crate) fn now()->Result<i64,ProgramError>{Ok(Clock::get()?.unix_timestamp)}

/// Raydium CPMM `AmmConfig` (236 bytes): 8 discriminator, 8 bump, 9 disable_create_pool, 10 index u16, 12 trade
/// fee rate, 20 protocol fee rate, 28 fund fee rate, 36 create-pool fee, 44 protocol owner, 76 fund owner,
/// 108 creator fee rate, 116 padding. Rates are per 1,000,000. Both approved mainnet tiers carry a creator fee
/// rate of 500; the program reads the field only in tests, because a pool charges it only when its own
/// `enable_creator_fee` switch is on (see `amm_config_matches`).
pub const AMM_CONFIG_LEN:usize=236;
pub const AMM_CONFIG_OFF_DISABLE:usize=9;
pub const AMM_CONFIG_OFF_INDEX:usize=10;
pub const AMM_CONFIG_OFF_TRADE_FEE_RATE:usize=12;
pub const AMM_CONFIG_OFF_PROTOCOL_FEE_RATE:usize=20;
pub const AMM_CONFIG_OFF_FUND_FEE_RATE:usize=28;
pub const AMM_CONFIG_OFF_CREATOR_FEE_RATE:usize=108;
pub fn amm_config_discriminator()->[u8;8]{solana_program::hash::hash(b"account:AmmConfig").to_bytes()[..8].try_into().unwrap()}
/// The config account's bytes must say what the terms sealed: enabled, the sealed index and trade fee rate, and
/// the standard protocol and fund shares. Read at creation and again at launch. The config's `creator_fee_rate` is
/// not a rule: Raydium charges it only on a pool whose `enable_creator_fee` switch is on, and only
/// `initialize_with_permission` can switch it on. The launch sends plain `initialize`
/// (`launch::cpmm_initialize_data`, checked before the CPI) and refuses a pool that reads back with the switch on;
/// tag 25 refuses a reference pool with the switch on.
pub fn amm_config_matches(d:&[u8],terms:&Terms)->ProgramResult{
 require(d.len()==AMM_CONFIG_LEN&&d[..8]==amm_config_discriminator()&&d[AMM_CONFIG_OFF_DISABLE]==0,E_AMM_CONFIG)?;
 let index=u16::from_le_bytes([d[AMM_CONFIG_OFF_INDEX],d[AMM_CONFIG_OFF_INDEX+1]]);
 require(index==terms.amm_config_index&&read64(d,AMM_CONFIG_OFF_TRADE_FEE_RATE)?==terms.amm_trade_fee_rate,E_AMM_CONFIG)?;
 require(read64(d,AMM_CONFIG_OFF_PROTOCOL_FEE_RATE)?==AMM_PROTOCOL_FEE_RATE&&read64(d,AMM_CONFIG_OFF_FUND_FEE_RATE)?==AMM_FUND_FEE_RATE,E_AMM_CONFIG)
}
pub fn amm_config_account(a:&AccountInfo,terms:&Terms)->ProgramResult{
 require(*a.key==terms.amm_config&&*a.owner==terms.amm_program,E_AMM_CONFIG)?;
 let d=a.try_borrow_data()?;amm_config_matches(&d,terms)
}
/// The least hard cap for a soft cap: one percent above it, rounded up. Settlement floors every receipt, so a total
/// just over the hard cap can settle below `soft` when the two caps are equal or a few lamports apart; the margin
/// keeps that rounding from making a funded campaign unlaunchable.
pub fn least_hard_cap(soft:u64)->Result<u64,ProgramError>{soft.checked_add(soft.div_ceil(100)).ok_or(err(E_TERMS_INVALID))}
/// Sealed-field rules that need no account: ranges, policy tables, mode-dependent parent state, metadata.
pub fn validate_terms(terms:&Terms,signer:&Pubkey,now:i64)->ProgramResult{
 require(terms.layout_version==LAYOUT_VERSION&&(terms.mode==MODE_STANDARD||terms.mode==MODE_FAMILY),E_TERMS_INVALID)?;
 require(terms.creator==*signer&&terms.genesis!=[0u8;32],E_TERMS_INVALID)?;
 require(terms.dev!=Pubkey::default()&&terms.child_mint!=Pubkey::default()&&terms.child_mint!=WSOL,E_TERMS_INVALID)?;
 require(terms.treasury==PLATFORM_TREASURY,E_TREASURY_NOT_PLATFORM)?;
 require(terms.supply>=BPS_DENOMINATOR&&terms.decimals<=9,E_TERMS_INVALID)?;
 require(terms.opens_at>=now.saturating_sub(OPENS_AT_TOLERANCE_SECONDS),E_OPENS_AT_IN_PAST)?;
 require(terms.deadline>terms.opens_at&&terms.launch_deadline>terms.deadline,E_TERMS_INVALID)?;
 require(terms.soft>0&&terms.hard>=least_hard_cap(terms.soft)?,E_TERMS_INVALID)?;
 require(SplitBps::policies_for_mode(terms.mode).contains(&terms.split_policy)&&SplitBps::for_policy(terms.split_policy)==Some(terms.split_bps),E_POLICY_TABLE)?;
 require(VestingRule::for_rule(terms.vesting_rule)==Some(terms.vesting)&&terms.vesting.total_bps()==terms.split_bps.dev as u64,E_POLICY_TABLE)?;
 require(FeeWeights::for_version_and_mode(terms.fee_routing_version,terms.mode)==Some(terms.fee_weights),E_POLICY_TABLE)?;
 require(terms.creator_fee_enabled==0,E_TERMS_INVALID)?;
 require(terms.amm_program==RAYDIUM_CPMM&&AMM_CONFIG_TIERS.contains(&(terms.amm_config_index,terms.amm_config,terms.amm_trade_fee_rate)),E_AMM_CONFIG)?;
 require(terms.lock_program==RAYDIUM_LOCK,E_TERMS_INVALID)?;
 let parents_blank=terms.parent_mint==[Pubkey::default();2]&&terms.parent_program==[Pubkey::default();2]&&terms.parent_slot==[0;2]&&terms.parent_root==[[0u8;32];2]&&terms.parent_supply==[0;2]&&terms.parent_eligible==[0;2]&&terms.parent_expiry_seconds==0
  &&terms.buyback_max_slippage_bps==0&&terms.parent_reference_config==[0;2];
 if terms.is_family(){
  require(terms.parent_mint[0]!=Pubkey::default()&&terms.parent_mint[1]!=Pubkey::default()&&terms.parent_mint[0]!=terms.parent_mint[1],E_MODE_PARENTS)?;
  // WSOL cannot be bought with WSOL: tag 25's input and output custody would be one account.
  require(terms.parent_mint[0]!=terms.child_mint&&terms.parent_mint[1]!=terms.child_mint&&terms.parent_mint[0]!=WSOL&&terms.parent_mint[1]!=WSOL,E_MODE_PARENTS)?;
  for i in 0..2{
   require(is_token_program(&terms.parent_program[i])&&terms.parent_slot[i]>0&&terms.parent_root[i]!=[0u8;32],E_MODE_PARENTS)?;
   require(terms.parent_supply[i]>0&&terms.parent_eligible[i]>0&&terms.parent_eligible[i]<=terms.parent_supply[i],E_MODE_PARENTS)?;
  }
  require((1..=BUYBACK_SLIPPAGE_CEILING_BPS).contains(&terms.buyback_max_slippage_bps),E_MODE_PARENTS)?;
 }else{require(parents_blank,E_MODE_PARENTS)?;}
 let uri_len=terms.metadata_uri_len as usize;
 require(terms.metadata_hash!=[0u8;32]&&uri_len>0&&uri_len<=METADATA_URI_MAX,E_METADATA)?;
 require(terms.metadata_uri[..uri_len].iter().all(|b|(0x21..=0x7e).contains(b))&&terms.metadata_uri[uri_len..].iter().all(|b|*b==0),E_METADATA)
}
/// Tag 0 body: the 800 sealed bytes (`state::SEALED_LEN`, the campaign layout from offset 8 to 808).
/// Accounts: 0 creator (signer, pays the campaign rent), 1 campaign PDA `["campaign", creator, nonce]`, 2 System,
/// 3 the sealed AMM config (read and compared), then, when the terms name one, the distribution program, then,
/// for Family, the two parent mint accounts in order. Any other account count is refused. Every rule is checked
/// first; then Family terms (error 91) and a sealed distribution program (error 90) are refused, because no
/// instruction could pay the parent reserves or activate the distribution program yet.
pub fn create(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(body.len()==SEALED_LEN,E_TERMS_INVALID)?;
 let mut sealed=vec![0u8;SEALED_END];sealed[SEALED_START..SEALED_END].copy_from_slice(body);
 let terms=Terms::decode(&sealed)?;
 // Padding bytes are hashed but carry no field: they must be zero so one set of terms has one hash.
 require(sealed[OFF_BUYBACK_MAX_SLIPPAGE_BPS+2]==0&&sealed[OFF_PARENT_REFERENCE_CONFIG+2]==0,E_TERMS_INVALID)?;
 let expected=4+terms.has_distribution() as usize+2*terms.is_family() as usize;
 require(a.len()==expected,E_ACCOUNT_COUNT)?;
 let creator=&a[0];let campaign=&a[1];let sys=&a[2];system(sys)?;
 if !creator.is_signer{return Err(ProgramError::MissingRequiredSignature)}
 validate_terms(&terms,creator.key,now()?)?;
 amm_config_account(&a[3],&terms)?;
 let mut next=4;
 if terms.has_distribution(){
  let d=&a[next];next+=1;
  require(*d.key==terms.distribution_program&&d.executable&&*d.owner==BPF_LOADER_UPGRADEABLE&&*d.key!=*program,E_DISTRIBUTION_PROGRAM_INVALID)?;
 }
 if terms.is_family(){
  for i in 0..2{
   let m=&a[next+i];require(*m.key==terms.parent_mint[i],E_PARENT_MINT)?;
   let(_,token_program)=parent_mint_supply(m)?;require(token_program==terms.parent_program[i],E_PARENT_MINT)?;
  }
 }
 let(expected_key,bump)=terms.campaign_address(program);
 if expected_key!=*campaign.key{return Err(ProgramError::InvalidSeeds)}
 require(!terms.is_family(),E_FAMILY_NOT_AVAILABLE)?;
 require(!terms.has_distribution(),E_DISTRIBUTION_NOT_WIRED)?;
 create_pda(creator,campaign,sys,program,CAMPAIGN_LEN,&[CAMPAIGN_SEED,terms.creator.as_ref(),&terms.nonce.to_le_bytes(),&[bump]])?;
 Campaign::fresh(terms,bump).write(campaign)
}
/// Allowed Token-2022 mint extensions on a parent: MintCloseAuthority, MetadataPointer, TokenMetadata. Anything that
/// changes what a balance is worth or whether it can move is refused.
const ALLOWED_PARENT_MINT_EXTENSIONS:[u16;3]=[3,18,19];
/// Supply and token program of a classic or Token-2022 parent mint. Classic: exactly 82 bytes. Token-2022: 82
/// bytes, or the extended layout (166+ bytes, type byte 1 at 165) with allowed TLV entries only.
pub fn parent_mint_supply(a:&AccountInfo)->Result<(u64,Pubkey),ProgramError>{
 if !is_token_program(a.owner){return Err(err(E_PARENT_MINT))}
 let d=a.try_borrow_data()?;
 if d.len()<82||d[45]!=1{return Err(err(E_PARENT_MINT))}
 if d.len()>82{
  if *a.owner!=TOKEN_2022_PROGRAM||d.len()<166||d[165]!=1{return Err(err(E_PARENT_MINT))}
  let mut at=166;
  while at+4<=d.len(){
   let kind=u16::from_le_bytes([d[at],d[at+1]]);let len=u16::from_le_bytes([d[at+2],d[at+3]]) as usize;
   if kind==0{break}
   if !ALLOWED_PARENT_MINT_EXTENSIONS.contains(&kind){return Err(err(E_PARENT_MINT_EXTENSION))}
   at=at.checked_add(4+len).ok_or(err(E_PARENT_MINT))?;
  }
  if at>d.len(){return Err(err(E_PARENT_MINT))}
 }
 Ok((read64(&d,36)?,*a.owner))
}
pub const COMMIT_BODY_LEN:usize=48;
/// Tag 1 body: genesis hash (32), amount in lamports (u64), receipt sequence (u64). Accounts: 0 owner (signer,
/// pays the receipt rent and the amount), 1 campaign, 2 receipt PDA `["commitment", campaign, owner]`, 3 System.
/// Open in `[opens_at, deadline)` by the chain clock while the phase is 0. The hard cap never closes funding.
pub fn commit(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(body.len()==COMMIT_BODY_LEN,E_TERMS_INVALID)?;require(a.len()==4,E_ACCOUNT_COUNT)?;
 let owner=&a[0];let campaign=&a[1];let receipt=&a[2];let sys=&a[3];system(sys)?;
 if !owner.is_signer{return Err(ProgramError::MissingRequiredSignature)}
 let mut c=Campaign::read(campaign,program)?;
 require(body[..32]==c.terms.genesis,E_NETWORK_MISMATCH)?;
 let now=now()?;
 require(c.state.phase==PHASE_FUNDING&&now<c.terms.deadline,E_FUNDING_CLOSED)?;
 require(now>=c.terms.opens_at,E_FUNDING_NOT_OPEN_YET)?;
 let amount=read64(body,32)?;let sequence=read64(body,40)?;require(amount>0,E_ZERO_AMOUNT)?;
 let(expected,bump)=Receipt::address(program,campaign.key,owner.key);if expected!=*receipt.key{return Err(ProgramError::InvalidSeeds)}
 let mut r=if receipt.owner==&system_program::id()&&receipt.data_is_empty(){
  require(sequence==0,E_RECEIPT_SEQUENCE)?;
  create_pda(owner,receipt,sys,program,RECEIPT_LEN,&[RECEIPT_SEED,campaign.key.as_ref(),owner.key.as_ref(),&[bump]])?;
  c.state.receipt_count=add(c.state.receipt_count,1)?;
  Receipt::new(*campaign.key,*owner.key,bump)
 }else{Receipt::read(receipt,program,campaign.key)?};
 require(r.owner==*owner.key&&r.sequence==sequence,E_RECEIPT_SEQUENCE)?;
 c.state.total=add(c.state.total,amount)?;r.committed=add(r.committed,amount)?;r.sequence=add(r.sequence,1)?;
 invoke(&system_instruction::transfer(owner.key,campaign.key,amount),&[owner.clone(),campaign.clone(),sys.clone()])?;
 c.write(campaign)?;r.write(receipt)
}
/// Tag 2, no body. Accounts: 0 campaign. After the deadline: phase 0 becomes 1 (funded) or 2 (below soft);
/// once the launch deadline has passed without a launch the phase is 2.
pub fn finalize(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(body.is_empty(),E_TERMS_INVALID)?;require(a.len()==1,E_ACCOUNT_COUNT)?;
 let mut c=Campaign::read(&a[0],program)?;let now=now()?;
 require(now>=c.terms.deadline,E_BEFORE_DEADLINE)?;
 if c.state.phase==PHASE_FUNDING{c.state.phase=if c.state.total<c.terms.soft{PHASE_REFUND_ONLY}else{PHASE_CLOSED};}
 if now>=c.terms.launch_deadline&&c.state.phase!=PHASE_LIVE{c.state.phase=PHASE_REFUND_ONLY;}
 c.write(&a[0])
}
/// Settlement of one registered receipt: `accepted_i = floor(commit_i × min(T, H) / T)`, once per receipt.
pub fn settle_receipt(c:&mut Campaign,r:&mut Receipt,now:i64)->ProgramResult{
 require(now>=c.terms.deadline,E_BEFORE_DEADLINE)?;
 if r.settled{return Ok(())}
 let accepted=accepted(r.committed,c.state.total,c.terms.hard);
 let count=add(c.state.settled_count,1)?;let aggregate=add(c.state.settled_accepted,accepted)?;
 require(count<=c.state.receipt_count&&aggregate<=c.state.total.min(c.terms.hard),E_SETTLEMENT_COUNT)?;
 c.state.settled_count=count;c.state.settled_accepted=aggregate;r.accepted=accepted;r.settled=true;Ok(())
}
/// Tag 4, no body. Accounts: 0 campaign, 1 receipt. Permissionless; a settled receipt is a no-op.
pub fn settle(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(body.is_empty(),E_TERMS_INVALID)?;require(a.len()==2,E_ACCOUNT_COUNT)?;
 let mut c=Campaign::read(&a[0],program)?;let mut r=Receipt::read(&a[1],program,a[0].key)?;
 settle_receipt(&mut c,&mut r,now()?)?;c.write(&a[0])?;r.write(&a[1])
}
/// Tag 3, no body. Accounts: 0 campaign, 1 receipt, 2 destination (must be the receipt owner). Permissionless and
/// idempotent: pays the receipt's cumulative entitlement less what it already received. After a failure (closed
/// below the soft cap, or the launch deadline passed without a launch) the entitlement is the whole commitment.
pub fn refund(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(body.is_empty(),E_TERMS_INVALID)?;require(a.len()==3,E_ACCOUNT_COUNT)?;
 let campaign=&a[0];let receipt=&a[1];let destination=&a[2];
 let mut c=Campaign::read(campaign,program)?;let mut r=Receipt::read(receipt,program,campaign.key)?;
 require(r.owner==*destination.key&&destination.key!=campaign.key&&destination.key!=receipt.key,E_REFUND_DESTINATION)?;
 let now=now()?;require(now>=c.terms.deadline,E_BEFORE_DEADLINE)?;
 let failed=c.failed(now);
 if failed{c.state.phase=PHASE_REFUND_ONLY}else if c.state.phase==PHASE_FUNDING{c.state.phase=PHASE_CLOSED}
 let entitled=refundable(r.committed,c.state.total,c.terms.hard,failed);
 let amount=entitled.checked_sub(r.refunded).ok_or(err(E_OVERFLOW))?;
 if amount==0{return c.write(campaign)}
 let remaining=campaign.lamports().checked_sub(amount).ok_or(ProgramError::InsufficientFunds)?;
 if remaining<Rent::get()?.minimum_balance(CAMPAIGN_LEN){return Err(ProgramError::InsufficientFunds)}
 let destination_balance=add(destination.lamports(),amount)?;
 **campaign.try_borrow_mut_lamports()?=remaining;**destination.try_borrow_mut_lamports()?=destination_balance;
 c.state.refunded=add(c.state.refunded,amount)?;r.refunded=entitled;c.write(campaign)?;r.write(receipt)
}
/// Tag 5, no body. Accounts: 0 campaign. Succeeds only when a launch could run now.
pub fn assert_ready(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(body.is_empty(),E_TERMS_INVALID)?;require(a.len()==1,E_ACCOUNT_COUNT)?;
 let c=Campaign::read(&a[0],program)?;require(c.ready(now()?),E_NOT_READY)
}
/// The child mint as sealed: classic Token mint, initialized, sealed decimals and supply, and any remaining mint or
/// freeze authority is the launch authority (both are revoked by the launch, `launch.rs`).
pub fn child_mint_matches(a:&AccountInfo,terms:&Terms,authority:&Pubkey)->ProgramResult{
 require(*a.key==terms.child_mint&&*a.owner==TOKEN_PROGRAM,E_CHILD_MINT)?;
 let d=a.try_borrow_data()?;require(d.len()==82&&d[45]==1&&d[44]==terms.decimals&&read64(&d,36)?==terms.supply,E_CHILD_MINT)?;
 require(d[..4]==[0;4]||(d[..4]==[1,0,0,0]&&read_key(&d,4)?==*authority),E_CHILD_MINT)?;
 require(d[46..50]==[0;4]||(d[46..50]==[1,0,0,0]&&read_key(&d,50)?==*authority),E_CHILD_MINT)
}
/// Balance of a classic Token account holding `mint` for `owner`: initialized, not frozen, no delegate, no close authority.
pub fn token_account(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey)->Result<u64,ProgramError>{
 require(*a.owner==TOKEN_PROGRAM,E_CLAIM_INVALID)?;let d=a.try_borrow_data()?;
 require(d.len()==165&&read_key(&d,0)?==*mint&&read_key(&d,32)?==*owner&&d[108]==1&&d[72..76]==[0;4]&&d[129..133]==[0;4],E_CLAIM_INVALID)?;read64(&d,64)
}
pub fn associated_token_address(owner:&Pubkey,mint:&Pubkey)->Pubkey{Pubkey::find_program_address(&[owner.as_ref(),TOKEN_PROGRAM.as_ref(),mint.as_ref()],&ASSOCIATED_TOKEN_PROGRAM).0}
/// Pays `amount` of the child token from the launch custody (the launch authority's associated token account) to
/// the recipient's associated token account. The mint must be the sealed one with both authorities revoked and a
/// supply no larger than the original (holders may burn; entitlements stay on the original supply).
pub fn custody_transfer<'a>(program:&Pubkey,c:&Campaign,campaign:&AccountInfo<'a>,authority:&AccountInfo<'a>,mint:&AccountInfo<'a>,source:&AccountInfo<'a>,destination:&AccountInfo<'a>,recipient:&Pubkey,token_program:&AccountInfo<'a>,amount:u64)->ProgramResult{
 require(c.state.phase==PHASE_LIVE,E_NOT_LAUNCHED)?;
 require(*mint.key==c.terms.child_mint&&*mint.owner==TOKEN_PROGRAM&&*token_program.key==TOKEN_PROGRAM&&token_program.executable,E_CLAIM_INVALID)?;
 {let d=mint.try_borrow_data()?;require(d.len()==82&&d[45]==1&&d[44]==c.terms.decimals&&read64(&d,36)?<=c.terms.supply&&d[..4]==[0;4]&&d[46..50]==[0;4],E_CLAIM_INVALID)?;}
 let(expected,bump)=c.launch_authority(campaign.key,program);require(*authority.key==expected,E_CLAIM_INVALID)?;
 require(*source.key==associated_token_address(&expected,&c.terms.child_mint)&&*destination.key==associated_token_address(recipient,&c.terms.child_mint)&&source.key!=destination.key,E_CLAIM_INVALID)?;
 require(token_account(source,&c.terms.child_mint,&expected)?>=amount,E_CLAIM_INVALID)?;token_account(destination,&c.terms.child_mint,recipient)?;
 if amount==0{return Ok(())}
 let mut data=vec![3];data.extend_from_slice(&amount.to_le_bytes());
 invoke_signed(&Instruction{program_id:TOKEN_PROGRAM,accounts:vec![AccountMeta::new(*source.key,false),AccountMeta::new(*destination.key,false),AccountMeta::new_readonly(expected,true)],data},&[source.clone(),destination.clone(),authority.clone(),token_program.clone()],&[&[LAUNCH_AUTHORITY_SEED,campaign.key.as_ref(),&[bump]]])
}
/// Tag 7, no body. Accounts: 0 campaign, 1 receipt, 2 launch authority PDA, 3 child mint, 4 custody token
/// account, 5 the receipt owner's associated token account, 6 Token. Pays
/// `floor(participant_reserve × accepted_i / A)` once; refused with error 40 when a distribution program is
/// activated (the vaults pay then).
pub fn claim_participant(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(body.is_empty(),E_TERMS_INVALID)?;require(a.len()==7,E_ACCOUNT_COUNT)?;
 let mut c=Campaign::read(&a[0],program)?;require(!c.distribution_activated(),E_DISTRIBUTION_ACTIVATED)?;
 let mut r=Receipt::read(&a[1],program,a[0].key)?;
 require(c.state.phase==PHASE_LIVE,E_NOT_LAUNCHED)?;require(r.settled,E_CLAIM_INVALID)?;
 if r.claimed{return Ok(())}
 let reserve=c.terms.split()?.participants;
 let amount=participant_tokens(reserve,r.accepted,c.state.settled_accepted)?;
 let claimed=add(c.state.participant_claimed,amount)?;require(claimed<=reserve,E_OVERFLOW)?;
 custody_transfer(program,&c,&a[0],&a[2],&a[3],&a[4],&a[5],&r.owner,&a[6],amount)?;
 c.state.participant_claimed=claimed;r.claimed=true;r.claimed_tokens=amount;c.write(&a[0])?;r.write(&a[1])
}
/// Tag 8, no body. Accounts: 0 campaign, 1 launch authority PDA, 2 child mint, 3 custody token account, 4 the
/// sealed dev's associated token account, 5 Token. Pays the vested entitlement less what was already paid;
/// refused with error 40 when a distribution program is activated.
pub fn claim_dev(program:&Pubkey,a:&[AccountInfo],body:&[u8])->ProgramResult{
 require(body.is_empty(),E_TERMS_INVALID)?;require(a.len()==6,E_ACCOUNT_COUNT)?;
 let mut c=Campaign::read(&a[0],program)?;require(!c.distribution_activated(),E_DISTRIBUTION_ACTIVATED)?;
 require(c.state.phase==PHASE_LIVE,E_NOT_LAUNCHED)?;
 let entitled=dev_entitled(c.terms.supply,c.terms.vesting,c.state.launch_time,now()?)?;
 require(entitled<=c.terms.split()?.dev,E_OVERFLOW)?;
 let amount=entitled.checked_sub(c.state.dev_claimed).ok_or(err(E_OVERFLOW))?;
 custody_transfer(program,&c,&a[0],&a[1],&a[2],&a[3],&a[4],&c.terms.dev,&a[5],amount)?;
 c.state.dev_claimed=entitled;c.write(&a[0])
}
