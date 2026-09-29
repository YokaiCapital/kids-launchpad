//! Fee Key collection and fixed-beneficiary fee routing. No arbitrary CPI or withdrawal.
//! Coin-side earnings are burned (tag 26). SOL earnings are allocated cumulatively 98:20:25:25 (tag 23); the two
//! parent shares are one budget that buys and burns the coin through the campaign's own pool (tag 27).
use super::*;
use solana_program::{instruction::{AccountMeta,Instruction},pubkey};
const TOKEN:Pubkey=pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN22:Pubkey=pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA:Pubkey=pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CPMM:Pubkey=pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
// Raydium CPMM fee tiers this program accepts: 2 % (index 2, the localnet clone) and 2.5 % (index 7, mainnet).
const CONFIGS:[Pubkey;2]=[pubkey!("2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5"),pubkey!("ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi")];
const LOCK:Pubkey=pubkey!("LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE");
const LOCK_AUTH:Pubkey=pubkey!("3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH");
const MEMO:Pubkey=pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const WSOL:Pubkey=pubkey!("So11111111111111111111111111111111111111112");
/// Largest single coin buyback slice (0.5 SOL): a bad fill on one slice stays small.
pub(super) const CHILD_BUYBACK_MAX_SLICE:u64=500_000_000;
/// Sealed cap on how far below the pool's spot quote a coin buyback may fill (1 %). The keeper's min_out may be
/// stricter, never looser.
pub(super) const CHILD_BUYBACK_MAX_SLIPPAGE_BPS:u64=100;
const LEN:usize=128;
const MAGIC:&[u8;8]=b"KIDSFEE1";
fn require(v:bool)->ProgramResult{if v{Ok(())}else{Err(err(60))}}
fn key(a:&AccountInfo,k:&Pubkey)->ProgramResult{require(a.key==k)}
fn executable(a:&AccountInfo,k:&Pubkey)->ProgramResult{key(a,k)?;require(a.executable)}
fn pda(a:&AccountInfo,seeds:&[&[u8]],p:&Pubkey)->ProgramResult{key(a,&Pubkey::find_program_address(seeds,p).0)}
fn ata(a:&AccountInfo,owner:&Pubkey,mint:&Pubkey)->ProgramResult{pda(a,&[owner.as_ref(),TOKEN.as_ref(),mint.as_ref()],&ATA)}
fn token(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey)->Result<u64,ProgramError>{
 require(*a.owner==TOKEN)?;let d=a.try_borrow_data()?;require(d.len()==165)?;
 require(read_key(&d,0)?==*mint&&read_key(&d,32)?==*owner&&d[108]==1&&d[72..76]==[0;4]&&d[129..133]==[0;4])?;read64(&d,64)
}
fn mint_supply(a:&AccountInfo)->Result<u64,ProgramError>{require(*a.owner==TOKEN)?;let d=a.try_borrow_data()?;require(d.len()==82&&d[45]==1)?;read64(&d,36)}
fn custody(a:&AccountInfo,mint:&Pubkey,owner:&Pubkey)->Result<u64,ProgramError>{ata(a,owner,mint)?;token(a,mint,owner)}
#[derive(Default,Clone,Debug)]
struct State{child:u64,total:u64,treasury:u64,dev:u64,parent_a:u64,parent_b:u64,spent_a:u64,spent_b:u64,burned_a:u64,burned_b:u64,burned_child:u64}
impl State{
 fn read(a:&AccountInfo,p:&Pubkey,campaign:&Pubkey)->Result<Self,ProgramError>{
  pda(a,&[b"fees",campaign.as_ref()],p)?;require(a.owner==p)?;let d=a.try_borrow_data()?;
  require(d.len()==LEN&&&d[..8]==MAGIC&&read_key(&d,8)?==*campaign)?;
  Ok(Self{child:read64(&d,40)?,total:read64(&d,48)?,treasury:read64(&d,56)?,dev:read64(&d,64)?,parent_a:read64(&d,72)?,parent_b:read64(&d,80)?,spent_a:read64(&d,88)?,spent_b:read64(&d,96)?,burned_a:read64(&d,104)?,burned_b:read64(&d,112)?,burned_child:read64(&d,120)?})
 }
 fn write(&self,a:&AccountInfo,campaign:&Pubkey)->ProgramResult{let mut d=a.try_borrow_mut_data()?;d[..8].copy_from_slice(MAGIC);d[8..40].copy_from_slice(campaign.as_ref());for(at,n)in[(40,self.child),(48,self.total),(56,self.treasury),(64,self.dev),(72,self.parent_a),(80,self.parent_b),(88,self.spent_a),(96,self.spent_b),(104,self.burned_a),(112,self.burned_b),(120,self.burned_child)]{put64(&mut d,at,n)}Ok(())}
 fn liability(&self)->Result<u64,ProgramError>{self.total.checked_sub(self.treasury).and_then(|n|n.checked_sub(self.dev)).and_then(|n|n.checked_sub(self.spent_a)).and_then(|n|n.checked_sub(self.spent_b)).ok_or(err(61))}
 fn pending(&self,parent:u8)->Result<u64,ProgramError>{match parent{0=>self.parent_a.checked_sub(self.spent_a),1=>self.parent_b.checked_sub(self.spent_b),_=>None}.ok_or(err(61))}
 /// Books a coin buyback slice against parent A's pending budget first, then parent B's. Returns (from A, from B).
 fn spend_child_buyback(&mut self,amount:u64)->Result<(u64,u64),ProgramError>{
  let from_a=amount.min(self.pending(0)?);let from_b=amount.checked_sub(from_a).ok_or(err(61))?;require(from_b<=self.pending(1)?)?;
  self.spent_a=add(self.spent_a,from_a)?;self.spent_b=add(self.spent_b,from_b)?;Ok((from_a,from_b))
 }
}
fn entitlement(total:u64,weight:u64)->u64{(total as u128*weight as u128/168) as u64}
fn cpi<'a>(a:&[AccountInfo<'a>],program:usize,spec:&[(usize,bool,bool)],data:Vec<u8>,seeds:&[&[u8]])->ProgramResult{
 let accounts=spec.iter().map(|(i,s,w)|if *w{AccountMeta::new(*a[*i].key,*s)}else{AccountMeta::new_readonly(*a[*i].key,*s)}).collect();
 let mut infos:Vec<AccountInfo<'a>>=spec.iter().map(|(i,_,_)|a[*i].clone()).collect();infos.push(a[program].clone());
 invoke_signed(&Instruction{program_id:*a[program].key,accounts,data},&infos,&[seeds])
}
fn transfer<'a>(a:&[AccountInfo<'a>],program:usize,from:usize,to:usize,amount:u64,seeds:&[&[u8]])->ProgramResult{
 if amount==0{return Ok(())}let mut data=vec![3];data.extend_from_slice(&amount.to_le_bytes());cpi(a,program,&[(from,false,true),(to,false,true),(3,true,false)],data,seeds)
}
// Return canonical pool keys in mint order. No caller-selected program or vault.
fn pool(a:&AccountInfo)->Result<[Pubkey;10],ProgramError>{
 require(*a.owner==CPMM)?;let d=a.try_borrow_data()?;require(d.len()==637&&d[..8]==solana_program::hash::hash(b"account:PoolState").to_bytes()[..8])?;
 let keys:[Pubkey;10]=std::array::from_fn(|i|Pubkey::new_from_array(d[8+i*32..40+i*32].try_into().unwrap()));
 // Each side's token program must be a token program; swap_quote binds each to the owner of that side's mint account.
 require(keys[5]<keys[6]&&is_token_program(&keys[7])&&is_token_program(&keys[8]))?;
 pda(a,&[b"pool",keys[0].as_ref(),keys[5].as_ref(),keys[6].as_ref()],&CPMM)?;Ok(keys)
}
/// Least acceptable output for `input` against the pool's constant product after the trade fee, less `max_slippage_bps`.
pub(super) fn quote_floor(input:u64,reserve_in:u64,reserve_out:u64,rate:u64,max_slippage_bps:u64)->Result<u64,ProgramError>{
 require(input>0&&reserve_in>0&&reserve_out>0&&rate<1_000_000&&max_slippage_bps<10_000)?;
 let fee=(input as u128*rate as u128+999_999)/1_000_000;
 let net=(input as u128).checked_sub(fee).ok_or(err(62))?;
 let quote=net*reserve_out as u128/(reserve_in as u128+net);
 require(quote>0)?;Ok(((quote*(10_000-max_slippage_bps) as u128/10_000) as u64).max(1))
}
/// Binds accounts 6..15 to one canonical CPMM pool (config on the allowlist, vault authority, both vaults, both mints,
/// observation) and refuses a `min_out` below the floor from the pool's live reserves.
fn swap_quote(a:&[AccountInfo],input:u64,min_out:u64,expiry:i64,out_program:usize,max_slippage_bps:u64)->ProgramResult{
 let now=Clock::get()?.unix_timestamp;require(expiry>=now&&expiry<=now.saturating_add(120)&&min_out>0)?;
 executable(&a[14],&CPMM)?;executable(&a[15],&TOKEN)?;
 // The output side may be a Token-2022 parent: its program is the mint account's owner and must be the passed program.
 let (_,out_token_program)=parent_mint_supply(&a[12])?;require(*a[out_program].key==out_token_program&&a[out_program].executable)?;
 let p=pool(&a[6])?;key(&a[7],&p[0])?;require(CONFIGS.contains(a[7].key)&&*a[7].owner==CPMM)?;
 let rate={let d=a[7].try_borrow_data()?;require(d.len()==236&&d[..8]==solana_program::hash::hash(b"account:AmmConfig").to_bytes()[..8])?;
 let rate=read64(&d,12)?;require((rate==20000||rate==25000)&&read64(&d,20)?==120000&&read64(&d,28)?==40000)?;rate};
 pda(&a[8],&[b"vault_and_lp_mint_auth_seed"],&CPMM)?;key(&a[13],&p[9])?;
 let forward=*a[11].key==p[5];key(&a[11],&p[if forward{5}else{6}])?;key(&a[12],&p[if forward{6}else{5}])?;
 // The pool's recorded token programs must be exactly the owners of the mint accounts on each side.
 require(p[if forward{7}else{8}]==*a[11].owner&&p[if forward{8}else{7}]==*a[12].owner&&*a[11].owner==TOKEN)?;
 key(&a[9],&p[if forward{2}else{3}])?;key(&a[10],&p[if forward{3}else{2}])?;
 mint_supply(&a[11])?;
 let raw_in=token(&a[9],a[11].key,a[8].key)?;let raw_out=parent_token(&a[10],a[12].key,a[8].key,&out_token_program)?;
 let d=a[6].try_borrow_data()?;require(d[390]==0)?;
 let fees0=add(add(read64(&d,341)?,read64(&d,357)?)?,read64(&d,397)?)?;
 let fees1=add(add(read64(&d,349)?,read64(&d,365)?)?,read64(&d,405)?)?;
 let reserve_in=raw_in.checked_sub(if forward{fees0}else{fees1}).ok_or(err(62))?;
 let reserve_out=raw_out.checked_sub(if forward{fees1}else{fees0}).ok_or(err(62))?;
 require(min_out>=quote_floor(input,reserve_in,reserve_out,rate,max_slippage_bps)?)
}
fn swap<'a>(a:&[AccountInfo<'a>],amount:u64,min_out:u64,seeds:&[&[u8]],out_program:usize)->ProgramResult{
 let mut data=solana_program::hash::hash(b"global:swap_base_input").to_bytes()[..8].to_vec();data.extend_from_slice(&amount.to_le_bytes());data.extend_from_slice(&min_out.to_le_bytes());
 cpi(a,14,&[(3,true,false),(8,false,false),(7,false,false),(6,false,true),(4,false,true),(5,false,true),(9,false,true),(10,false,true),(15,false,false),(out_program,false,false),(11,false,false),(12,false,false),(13,false,true)],data,seeds)
}
pub(super) fn process(program:&Pubkey,a:&[AccountInfo],body:&[u8],tag:u8)->ProgramResult{
 require(a.len()>=4)?;let c=Campaign::read(&a[0],program)?;require(c.phase==3&&a[1].is_signer&&*a[1].key==c.creator)?;
 let (authority,bump)=Pubkey::find_program_address(&[b"fee_authority",a[0].key.as_ref()],program);key(&a[3],&authority)?;
 let bump_seed=[bump];let seeds:&[&[u8]]=&[b"fee_authority",a[0].key.as_ref(),&bump_seed];
 if tag==20{
  require(a.len()==5&&body.is_empty())?;executable(&a[4],&system_program::id())?;
  let(expected,bump)=Pubkey::find_program_address(&[b"fees",a[0].key.as_ref()],program);key(&a[2],&expected)?;
  create_pda(&a[1],&a[2],&a[4],program,LEN,&[b"fees",a[0].key.as_ref(),&[bump]])?;
  return State::default().write(&a[2],a[0].key)
 }
 let mut state=State::read(&a[2],program,a[0].key)?;
 match tag{
  21=>{
   require(a.len()==22&&body.len()==8&&read64(body,0)?>0)?;
   executable(&a[15],&CPMM)?;executable(&a[17],&LOCK)?;executable(&a[19],&TOKEN)?;executable(&a[20],&TOKEN22)?;executable(&a[21],&MEMO)?;key(&a[18],&LOCK_AUTH)?;
   let before_child=custody(&a[4],&c.child_mint,&authority)?;let before_sol=custody(&a[5],&WSOL,&authority)?;
   require(before_child>=state.child&&before_sol>=state.liability()?)?;
   require(custody(&a[6],&c.fee_nft,a[0].key)?==1)?;pda(&a[7],&[b"locked_liquidity",c.fee_nft.as_ref()],&LOCK)?;require(*a[7].owner==LOCK)?;
   key(&a[8],&c.pool)?;let p=pool(&a[8])?;key(&a[9],&p[4])?;key(&a[10],&p[2])?;key(&a[11],&p[3])?;key(&a[12],&p[5])?;key(&a[13],&p[6])?;
   require((p[5]==c.child_mint&&p[6]==WSOL)||(p[6]==c.child_mint&&p[5]==WSOL))?;
   pda(&a[16],&[b"vault_and_lp_mint_auth_seed"],&CPMM)?;custody(&a[14],a[9].key,&LOCK_AUTH)?;
   let(dest0,dest1)=if p[5]==c.child_mint{(4,5)}else{(5,4)};
   let mut data=vec![8,30,51,199,209,184,247,133];data.extend_from_slice(body);
   let nonce=c.nonce.to_le_bytes();let campaign_bump=[c.bump];let campaign_seeds:&[&[u8]]=&[b"campaign",c.creator.as_ref(),&nonce,&campaign_bump];
   cpi(a,17,&[(18,false,false),(0,true,false),(6,false,true),(7,false,true),(15,false,false),(16,false,false),(8,false,true),(9,false,true),(dest0,false,true),(dest1,false,true),(10,false,true),(11,false,true),(12,false,false),(13,false,false),(14,false,true),(19,false,false),(20,false,false),(21,false,false)],data,campaign_seeds)?;
   let gained_child=custody(&a[4],&c.child_mint,&authority)?.checked_sub(before_child).ok_or(err(61))?;
   let gained_sol=custody(&a[5],&WSOL,&authority)?.checked_sub(before_sol).ok_or(err(61))?;
   state.child=add(state.child,gained_child)?;state.total=add(state.total,gained_sol)?;
  },
  23=>{
   require(a.len()==8&&body.is_empty())?;executable(&a[7],&TOKEN)?;
   require(custody(&a[4],&WSOL,&authority)?>=state.liability()?)?;custody(&a[5],&WSOL,&c.treasury)?;custody(&a[6],&WSOL,&c.dev)?;
   require(c.treasury!=authority&&c.dev!=authority)?;
   let treasury=entitlement(state.total,98);let dev=entitlement(state.total,20);
   let t=treasury.checked_sub(state.treasury).ok_or(err(61))?;let d=dev.checked_sub(state.dev).ok_or(err(61))?;
   transfer(a,7,4,5,t,seeds)?;transfer(a,7,4,6,d,seeds)?;
   state.treasury=treasury;state.dev=dev;state.parent_a=entitlement(state.total,25);state.parent_b=entitlement(state.total,25);
   require(custody(&a[4],&WSOL,&authority)?>=state.liability()?)?;
  },
  27=>{
   // Buy and burn the coin with the parents' buyback budget (owner decision, 24 September 2026). Accounts: 4 WSOL custody,
   // 5 coin custody, 6 the campaign's own pool, 7 AMM config, 8 CPMM vault authority, 9 WSOL vault, 10 coin vault,
   // 11 WSOL mint, 12 coin mint (writable: the bought coins are burned), 13 observation, 14 CPMM, 15 Token.
   // Body: amount u64 (lamports of WSOL), min_out u64 (raw coin units), expiry i64.
   require(a.len()==16&&body.len()==24)?;let amount=read64(body,0)?;let min=read64(body,8)?;let expiry=read64(body,16)? as i64;
   require(amount>0&&amount<=CHILD_BUYBACK_MAX_SLICE&&amount<=add(state.pending(0)?,state.pending(1)?)?)?;
   key(&a[6],&c.pool)?;key(&a[11],&WSOL)?;key(&a[12],&c.child_mint)?;
   let input=custody(&a[4],&WSOL,&authority)?;let output=custody(&a[5],&c.child_mint,&authority)?;
   require(input>=state.liability()?&&output>=state.child)?;let supply=mint_supply(&a[12])?;
   swap_quote(a,amount,min,expiry,15,CHILD_BUYBACK_MAX_SLIPPAGE_BPS)?;swap(a,amount,min,seeds,15)?;
   require(custody(&a[4],&WSOL,&authority)?==input-amount)?;
   let received=custody(&a[5],&c.child_mint,&authority)?.checked_sub(output).ok_or(err(61))?;require(received>=min)?;
   let mut burn=vec![8];burn.extend_from_slice(&received.to_le_bytes());cpi(a,15,&[(5,false,true),(12,false,true),(3,true,false)],burn,seeds)?;
   require(custody(&a[5],&c.child_mint,&authority)?==output&&mint_supply(&a[12])?==supply.checked_sub(received).ok_or(err(61))?)?;
   state.spend_child_buyback(amount)?;state.burned_child=add(state.burned_child,received)?;
   require(custody(&a[4],&WSOL,&authority)?>=state.liability()?)?;
  },
  26=>{
   // Burn the coin-side fees instead of selling them (owner decision, 23 September 2026): the fee authority burns
   // `amount` of the child coin it holds; nothing leaves custody except into the void.
   require(a.len()==7&&body.len()==8)?;let amount=read64(body,0)?;require(amount>0&&amount<=state.child)?;
   key(&a[5],&c.child_mint)?;executable(&a[6],&TOKEN)?;
   let before=custody(&a[4],&c.child_mint,&authority)?;require(before>=state.child)?;
   let mut data=vec![8u8];data.extend_from_slice(&amount.to_le_bytes());
   cpi(a,6,&[(4,false,true),(5,false,true),(3,true,false)],data,seeds)?;
   require(custody(&a[4],&c.child_mint,&authority)?==before-amount)?;
   state.child-=amount;state.burned_child=add(state.burned_child,amount)?;
  },
  _=>return Err(ProgramError::InvalidInstructionData)
 }
 state.write(&a[2],a[0].key)
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn cumulative_split_is_conservative_and_monotonic(){let mut prior=[0u64;4];for total in 0..10000{let now=[entitlement(total,98),entitlement(total,20),entitlement(total,25),entitlement(total,25)];assert!(now.iter().sum::<u64>()<=total);assert!(total-now.iter().sum::<u64>()<=3);for i in 0..4{assert!(now[i]>=prior[i])}prior=now;}assert_eq!(entitlement(168,98),98);}
 #[test]fn max_split_cannot_overflow(){assert!(entitlement(u64::MAX,98)<u64::MAX);}
 #[test]fn quote_rejects_empty_or_fee_consumed_input(){assert!(quote_floor(0,100,100,20000,200).is_err());assert!(quote_floor(1,100,100,20000,200).is_err());assert!(quote_floor(100,0,100,20000,200).is_err());assert!(quote_floor(100,100,100,1_000_000,200).is_err());assert!(quote_floor(100,100,100,20000,10_000).is_err());assert_eq!(quote_floor(1000,10000,10000,20000,200).unwrap(),874);}
 #[test]fn child_buyback_floor_is_one_percent_under_the_spot_quote(){assert_eq!(CHILD_BUYBACK_MAX_SLIPPAGE_BPS,100);assert_eq!(CHILD_BUYBACK_MAX_SLICE,500_000_000);assert_eq!(quote_floor(1000,10000,10000,20000,CHILD_BUYBACK_MAX_SLIPPAGE_BPS).unwrap(),883);assert_eq!(quote_floor(500_000_000,10_000_000_000,400_000_000_000_000,25000,100).unwrap(),18_407_628_128_724);assert_eq!(quote_floor(1,1_000_000,1,25000,100).unwrap_err(),err(60),"the fee eats a one-lamport input and the quote is zero");}
 #[test]fn spent_parent_budget_never_reopens(){let s=State{total:168,treasury:98,dev:20,parent_a:25,parent_b:25,spent_a:25,spent_b:0,..State::default()};assert_eq!(s.pending(0).unwrap(),0);assert_eq!(s.pending(1).unwrap(),25);assert_eq!(s.liability().unwrap(),25);assert!(s.pending(2).is_err());}
 #[test]fn child_buyback_spends_parent_a_then_parent_b_and_never_past_both(){
  let mut s=State{total:1_200,treasury:0,dev:0,parent_a:200,parent_b:1_000,..State::default()};
  assert_eq!(s.spend_child_buyback(150).unwrap(),(150,0));assert_eq!((s.spent_a,s.spent_b),(150,0));
  assert_eq!(s.spend_child_buyback(500).unwrap(),(50,450));assert_eq!((s.spent_a,s.spent_b),(200,450));
  assert_eq!(s.spend_child_buyback(500).unwrap(),(0,500));assert_eq!((s.spent_a,s.spent_b),(200,950));
  assert_eq!(s.spend_child_buyback(51).unwrap_err(),err(60),"over the combined budget");assert_eq!((s.spent_a,s.spent_b),(200,950),"a refused slice books nothing");
  assert_eq!(s.spend_child_buyback(50).unwrap(),(0,50));assert_eq!(s.liability().unwrap(),0);
  assert_eq!(s.spend_child_buyback(1).unwrap_err(),err(60));
 }
}
