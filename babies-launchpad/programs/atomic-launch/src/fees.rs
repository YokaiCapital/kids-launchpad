//! Fee Key collection and fixed-beneficiary fee routing. No arbitrary CPI or withdrawal.
//! Child earnings are converted to WSOL before cumulative 98:20:25:25 allocation.
use super::*;
use solana_program::{instruction::{AccountMeta,Instruction},pubkey};
const TOKEN:Pubkey=pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN22:Pubkey=pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA:Pubkey=pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CPMM:Pubkey=pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const CONFIG:Pubkey=pubkey!("2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5");
const LOCK:Pubkey=pubkey!("LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE");
const LOCK_AUTH:Pubkey=pubkey!("3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH");
const MEMO:Pubkey=pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const WSOL:Pubkey=pubkey!("So11111111111111111111111111111111111111112");
// Jupiter v6 aggregator: the parent buyback route for public launches (owner decision, 20 Sep 2026): the keeper
// fetches a route, the program forwards ONLY a `route_v2` whose user accounts are the fee custody accounts, and
// verifies the effects (exact SOL spent, parent received, then burned). Jupiter is a third-party upgradeable program.
const JUPITER:Pubkey=pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const JUPITER_ROUTE_V2:[u8;8]=[0xbb,0x64,0xfa,0xcc,0x31,0xc4,0xaf,0x14];
/// Largest single buyback slice through the aggregator (0.5 SOL): a bad fill on one slice stays small.
const JUPITER_MAX_SLICE:u64=500_000_000;
const JUPITER_MAX_SLIPPAGE_BPS:u16=100;
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
struct State{child:u64,total:u64,treasury:u64,dev:u64,parent_a:u64,parent_b:u64,spent_a:u64,spent_b:u64,burned_a:u64,burned_b:u64}
impl State{
 fn read(a:&AccountInfo,p:&Pubkey,campaign:&Pubkey)->Result<Self,ProgramError>{
  pda(a,&[b"fees",campaign.as_ref()],p)?;require(a.owner==p)?;let d=a.try_borrow_data()?;
  require(d.len()==LEN&&&d[..8]==MAGIC&&read_key(&d,8)?==*campaign)?;
  Ok(Self{child:read64(&d,40)?,total:read64(&d,48)?,treasury:read64(&d,56)?,dev:read64(&d,64)?,parent_a:read64(&d,72)?,parent_b:read64(&d,80)?,spent_a:read64(&d,88)?,spent_b:read64(&d,96)?,burned_a:read64(&d,104)?,burned_b:read64(&d,112)?})
 }
 fn write(&self,a:&AccountInfo,campaign:&Pubkey)->ProgramResult{let mut d=a.try_borrow_mut_data()?;d[..8].copy_from_slice(MAGIC);d[8..40].copy_from_slice(campaign.as_ref());for(at,n)in[(40,self.child),(48,self.total),(56,self.treasury),(64,self.dev),(72,self.parent_a),(80,self.parent_b),(88,self.spent_a),(96,self.spent_b),(104,self.burned_a),(112,self.burned_b)]{put64(&mut d,at,n)}Ok(())}
 fn liability(&self)->Result<u64,ProgramError>{self.total.checked_sub(self.treasury).and_then(|n|n.checked_sub(self.dev)).and_then(|n|n.checked_sub(self.spent_a)).and_then(|n|n.checked_sub(self.spent_b)).ok_or(err(61))}
 fn pending(&self,parent:u8)->Result<u64,ProgramError>{match parent{0=>self.parent_a.checked_sub(self.spent_a),1=>self.parent_b.checked_sub(self.spent_b),_=>None}.ok_or(err(61))}
}
fn entitlement(total:u64,weight:u64)->u64{(total as u128*weight as u128/168) as u64}
fn cpi<'a>(a:&[AccountInfo<'a>],program:usize,spec:&[(usize,bool,bool)],data:Vec<u8>,seeds:&[&[u8]])->ProgramResult{
 let accounts=spec.iter().map(|(i,s,w)|if *w{AccountMeta::new(*a[*i].key,*s)}else{AccountMeta::new_readonly(*a[*i].key,*s)}).collect();
 let mut infos:Vec<AccountInfo<'a>>=spec.iter().map(|(i,_,_)|a[*i].clone()).collect();infos.push(a[program].clone());
 invoke_signed(&Instruction{program_id:*a[program].key,accounts,data},&infos,&[seeds])
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
// Return canonical pool keys in mint order. No caller-selected program or vault.
fn pool(a:&AccountInfo)->Result<[Pubkey;10],ProgramError>{
 require(*a.owner==CPMM)?;let d=a.try_borrow_data()?;require(d.len()==637&&d[..8]==solana_program::hash::hash(b"account:PoolState").to_bytes()[..8])?;
 let keys:[Pubkey;10]=std::array::from_fn(|i|Pubkey::new_from_array(d[8+i*32..40+i*32].try_into().unwrap()));
 // Each side's token program must be a token program; swap_quote binds each to the owner of that side's mint account.
 require(keys[5]<keys[6]&&is_token_program(&keys[7])&&is_token_program(&keys[8]))?;
 pda(a,&[b"pool",keys[0].as_ref(),keys[5].as_ref(),keys[6].as_ref()],&CPMM)?;Ok(keys)
}
fn quote_floor(input:u64,reserve_in:u64,reserve_out:u64,rate:u64)->Result<u64,ProgramError>{
 require(input>0&&reserve_in>0&&reserve_out>0&&rate<1_000_000)?;
 let fee=(input as u128*rate as u128+999_999)/1_000_000;
 let net=(input as u128).checked_sub(fee).ok_or(err(62))?;
 let quote=net*reserve_out as u128/(reserve_in as u128+net);
 require(quote>0)?;Ok(((quote*98/100) as u64).max(1))
}
fn swap_quote(a:&[AccountInfo],input:u64,min_out:u64,expiry:i64,out_program:usize)->ProgramResult{
 let now=Clock::get()?.unix_timestamp;require(expiry>=now&&expiry<=now.saturating_add(120)&&min_out>0)?;
 executable(&a[14],&CPMM)?;executable(&a[15],&TOKEN)?;
 // The output side may be a Token-2022 parent: its program is the mint account's owner and must be the passed program.
 let (_,out_token_program)=parent_mint_supply(&a[12])?;require(*a[out_program].key==out_token_program&&a[out_program].executable)?;
 let p=pool(&a[6])?;key(&a[7],&p[0])?;key(&a[7],&CONFIG)?;require(*a[7].owner==CPMM)?;
 let rate={let d=a[7].try_borrow_data()?;require(d.len()==236&&d[..8]==solana_program::hash::hash(b"account:AmmConfig").to_bytes()[..8])?;
 require(d[10..12]==[2,0]&&read64(&d,12)?==20000&&read64(&d,20)?==120000&&read64(&d,28)?==40000)?;20000};
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
 require(min_out>=quote_floor(input,reserve_in,reserve_out,rate)?)
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
  22=>{
   require(a.len()==16&&body.len()==24)?;let amount=read64(body,0)?;let min=read64(body,8)?;let expiry=read64(body,16)? as i64;
   require(amount>0&&amount<=state.child)?;key(&a[6],&c.pool)?;key(&a[11],&c.child_mint)?;key(&a[12],&WSOL)?;
   let input=custody(&a[4],&c.child_mint,&authority)?;let output=custody(&a[5],&WSOL,&authority)?;
   require(input>=state.child&&output>=state.liability()?)?;swap_quote(a,amount,min,expiry,15)?;swap(a,amount,min,seeds,15)?;
   require(custody(&a[4],&c.child_mint,&authority)?==input-amount)?;
   let gained=custody(&a[5],&WSOL,&authority)?.checked_sub(output).ok_or(err(61))?;require(gained>=min)?;
   state.child-=amount;state.total=add(state.total,gained)?;
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
  24=>{
   require(a.len()==18&&body.len()==25)?;let parent=body[0];let amount=read64(body,1)?;let min=read64(body,9)?;let expiry=read64(body,17)? as i64;
   require(amount>0&&amount<=state.pending(parent)?)?;
   let parent_mint=super::claims::validated_parent_mint(program,&a[16],a[0].key,parent)?;
   require(parent_mint!=WSOL&&parent_mint!=c.child_mint)?;key(&a[11],&WSOL)?;key(&a[12],&parent_mint)?;
   // The parent's token program (classic or Token-2022) is the mint account's owner; a[17] must be exactly that program.
   let (supply,parent_program)=parent_mint_supply(&a[12])?;require(*a[17].key==parent_program&&a[17].executable)?;
   let parent_custody=|acc:&AccountInfo|->Result<u64,ProgramError>{parent_ata(acc,&authority,&parent_mint,&parent_program)?;parent_token(acc,&parent_mint,&authority,&parent_program)};
   let input=custody(&a[4],&WSOL,&authority)?;let output=parent_custody(&a[5])?;require(input>=state.liability()?)?;
   swap_quote(a,amount,min,expiry,17)?;swap(a,amount,min,seeds,17)?;
   require(custody(&a[4],&WSOL,&authority)?==input-amount)?;
   let received=parent_custody(&a[5])?.checked_sub(output).ok_or(err(61))?;require(received>=min)?;
   let mut burn=vec![8];burn.extend_from_slice(&received.to_le_bytes());cpi(a,17,&[(5,false,true),(12,false,true),(3,true,false)],burn,seeds)?;
   require(parent_custody(&a[5])?==output&&parent_mint_supply(&a[12])?.0==supply.checked_sub(received).ok_or(err(61))?)?;
   if parent==0{state.spent_a=add(state.spent_a,amount)?;state.burned_a=add(state.burned_a,received)?;}else{state.spent_b=add(state.spent_b,amount)?;state.burned_b=add(state.burned_b,received)?;}
   require(custody(&a[4],&WSOL,&authority)?>=state.liability()?)?;
  },
  25=>{
   // Buy-and-burn a parent through Jupiter. Accounts: 0 campaign, 1 creator, 2 fees, 3 fee authority, 4 WSOL custody,
   // 5 parent custody, 6 parents config, 7 parent mint, 8 WSOL mint, 9 classic token program, 10 parent token program,
   // 11 Jupiter program, 12 Jupiter event authority, 13.. the route's remaining accounts as Jupiter's API listed them.
   // Body: parent u8, amount u64, min_out u64, expiry i64, then the Jupiter `route_v2` instruction data verbatim.
   require(a.len()>=14&&body.len()>=25+34)?;let parent=body[0];let amount=read64(body,1)?;let min=read64(body,9)?;let expiry=read64(body,17)? as i64;let route=&body[25..];
   let now=Clock::get()?.unix_timestamp;require(expiry>=now&&expiry<=now.saturating_add(120)&&min>0)?;
   require(amount>0&&amount<=JUPITER_MAX_SLICE&&amount<=state.pending(parent)?)?;
   let parent_mint=super::claims::validated_parent_mint(program,&a[6],a[0].key,parent)?;
   require(parent_mint!=WSOL&&parent_mint!=c.child_mint)?;key(&a[7],&parent_mint)?;key(&a[8],&WSOL)?;executable(&a[9],&TOKEN)?;
   let (supply,parent_program)=parent_mint_supply(&a[7])?;require(*a[10].key==parent_program&&a[10].executable)?;
   executable(&a[11],&JUPITER)?;pda(&a[12],&[b"__event_authority"],&JUPITER)?;
   let parent_custody=|acc:&AccountInfo|->Result<u64,ProgramError>{parent_ata(acc,&authority,&parent_mint,&parent_program)?;parent_token(acc,&parent_mint,&authority,&parent_program)};
   let input=custody(&a[4],&WSOL,&authority)?;let output=parent_custody(&a[5])?;require(input>=state.liability()?)?;
   require(jupiter_route_ok(route,amount,min))?;
   // route_v2 accounts: user_transfer_authority (our PDA signs), user source, user destination, source mint, destination mint,
   // source token program, destination token program, destination_token_account (omitted: the program id), event authority, program.
   cpi_forward(a,11,&[(3,true,false),(4,false,true),(5,false,true),(8,false,false),(7,false,false),(9,false,false),(10,false,false),(11,false,false),(12,false,false),(11,false,false)],13,route.to_vec(),seeds)?;
   require(custody(&a[4],&WSOL,&authority)?==input-amount)?;
   let received=parent_custody(&a[5])?.checked_sub(output).ok_or(err(61))?;require(received>=min)?;
   let mut burn=vec![8];burn.extend_from_slice(&received.to_le_bytes());cpi(a,10,&[(5,false,true),(7,false,true),(3,true,false)],burn,seeds)?;
   require(parent_custody(&a[5])?==output&&parent_mint_supply(&a[7])?.0==supply.checked_sub(received).ok_or(err(61))?)?;
   if parent==0{state.spent_a=add(state.spent_a,amount)?;state.burned_a=add(state.burned_a,received)?;}else{state.spent_b=add(state.spent_b,amount)?;state.burned_b=add(state.burned_b,received)?;}
   require(custody(&a[4],&WSOL,&authority)?>=state.liability()?)?;
  },
  _=>return Err(ProgramError::InvalidInstructionData)
 }
 state.write(&a[2],a[0].key)
}
/// route_v2 header: disc 8 | in_amount u64 | quoted_out_amount u64 | slippage_bps u16 | platform_fee_bps u16 |
/// positive_slippage_bps u16 | route_plan vec (u32 length prefix). The slice must be spent exactly, the quote minus the
/// allowed slippage must still clear our minimum, slippage is capped, no platform fee, 1 to 8 steps.
fn jupiter_route_ok(route:&[u8],amount:u64,min:u64)->bool{
 if route.len()<34||route[..8]!=JUPITER_ROUTE_V2{return false}
 let (Ok(in_amount),Ok(quoted))=(read64(route,8),read64(route,16)) else {return false};
 let slippage=u16::from_le_bytes([route[24],route[25]]);let platform_fee=u16::from_le_bytes([route[26],route[27]]);let steps=u32::from_le_bytes([route[30],route[31],route[32],route[33]]);
 in_amount==amount&&quoted>=min&&slippage<=JUPITER_MAX_SLIPPAGE_BPS&&platform_fee==0&&(1..=8).contains(&steps)&&quoted.saturating_sub((quoted as u128*slippage as u128/10_000) as u64)>=min
}
#[cfg(test)]mod tests{
 #[test]fn jupiter_route_header_rules(){use super::*;
  let header=|in_amount:u64,quoted:u64,slippage:u16,fee:u16,steps:u32|{let mut r=JUPITER_ROUTE_V2.to_vec();r.extend_from_slice(&in_amount.to_le_bytes());r.extend_from_slice(&quoted.to_le_bytes());r.extend_from_slice(&slippage.to_le_bytes());r.extend_from_slice(&fee.to_le_bytes());r.extend_from_slice(&0u16.to_le_bytes());r.extend_from_slice(&steps.to_le_bytes());r};
  assert!(jupiter_route_ok(&header(1000,10_000,100,0,1),1000,9_900));
  assert!(!jupiter_route_ok(&header(1000,10_000,100,0,1),1000,9_901),"slippage may not eat below min");
  assert!(!jupiter_route_ok(&header(999,10_000,50,0,1),1000,9_000),"in_amount must equal the slice");
  assert!(!jupiter_route_ok(&header(1000,10_000,101,0,1),1000,1),"slippage capped at 1%");
  assert!(!jupiter_route_ok(&header(1000,10_000,10,5,1),1000,1),"no platform fee");
  assert!(!jupiter_route_ok(&header(1000,10_000,10,0,0),1000,1)&&!jupiter_route_ok(&header(1000,10_000,10,0,9),1000,1),"1 to 8 steps");
  let mut wrong=header(1000,10_000,10,0,1);wrong[0]^=1;assert!(!jupiter_route_ok(&wrong,1000,1),"only route_v2");
  assert!(!jupiter_route_ok(&header(1000,10_000,10,0,1)[..30],1000,1),"short data refused");
  assert_eq!(JUPITER_MAX_SLICE,500_000_000);
 }
 use super::*;
 #[test]fn cumulative_split_is_conservative_and_monotonic(){let mut prior=[0u64;4];for total in 0..10000{let now=[entitlement(total,98),entitlement(total,20),entitlement(total,25),entitlement(total,25)];assert!(now.iter().sum::<u64>()<=total);assert!(total-now.iter().sum::<u64>()<=3);for i in 0..4{assert!(now[i]>=prior[i])}prior=now;}assert_eq!(entitlement(168,98),98);}
 #[test]fn max_split_cannot_overflow(){assert!(entitlement(u64::MAX,98)<u64::MAX);}
 #[test]fn quote_rejects_empty_or_fee_consumed_input(){assert!(quote_floor(0,100,100,20000).is_err());assert!(quote_floor(1,100,100,20000).is_err());assert!(quote_floor(100,0,100,20000).is_err());assert!(quote_floor(100,100,100,1_000_000).is_err());assert_eq!(quote_floor(1000,10000,10000,20000).unwrap(),874);}
 #[test]fn spent_parent_budget_never_reopens(){let s=State{total:168,treasury:98,dev:20,parent_a:25,parent_b:25,spent_a:25,spent_b:0,..State::default()};assert_eq!(s.pending(0).unwrap(),0);assert_eq!(s.pending(1).unwrap(),25);assert_eq!(s.liability().unwrap(),25);assert!(s.pending(2).is_err());}
}
