//! Fee cycle, tags 20 to 26: mirrors `programs/atomic-launch/src/fees.rs` bound to the sealed terms. LP fees of the
//! locked position are collected into a per-campaign fee custody (the `fee_authority` PDA's token accounts), the
//! coin side is burned (tag 26), the SOL side is split by the sealed fee weights (tag 23: treasury and dev paid,
//! the parent shares become buy-and-burn budgets, zero in Standard mode), and each parent budget is spent through
//! Jupiter and burned (tag 25). Recipients, parent mints and weights come only from the sealed terms. The sealed
//! treasury names the operator (tag 20; on Standard campaigns any payer may open the cycle, the operator being inert
//! there) and can replace it (tag 22); anyone may collect, distribute and burn (tags
//! 21, 23, 26) because those move measured amounts to sealed destinations only; the operator alone runs tag 25,
//! choosing the slice, the route and the quote, and its `min_out` must clear a floor the program derives from the
//! sealed reference pool of that parent (`reference_floor`).
//!
//! Every SOL amount here is WSOL in the fee custody. The fee authority PDA itself may hold lamports (a route's
//! Pump AMM leg funds a one-time accumulator account from the swap user, 24 September 2026); the operator tops
//! them up and no rule here reads or protects them.
use crate::{handlers::*,launch::{cpi,pool_state_discriminator,CPMM_AUTH_SEED,CPMM_POOL_SEED,LOCKED_LIQUIDITY_SEED,LOCK_AUTH_SEED,POOL_OFF_CREATOR_FEES_0,POOL_OFF_CREATOR_FEES_1,POOL_OFF_ENABLE_CREATOR_FEE,POOL_OFF_FUND_FEES_0,POOL_OFF_FUND_FEES_1,POOL_OFF_PROTOCOL_FEES_0,POOL_OFF_PROTOCOL_FEES_1,POOL_STATE_LEN},policy::*,state::*,*};
use solana_program::{instruction::{AccountMeta,Instruction},program::invoke_signed};

pub const FEE_STATE_SEED:&[u8]=b"fees";
pub const FEE_AUTHORITY_SEED:&[u8]=b"fee_authority";
/// Raydium CPMM `AmmConfig` PDA seed; the index is big-endian.
pub const CPMM_AMM_CONFIG_SEED:&[u8]=b"amm_config";
pub const JUPITER_EVENT_AUTHORITY_SEED:&[u8]=b"__event_authority";
/// Fee state (`FEE_STATE_LEN` bytes, magic `KIDSFEE2`): 8 campaign, 40 child pending, 48 SOL collected, 56 treasury
/// paid, 64 dev paid, 72 parent A allocated, 80 parent B allocated, 88 parent A spent, 96 parent B spent,
/// 104 parent A burned, 112 parent B burned, 120 child burned, 128 operator.
pub const FEE_STATE_LEN:usize=160;
pub const FEE_STATE_MAGIC:&[u8;8]=b"KIDSFEE2";
pub const OFF_FEE_CAMPAIGN:usize=8;
pub const OFF_FEE_CHILD:usize=40;
pub const OFF_FEE_TOTAL:usize=48;
pub const OFF_FEE_TREASURY:usize=56;
pub const OFF_FEE_DEV:usize=64;
pub const OFF_FEE_PARENT_A:usize=72;
pub const OFF_FEE_PARENT_B:usize=80;
pub const OFF_FEE_SPENT_A:usize=88;
pub const OFF_FEE_SPENT_B:usize=96;
pub const OFF_FEE_BURNED_A:usize=104;
pub const OFF_FEE_BURNED_B:usize=112;
pub const OFF_FEE_BURNED_CHILD:usize=120;
pub const OFF_FEE_OPERATOR:usize=128;
pub const COLLECT_CP_FEES:[u8;8]=[8,30,51,199,209,184,247,133];
pub const JUPITER_ROUTE_V2:[u8;8]=[0xbb,0x64,0xfa,0xcc,0x31,0xc4,0xaf,0x14];
/// Jupiter's classic `route`: route_plan vec first, then in_amount u64 | quoted_out_amount u64 | slippage_bps u16 |
/// platform_fee_bps u8 as the last 19 bytes.
pub const JUPITER_ROUTE_V1:[u8;8]=[0xe5,0x17,0xcb,0x97,0x7a,0xe3,0xad,0x2a];
/// Largest single buyback slice through the aggregator (0.5 SOL): a bad fill on one slice stays small.
pub const JUPITER_MAX_SLICE:u64=500_000_000;
pub const JUPITER_MAX_SLIPPAGE_BPS:u16=100;
pub const JUPITER_MAX_STEPS:u32=8;
/// How long a quote stays usable after the operator fetched it.
pub const QUOTE_VALIDITY_SECONDS:i64=120;
pub const BUY_BURN_FIXED_ACCOUNTS:usize=16;
pub const BUY_BURN_BODY_MIN:usize=25+34;

fn check(v:bool)->ProgramResult{require(v,E_FEE_ACCOUNT)}
fn key(a:&AccountInfo,k:&Pubkey)->ProgramResult{check(a.key==k)}
fn executable(a:&AccountInfo,k:&Pubkey)->ProgramResult{key(a,k)?;check(a.executable)}
fn pda(a:&AccountInfo,seeds:&[&[u8]],p:&Pubkey)->ProgramResult{key(a,&Pubkey::find_program_address(seeds,p).0)}
fn token(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey)->Result<u64,ProgramError>{token_account(a,mint,owner).map_err(|_|err(E_FEE_ACCOUNT))}
/// The fee authority's associated token account for `mint` under the classic Token program, with its balance.
fn custody(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey)->Result<u64,ProgramError>{check(*a.key==associated_token_address(owner,mint))?;token(a,mint,owner)}
/// Balance of a classic or Token-2022 token account holding `mint` for `owner`, initialized, not frozen, with no
/// delegate and no close authority. Token-2022 accounts carry type byte 2 at 165 and a TLV after it.
pub fn parent_token(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey,token_program:&Pubkey)->Result<u64,ProgramError>{
 check(a.owner==token_program&&is_token_program(token_program))?;
 let d=a.try_borrow_data()?;
 check(d.len()>=165&&(d.len()==165||(*token_program==TOKEN_2022_PROGRAM&&d[165]==2)))?;
 check(read_key(&d,0)?==*mint&&read_key(&d,32)?==*owner&&d[108]==1&&d[72..76]==[0;4]&&d[129..133]==[0;4])?;
 read64(&d,64)
}
pub fn parent_ata(owner:&Pubkey,mint:&Pubkey,token_program:&Pubkey)->Pubkey{Pubkey::find_program_address(&[owner.as_ref(),token_program.as_ref(),mint.as_ref()],&ASSOCIATED_TOKEN_PROGRAM).0}
pub fn fee_authority(campaign:&Pubkey,program:&Pubkey)->(Pubkey,u8){Pubkey::find_program_address(&[FEE_AUTHORITY_SEED,campaign.as_ref()],program)}
pub fn fee_state_address(campaign:&Pubkey,program:&Pubkey)->(Pubkey,u8){Pubkey::find_program_address(&[FEE_STATE_SEED,campaign.as_ref()],program)}
pub fn amm_config_address(amm_program:&Pubkey,index:u16)->Pubkey{Pubkey::find_program_address(&[CPMM_AMM_CONFIG_SEED,&index.to_be_bytes()],amm_program).0}

#[derive(Default,Clone,Copy,Debug,PartialEq,Eq)]
pub struct FeeState{pub child:u64,pub total:u64,pub treasury:u64,pub dev:u64,pub parent_a:u64,pub parent_b:u64,pub spent_a:u64,pub spent_b:u64,pub burned_a:u64,pub burned_b:u64,pub burned_child:u64,pub operator:Pubkey}
impl FeeState{
 pub fn decode(d:&[u8],campaign:&Pubkey)->Result<Self,ProgramError>{
  check(d.len()==FEE_STATE_LEN&&&d[..8]==FEE_STATE_MAGIC&&read_key(d,OFF_FEE_CAMPAIGN)?==*campaign)?;
  Ok(Self{child:read64(d,OFF_FEE_CHILD)?,total:read64(d,OFF_FEE_TOTAL)?,treasury:read64(d,OFF_FEE_TREASURY)?,dev:read64(d,OFF_FEE_DEV)?,parent_a:read64(d,OFF_FEE_PARENT_A)?,parent_b:read64(d,OFF_FEE_PARENT_B)?,spent_a:read64(d,OFF_FEE_SPENT_A)?,spent_b:read64(d,OFF_FEE_SPENT_B)?,burned_a:read64(d,OFF_FEE_BURNED_A)?,burned_b:read64(d,OFF_FEE_BURNED_B)?,burned_child:read64(d,OFF_FEE_BURNED_CHILD)?,operator:read_key(d,OFF_FEE_OPERATOR)?})
 }
 pub fn read(a:&AccountInfo,program:&Pubkey,campaign:&Pubkey)->Result<Self,ProgramError>{
  pda(a,&[FEE_STATE_SEED,campaign.as_ref()],program)?;check(a.owner==program)?;let d=a.try_borrow_data()?;Self::decode(&d,campaign)
 }
 pub fn encode(&self,d:&mut[u8],campaign:&Pubkey){
  d.fill(0);d[..8].copy_from_slice(FEE_STATE_MAGIC);d[OFF_FEE_CAMPAIGN..OFF_FEE_CAMPAIGN+32].copy_from_slice(campaign.as_ref());
  for(at,n)in[(OFF_FEE_CHILD,self.child),(OFF_FEE_TOTAL,self.total),(OFF_FEE_TREASURY,self.treasury),(OFF_FEE_DEV,self.dev),(OFF_FEE_PARENT_A,self.parent_a),(OFF_FEE_PARENT_B,self.parent_b),(OFF_FEE_SPENT_A,self.spent_a),(OFF_FEE_SPENT_B,self.spent_b),(OFF_FEE_BURNED_A,self.burned_a),(OFF_FEE_BURNED_B,self.burned_b),(OFF_FEE_BURNED_CHILD,self.burned_child)]{put64(d,at,n)}
  d[OFF_FEE_OPERATOR..OFF_FEE_OPERATOR+32].copy_from_slice(self.operator.as_ref());
 }
 pub fn write(&self,a:&AccountInfo,campaign:&Pubkey)->ProgramResult{let mut d=a.try_borrow_mut_data()?;check(d.len()==FEE_STATE_LEN)?;self.encode(&mut d,campaign);Ok(())}
 /// WSOL the custody must still hold: everything collected that was neither paid out nor spent on a parent.
 pub fn liability(&self)->Result<u64,ProgramError>{self.total.checked_sub(self.treasury).and_then(|n|n.checked_sub(self.dev)).and_then(|n|n.checked_sub(self.spent_a)).and_then(|n|n.checked_sub(self.spent_b)).ok_or(err(E_FEE_ARITHMETIC))}
 /// Unspent buy-and-burn budget of one parent.
 pub fn pending(&self,parent:u8)->Result<u64,ProgramError>{match parent{0=>self.parent_a.checked_sub(self.spent_a),1=>self.parent_b.checked_sub(self.spent_b),_=>None}.ok_or(err(E_FEE_ARITHMETIC))}
}
/// Forwards a call to the program at `program` with the given (index, signer, writable) metas plus every account from
/// `rest_from` onward exactly as it was passed to us (writable flags preserved, signer flags dropped except our PDA).
fn cpi_forward<'a>(a:&[AccountInfo<'a>],program:usize,spec:&[(usize,bool,bool)],rest_from:usize,data:Vec<u8>,seeds:&[&[u8]])->ProgramResult{
 let mut accounts:Vec<AccountMeta>=spec.iter().map(|(i,s,w)|if *w{AccountMeta::new(*a[*i].key,*s)}else{AccountMeta::new_readonly(*a[*i].key,*s)}).collect();
 let mut infos:Vec<AccountInfo<'a>>=spec.iter().map(|(i,_,_)|a[*i].clone()).collect();
 for info in &a[rest_from..]{accounts.push(if info.is_writable{AccountMeta::new(*info.key,false)}else{AccountMeta::new_readonly(*info.key,false)});infos.push(info.clone());}
 infos.push(a[program].clone());
 invoke_signed(&Instruction{program_id:*a[program].key,accounts,data},&infos,&[seeds])
}
fn transfer<'a>(a:&[AccountInfo<'a>],program:usize,from:usize,to:usize,amount:u64,seeds:&[&[u8]])->ProgramResult{
 if amount==0{return Ok(())}let mut data=vec![3];data.extend_from_slice(&amount.to_le_bytes());cpi(a,program,&[(from,false,true),(to,false,true),(3,true,false)],data,seeds)
}
fn burn<'a>(a:&[AccountInfo<'a>],program:usize,account:usize,mint:usize,amount:u64,seeds:&[&[u8]])->ProgramResult{
 let mut data=vec![8];data.extend_from_slice(&amount.to_le_bytes());cpi(a,program,&[(account,false,true),(mint,false,true),(3,true,false)],data,seeds)
}
/// A Raydium CPMM pool owned by `amm_program`, on `config`, at its canonical address. Returns the ten keys of the
/// pool state in layout order (config, creator, vault 0, vault 1, LP mint, mint 0, mint 1, program 0, program 1,
/// observation).
fn pool(a:&AccountInfo,amm_program:&Pubkey,config:&Pubkey)->Result<[Pubkey;10],ProgramError>{
 check(*a.owner==*amm_program)?;let d=a.try_borrow_data()?;check(d.len()==POOL_STATE_LEN&&d[..8]==pool_state_discriminator())?;
 let keys:[Pubkey;10]=std::array::from_fn(|i|Pubkey::new_from_array(d[8+i*32..40+i*32].try_into().unwrap()));
 check(keys[0]==*config&&keys[5]<keys[6])?;
 pda(a,&[CPMM_POOL_SEED,keys[0].as_ref(),keys[5].as_ref(),keys[6].as_ref()],amm_program)?;Ok(keys)
}
/// The floor for one tag 25 slice, read from the parent's sealed reference pool: the canonical Raydium CPMM pool of
/// the parent and WSOL on the sealed config index, under the sealed AMM program. Accounts: 12 the reference AMM
/// config, 13 the reference pool, 14 its parent vault, 15 its WSOL vault; every address is derived, none is taken
/// from the caller. The reserves are the vault balances net of the fees the pool holds for its protocol, fund and
/// creator; a pool with the creator fee switched on is refused because its swap charges more than the trade fee.
#[inline(never)]
fn reference_floor(a:&[AccountInfo],t:&Terms,parent:usize,amount:u64)->Result<u64,ProgramError>{
 let index=t.reference_config_index(parent).ok_or(err(E_FEE_REFERENCE))?;
 let parent_mint=t.parent_mint[parent];let parent_program=t.parent_program[parent];
 let config=amm_config_address(&t.amm_program,index);key(&a[12],&config)?;check(*a[12].owner==t.amm_program)?;
 let rate={let d=a[12].try_borrow_data()?;check(d.len()==AMM_CONFIG_LEN&&d[..8]==amm_config_discriminator()&&u16::from_le_bytes([d[AMM_CONFIG_OFF_INDEX],d[AMM_CONFIG_OFF_INDEX+1]])==index)?;read64(&d,AMM_CONFIG_OFF_TRADE_FEE_RATE)?};
 let p=pool(&a[13],&t.amm_program,&config)?;
 let parent_first=p[5]==parent_mint;
 check((parent_first&&p[6]==WSOL)||(p[5]==WSOL&&p[6]==parent_mint))?;
 let(parent_vault,wsol_vault,parent_side_program,wsol_side_program)=if parent_first{(p[2],p[3],p[7],p[8])}else{(p[3],p[2],p[8],p[7])};
 check(parent_side_program==parent_program&&wsol_side_program==TOKEN_PROGRAM)?;
 key(&a[14],&parent_vault)?;key(&a[15],&wsol_vault)?;
 let cpmm_authority=Pubkey::find_program_address(&[CPMM_AUTH_SEED],&t.amm_program).0;
 let raw_parent=parent_token(&a[14],&parent_mint,&cpmm_authority,&parent_program)?;
 let raw_wsol=token(&a[15],&WSOL,&cpmm_authority)?;
 let(held_parent,held_wsol)={
  let d=a[13].try_borrow_data()?;require(d[POOL_OFF_ENABLE_CREATOR_FEE]==0,E_FEE_REFERENCE)?;
  let held0=add(add(read64(&d,POOL_OFF_PROTOCOL_FEES_0)?,read64(&d,POOL_OFF_FUND_FEES_0)?)?,read64(&d,POOL_OFF_CREATOR_FEES_0)?)?;
  let held1=add(add(read64(&d,POOL_OFF_PROTOCOL_FEES_1)?,read64(&d,POOL_OFF_FUND_FEES_1)?)?,read64(&d,POOL_OFF_CREATOR_FEES_1)?)?;
  if parent_first{(held0,held1)}else{(held1,held0)}
 };
 let reserve_parent=raw_parent.checked_sub(held_parent).ok_or(err(E_FEE_REFERENCE))?;
 let reserve_wsol=raw_wsol.checked_sub(held_wsol).ok_or(err(E_FEE_REFERENCE))?;
 Ok(buyback_floor(reference_out(amount,reserve_wsol,reserve_parent,rate)?,t.buyback_max_slippage_bps))
}
/// Which Jupiter instruction the bytes are, once every header rule holds: Some(2) for `route_v2`, Some(1) for
/// `route`, None otherwise. The slice must be spent exactly, the quote minus the allowed slippage must still clear
/// the minimum, slippage is capped, no platform fee, 1 to 8 steps. `route_v2` header: disc | in_amount u64 |
/// quoted_out_amount u64 | slippage_bps u16 | platform_fee_bps u16 | positive_slippage_bps u16 | route_plan vec.
pub fn jupiter_route_kind(route:&[u8],amount:u64,min:u64)->Option<u8>{
 if route.len()<34{return None}
 let(in_amount,quoted,slippage,platform_fee,steps,kind)=if route[..8]==JUPITER_ROUTE_V2{
  let(Ok(i),Ok(q))=(read64(route,8),read64(route,16))else{return None};
  (i,q,u16::from_le_bytes([route[24],route[25]]),u16::from_le_bytes([route[26],route[27]]),u32::from_le_bytes([route[30],route[31],route[32],route[33]]),2u8)
 }else if route[..8]==JUPITER_ROUTE_V1{
  let n=route.len();let(Ok(i),Ok(q))=(read64(route,n-19),read64(route,n-11))else{return None};
  (i,q,u16::from_le_bytes([route[n-3],route[n-2]]),route[n-1] as u16,u32::from_le_bytes([route[8],route[9],route[10],route[11]]),1u8)
 }else{return None};
 let ok=in_amount==amount&&quoted>=min&&slippage<=JUPITER_MAX_SLIPPAGE_BPS&&platform_fee==0&&(1..=JUPITER_MAX_STEPS).contains(&steps)&&quoted.saturating_sub((quoted as u128*slippage as u128/10_000) as u64)>=min;
 if ok{Some(kind)}else{None}
}
/// What every fee tag shares once the campaign, the caller slot and the fee authority are checked. References
/// only: the campaign (about 1 KiB) lives in `process`'s frame once, and each tag runs in its own
/// `#[inline(never)]` function whose frame holds that tag's locals and nothing else. The SBF stack frame is 4 KiB;
/// one function holding every tag's locals plus the campaign overflowed it (`cargo build-sbf`, 24 September 2026).
struct FeeCall<'a,'b>{program:&'b Pubkey,a:&'b[AccountInfo<'a>],body:&'b[u8],campaign:&'b Campaign,authority:Pubkey,seeds:&'b[&'b[u8]]}
impl FeeCall<'_,'_>{
 fn signed_by(&self,expected:&Pubkey)->ProgramResult{if !self.a[1].is_signer{return Err(ProgramError::MissingRequiredSignature)}require(*self.a[1].key==*expected,E_FEE_OPERATOR)}
 /// Body of tags 20 and 22: the operator key, neither zero nor the fee authority itself.
 fn operator_key(&self)->Result<Pubkey,ProgramError>{
  require(self.body.len()==32,E_TERMS_INVALID)?;let operator=read_key(self.body,0)?;
  require(operator!=Pubkey::default()&&operator!=self.authority,E_FEE_OPERATOR)?;Ok(operator)
 }
}
/// Common accounts of every fee tag: 0 campaign (live), 1 caller, 2 fee state PDA `["fees", campaign]`, 3 fee
/// authority PDA `["fee_authority", campaign]`. Tag 22 (and tag 20 on Family campaigns) needs the sealed treasury's signature at 1, tag 20 on Standard campaigns any signer at 1, and tag 25
/// the recorded operator's; tags 21, 23 and 26 take any caller, signed or not, because every amount they move is
/// measured against the custody and every destination is sealed.
pub fn process(program:&Pubkey,a:&[AccountInfo],body:&[u8],tag:u8)->ProgramResult{
 require(a.len()>=4,E_ACCOUNT_COUNT)?;
 let c=Campaign::read(&a[0],program)?;
 require(c.state.phase==PHASE_LIVE,E_NOT_LAUNCHED)?;
 let(authority,bump)=fee_authority(a[0].key,program);key(&a[3],&authority)?;
 let bump_seed=[bump];let seeds:&[&[u8]]=&[FEE_AUTHORITY_SEED,a[0].key.as_ref(),&bump_seed];
 let call=FeeCall{program,a,body,campaign:&c,authority,seeds};
 match tag{
  TAG_FEES_INIT=>init(&call),
  TAG_FEES_ROTATE_OPERATOR=>rotate_operator(&call),
  TAG_FEES_COLLECT=>with_state(&call,collect),
  TAG_FEES_DISTRIBUTE=>with_state(&call,distribute),
  TAG_FEES_BUY_BURN=>with_state(&call,buy_burn),
  TAG_FEES_BURN_CHILD=>with_state(&call,burn_child),
  _=>Err(ProgramError::InvalidInstructionData),
 }
}
/// Tags 21, 23, 25 and 26 read the fee state, run, and write it back only when the tag succeeded.
#[inline(never)]
fn with_state(call:&FeeCall,run:fn(&FeeCall,&mut FeeState)->ProgramResult)->ProgramResult{
 let mut state=FeeState::read(&call.a[2],call.program,call.a[0].key)?;
 run(call,&mut state)?;
 state.write(&call.a[2],call.a[0].key)
}
/// Tag 20. Body: the operator key. Accounts: 0..3, 4 System. Family: the sealed treasury signs and pays the fee state
/// rent, because the operator it names runs the parent buybacks (tag 25). Standard: any signer at 1 pays the rent; the
/// operator has no power there (tag 25 refuses Standard campaigns) and every destination of the cycle is sealed, so a
/// hosted keeper can open the cycle without the treasury key (28 September 2026).
#[inline(never)]
fn init(call:&FeeCall)->ProgramResult{
 let a=call.a;
 if call.campaign.terms.is_family(){call.signed_by(&call.campaign.terms.treasury)?;}else if !a[1].is_signer{return Err(ProgramError::MissingRequiredSignature)}
 let operator=call.operator_key()?;
 require(a.len()==5,E_ACCOUNT_COUNT)?;system(&a[4])?;
 let(expected,state_bump)=fee_state_address(a[0].key,call.program);key(&a[2],&expected)?;
 create_pda(&a[1],&a[2],&a[4],call.program,FEE_STATE_LEN,&[FEE_STATE_SEED,a[0].key.as_ref(),&[state_bump]])?;
 FeeState{operator,..FeeState::default()}.write(&a[2],a[0].key)
}
/// Tag 22. Body: the new operator key. Accounts: 0..3; the sealed treasury signs. Replaces the operator only.
#[inline(never)]
fn rotate_operator(call:&FeeCall)->ProgramResult{
 let a=call.a;
 call.signed_by(&call.campaign.terms.treasury)?;let operator=call.operator_key()?;
 require(a.len()==4,E_ACCOUNT_COUNT)?;
 FeeState{operator,..FeeState::read(&a[2],call.program,a[0].key)?}.write(&a[2],a[0].key)
}
/// Tag 21. Accounts: 4 child custody, 5 WSOL custody, 6 fee NFT ATA of the campaign, 7 locked liquidity PDA,
/// 8 pool, 9 LP mint, 10 vault 0, 11 vault 1, 12 mint 0, 13 mint 1, 14 lock authority's LP ATA, 15 the sealed AMM
/// program, 16 AMM authority, 17 the sealed lock program, 18 lock authority, 19 Token, 20 Token-2022, 21 Memo.
/// Body: fee_lp_amount u64 (the LP share the lock program may redeem for this harvest).
#[inline(never)]
fn collect(call:&FeeCall,state:&mut FeeState)->ProgramResult{
 let(a,body,c,t,authority)=(call.a,call.body,call.campaign,&call.campaign.terms,&call.authority);
 require(a.len()==22,E_ACCOUNT_COUNT)?;require(body.len()==8&&read64(body,0)?>0,E_TERMS_INVALID)?;
 executable(&a[15],&t.amm_program)?;executable(&a[17],&t.lock_program)?;executable(&a[19],&TOKEN_PROGRAM)?;executable(&a[20],&TOKEN_2022_PROGRAM)?;executable(&a[21],&MEMO_PROGRAM)?;
 let lock_authority=Pubkey::find_program_address(&[LOCK_AUTH_SEED],&t.lock_program).0;key(&a[18],&lock_authority)?;
 let before_child=custody(&a[4],&t.child_mint,authority)?;let before_sol=custody(&a[5],&WSOL,authority)?;
 require(before_child>=state.child&&before_sol>=state.liability()?,E_FEE_ARITHMETIC)?;
 check(custody(&a[6],&c.state.fee_nft,a[0].key)?==1)?;
 pda(&a[7],&[LOCKED_LIQUIDITY_SEED,c.state.fee_nft.as_ref()],&t.lock_program)?;check(*a[7].owner==t.lock_program)?;
 key(&a[8],&c.state.pool)?;let p=pool(&a[8],&t.amm_program,&t.amm_config)?;key(&a[9],&p[4])?;key(&a[10],&p[2])?;key(&a[11],&p[3])?;key(&a[12],&p[5])?;key(&a[13],&p[6])?;
 check(((p[5]==t.child_mint&&p[6]==WSOL)||(p[6]==t.child_mint&&p[5]==WSOL))&&p[7]==TOKEN_PROGRAM&&p[8]==TOKEN_PROGRAM)?;
 pda(&a[16],&[CPMM_AUTH_SEED],&t.amm_program)?;custody(&a[14],a[9].key,&lock_authority)?;
 let(dest0,dest1)=if p[5]==t.child_mint{(4,5)}else{(5,4)};
 let mut data=COLLECT_CP_FEES.to_vec();data.extend_from_slice(body);
 // The campaign PDA owns the fee NFT and signs the collection. Lock `collect_cp_fees`: authority, fee_nft_owner,
 // fee_nft_account, locked_liquidity, cp_swap_program, cp_authority, pool_state, lp_mint, recipient_token_0,
 // recipient_token_1, token_0_vault, token_1_vault, vault_0_mint, vault_1_mint, locked_lp_vault, token_program,
 // token_program_2022, memo_program.
 let nonce=t.nonce.to_le_bytes();let campaign_bump=[c.state.bump];let campaign_seeds:&[&[u8]]=&[CAMPAIGN_SEED,t.creator.as_ref(),&nonce,&campaign_bump];
 cpi(a,17,&[(18,false,false),(0,true,false),(6,false,true),(7,false,true),(15,false,false),(16,false,false),(8,false,true),(9,false,true),(dest0,false,true),(dest1,false,true),(10,false,true),(11,false,true),(12,false,false),(13,false,false),(14,false,true),(19,false,false),(20,false,false),(21,false,false)],data,campaign_seeds)?;
 let gained_child=custody(&a[4],&t.child_mint,authority)?.checked_sub(before_child).ok_or(err(E_FEE_ARITHMETIC))?;
 let gained_sol=custody(&a[5],&WSOL,authority)?.checked_sub(before_sol).ok_or(err(E_FEE_ARITHMETIC))?;
 state.child=add(state.child,gained_child)?;state.total=add(state.total,gained_sol)?;Ok(())
}
/// Tag 23. Accounts: 4 WSOL custody, 5 the sealed treasury's WSOL ATA, 6 the sealed dev's WSOL ATA, 7 Token. No
/// body. Pays each recipient its cumulative entitlement less what it received; records the parent budgets.
#[inline(never)]
fn distribute(call:&FeeCall,state:&mut FeeState)->ProgramResult{
 let(a,t,authority,seeds)=(call.a,&call.campaign.terms,&call.authority,call.seeds);
 require(a.len()==8,E_ACCOUNT_COUNT)?;require(call.body.is_empty(),E_TERMS_INVALID)?;executable(&a[7],&TOKEN_PROGRAM)?;
 require(custody(&a[4],&WSOL,authority)?>=state.liability()?,E_FEE_ARITHMETIC)?;custody(&a[5],&WSOL,&t.treasury)?;custody(&a[6],&WSOL,&t.dev)?;
 check(t.treasury!=*authority&&t.dev!=*authority)?;
 let entitled=fee_entitlements(state.total,t.fee_weights)?;
 let treasury=entitled.treasury.checked_sub(state.treasury).ok_or(err(E_FEE_ARITHMETIC))?;let dev=entitled.dev.checked_sub(state.dev).ok_or(err(E_FEE_ARITHMETIC))?;
 transfer(a,7,4,5,treasury,seeds)?;transfer(a,7,4,6,dev,seeds)?;
 state.treasury=entitled.treasury;state.dev=entitled.dev;state.parent_a=entitled.parent_a;state.parent_b=entitled.parent_b;
 require(custody(&a[4],&WSOL,authority)?>=state.liability()?,E_FEE_ARITHMETIC)
}
/// Tag 25: buy-and-burn a sealed parent through Jupiter (Family only), operator-signed. Accounts: 4 WSOL custody,
/// 5 parent custody (the fee authority's ATA under the parent's token program), 6 parent mint, 7 WSOL mint, 8 Token,
/// 9 the parent's token program, 10 Jupiter, 11 Jupiter event authority, 12 the reference AMM config, 13 the
/// reference pool, 14 its parent vault, 15 its WSOL vault, 16.. the route's remaining accounts as Jupiter's API
/// listed them. Body: parent u8, amount u64, min_out u64, expiry i64, then the Jupiter `route` or `route_v2` data
/// verbatim.
#[inline(never)]
fn buy_burn(call:&FeeCall,state:&mut FeeState)->ProgramResult{
 let(a,body,t,authority,seeds)=(call.a,call.body,&call.campaign.terms,&call.authority,call.seeds);
 call.signed_by(&state.operator)?;
 require(a.len()>=BUY_BURN_FIXED_ACCOUNTS,E_ACCOUNT_COUNT)?;require(body.len()>=BUY_BURN_BODY_MIN,E_TERMS_INVALID)?;
 let parent=body[0];let amount=read64(body,1)?;let min=read64(body,9)?;let expiry=read64(body,17)? as i64;let route=&body[25..];
 require(t.is_family(),E_MODE_PARENTS)?;check(parent<2)?;
 let now=now()?;require(expiry>=now&&expiry<=now.saturating_add(QUOTE_VALIDITY_SECONDS)&&min>0,E_FEE_ROUTE)?;
 require(amount>0&&amount<=JUPITER_MAX_SLICE,E_FEE_ROUTE)?;require(amount<=state.pending(parent)?,E_FEE_ARITHMETIC)?;
 let parent_mint=t.parent_mint[parent as usize];let parent_program=t.parent_program[parent as usize];
 // Create refuses WSOL as a parent (error 16); kept here so a route can never read and write one custody account.
 require(parent_mint!=WSOL,E_MODE_PARENTS)?;
 key(&a[6],&parent_mint)?;key(&a[7],&WSOL)?;executable(&a[8],&TOKEN_PROGRAM)?;
 let(supply,mint_program)=parent_mint_supply(&a[6])?;check(mint_program==parent_program)?;executable(&a[9],&parent_program)?;
 executable(&a[10],&JUPITER_PROGRAM)?;pda(&a[11],&[JUPITER_EVENT_AUTHORITY_SEED],&JUPITER_PROGRAM)?;
 let parent_custody=|acc:&AccountInfo|->Result<u64,ProgramError>{check(*acc.key==parent_ata(authority,&parent_mint,&parent_program))?;parent_token(acc,&parent_mint,authority,&parent_program)};
 let input=custody(&a[4],&WSOL,authority)?;let output=parent_custody(&a[5])?;require(input>=state.liability()?,E_FEE_ARITHMETIC)?;
 // The fee authority signs the whole route, so no remaining account may be one of its other custody accounts (the
 // coin custody or the other parent's custody): a route step could otherwise spend from them unchecked. The WSOL
 // and parent custody accounts appear again among the remaining accounts for Jupiter's swap steps; the effect
 // checks below bound those two.
 let child_custody=associated_token_address(authority,&t.child_mint);
 let other=t.parent_mint[1-parent as usize];
 let other_classic=parent_ata(authority,&other,&TOKEN_PROGRAM);let other_2022=parent_ata(authority,&other,&TOKEN_2022_PROGRAM);
 for info in &a[BUY_BURN_FIXED_ACCOUNTS..]{check(*info.key!=child_custody&&*info.key!=other_classic&&*info.key!=other_2022)?;}
 let kind=jupiter_route_kind(route,amount,min).ok_or(err(E_FEE_ROUTE))?;
 require(min>=reference_floor(a,t,parent as usize,amount)?,E_FEE_PRICE_FLOOR)?;
 if kind==2{
  // route_v2 accounts: user_transfer_authority (our PDA signs), user source, user destination, source mint, destination
  // mint, source token program, destination token program, destination_token_account (omitted: the program id), event
  // authority, program.
  cpi_forward(a,10,&[(3,true,false),(4,false,true),(5,false,true),(7,false,false),(6,false,false),(8,false,false),(9,false,false),(10,false,false),(11,false,false),(10,false,false)],BUY_BURN_FIXED_ACCOUNTS,route.to_vec(),seeds)?;
 }else{
  // route accounts: token program of the destination mint, user_transfer_authority (our PDA signs), user source, user
  // destination, destination_token_account (omitted: the program id), destination mint, platform_fee_account (omitted:
  // the program id), event authority, program. Both optional slots are pinned to the program id so nothing is redirected.
  cpi_forward(a,10,&[(9,false,false),(3,true,false),(4,false,true),(5,false,true),(10,false,false),(6,false,false),(10,false,false),(11,false,false),(10,false,false)],BUY_BURN_FIXED_ACCOUNTS,route.to_vec(),seeds)?;
 }
 require(custody(&a[4],&WSOL,authority)?==input.checked_sub(amount).ok_or(err(E_FEE_ARITHMETIC))?,E_FEE_ARITHMETIC)?;
 let received=parent_custody(&a[5])?.checked_sub(output).ok_or(err(E_FEE_ARITHMETIC))?;require(received>=min,E_FEE_ARITHMETIC)?;
 burn(a,9,5,6,received,seeds)?;
 require(parent_custody(&a[5])?==output&&parent_mint_supply(&a[6])?.0==supply.checked_sub(received).ok_or(err(E_FEE_ARITHMETIC))?,E_FEE_ARITHMETIC)?;
 if parent==0{state.spent_a=add(state.spent_a,amount)?;state.burned_a=add(state.burned_a,received)?;}else{state.spent_b=add(state.spent_b,amount)?;state.burned_b=add(state.burned_b,received)?;}
 require(custody(&a[4],&WSOL,authority)?>=state.liability()?,E_FEE_ARITHMETIC)
}
/// Tag 26: burn coin-side fees (owner, 23 September 2026). Accounts: 4 child custody, 5 child mint, 6 Token.
/// Body: amount u64, up to the pending coin amount.
#[inline(never)]
fn burn_child(call:&FeeCall,state:&mut FeeState)->ProgramResult{
 let(a,body,t,authority,seeds)=(call.a,call.body,&call.campaign.terms,&call.authority,call.seeds);
 require(a.len()==7,E_ACCOUNT_COUNT)?;require(body.len()==8,E_TERMS_INVALID)?;let amount=read64(body,0)?;
 require(amount>0&&amount<=state.child,E_FEE_ARITHMETIC)?;
 key(&a[5],&t.child_mint)?;executable(&a[6],&TOKEN_PROGRAM)?;
 let before=custody(&a[4],&t.child_mint,authority)?;require(before>=state.child,E_FEE_ARITHMETIC)?;
 burn(a,6,4,5,amount,seeds)?;
 require(custody(&a[4],&t.child_mint,authority)?==before-amount,E_FEE_ARITHMETIC)?;
 state.child-=amount;state.burned_child=add(state.burned_child,amount)?;Ok(())
}
#[cfg(test)]pub mod tests{use super::*;
 pub fn route_v2_header(in_amount:u64,quoted:u64,slippage:u16,fee:u16,steps:u32)->Vec<u8>{let mut r=JUPITER_ROUTE_V2.to_vec();r.extend_from_slice(&in_amount.to_le_bytes());r.extend_from_slice(&quoted.to_le_bytes());r.extend_from_slice(&slippage.to_le_bytes());r.extend_from_slice(&fee.to_le_bytes());r.extend_from_slice(&0u16.to_le_bytes());r.extend_from_slice(&steps.to_le_bytes());r}
 pub fn route_v1(in_amount:u64,quoted:u64,slippage:u16,fee:u8,steps:u32)->Vec<u8>{let mut r=JUPITER_ROUTE_V1.to_vec();r.extend_from_slice(&steps.to_le_bytes());for _ in 0..steps{r.extend_from_slice(&[46,0,100,0,1]);}r.extend_from_slice(&in_amount.to_le_bytes());r.extend_from_slice(&quoted.to_le_bytes());r.extend_from_slice(&slippage.to_le_bytes());r.push(fee);r}
 #[test]fn jupiter_route_header_rules(){
  let header=route_v2_header;
  assert_eq!(jupiter_route_kind(&header(1000,10_000,100,0,1),1000,9_900),Some(2));
  assert!(jupiter_route_kind(&header(1000,10_000,100,0,1),1000,9_901).is_none(),"slippage may not eat below min");
  assert!(jupiter_route_kind(&header(999,10_000,50,0,1),1000,9_000).is_none(),"in_amount must equal the slice");
  assert!(jupiter_route_kind(&header(1000,10_000,101,0,1),1000,1).is_none(),"slippage capped at 1 %");
  assert!(jupiter_route_kind(&header(1000,10_000,10,5,1),1000,1).is_none(),"no platform fee");
  assert!(jupiter_route_kind(&header(1000,10_000,10,0,0),1000,1).is_none()&&jupiter_route_kind(&header(1000,10_000,10,0,9),1000,1).is_none(),"1 to 8 steps");
  let mut wrong=header(1000,10_000,10,0,1);wrong[0]^=1;assert!(jupiter_route_kind(&wrong,1000,1).is_none(),"only Jupiter route instructions");
  assert_eq!(jupiter_route_kind(&route_v1(1000,10_000,100,0,1),1000,9_900),Some(1));
  assert_eq!(jupiter_route_kind(&route_v1(1000,10_000,100,0,2),1000,9_900),Some(1),"the tail is found whatever the plan length");
  assert!(jupiter_route_kind(&route_v1(999,10_000,50,0,1),1000,9_000).is_none());
  assert!(jupiter_route_kind(&route_v1(1000,10_000,101,0,1),1000,1).is_none());
  assert!(jupiter_route_kind(&route_v1(1000,10_000,10,1,1),1000,1).is_none());
  assert!(jupiter_route_kind(&route_v1(1000,10_000,10,0,0),1000,1).is_none()&&jupiter_route_kind(&route_v1(1000,10_000,10,0,9),1000,1).is_none());
  assert!(jupiter_route_kind(&route_v1(1000,10_000,100,0,1),1000,9_901).is_none());
  assert!(jupiter_route_kind(&header(1000,10_000,10,0,1)[..30],1000,1).is_none(),"short data refused");
  assert_eq!(JUPITER_MAX_SLICE,500_000_000);
 }
 #[test]fn amm_config_addresses_derive_from_their_index(){
  for(index,address,_)in AMM_CONFIG_TIERS{assert_eq!(amm_config_address(&RAYDIUM_CPMM,index),address,"index {index}");}
  assert_ne!(amm_config_address(&RAYDIUM_CPMM,0),amm_config_address(&RAYDIUM_CPMM,1));
 }
 #[test]fn fee_state_round_trips_and_binds_the_campaign(){
  let campaign=Pubkey::new_unique();let operator=Pubkey::new_unique();
  let s=FeeState{child:1,total:2,treasury:3,dev:4,parent_a:5,parent_b:6,spent_a:7,spent_b:8,burned_a:9,burned_b:10,burned_child:11,operator};
  let mut d=vec![0u8;FEE_STATE_LEN];s.encode(&mut d,&campaign);
  assert_eq!(&d[..8],b"KIDSFEE2");assert_eq!(&d[8..40],campaign.as_ref());for(i,n)in(1u64..=11).enumerate(){assert_eq!(read64(&d,40+8*i).unwrap(),n);}assert_eq!(&d[128..160],operator.as_ref());
  assert_eq!(FeeState::decode(&d,&campaign).unwrap(),s);assert!(FeeState::decode(&d,&Pubkey::new_unique()).is_err());assert!(FeeState::decode(&d[..159],&campaign).is_err());
  assert!(s.liability().is_err(),"paid more than collected is unreadable");
 }
 #[test]fn spent_parent_budget_never_reopens_and_liability_is_what_custody_still_owes(){
  let s=FeeState{total:168,treasury:98,dev:20,parent_a:25,parent_b:25,spent_a:25,spent_b:0,..FeeState::default()};
  assert_eq!(s.pending(0).unwrap(),0);assert_eq!(s.pending(1).unwrap(),25);assert_eq!(s.liability().unwrap(),25);assert!(s.pending(2).is_err());
  assert!(FeeState{total:10,treasury:11,..FeeState::default()}.liability().is_err());
 }
}
