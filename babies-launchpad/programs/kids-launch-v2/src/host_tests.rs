//! Host-side handler tests. A syscall stub serves the clock and rent and emulates every program the handlers call:
//! System (CreateAccount, Allocate, Assign, Transfer), Token and Token-2022 (Transfer, SetAuthority, Burn,
//! SyncNative), the Raydium CPMM (`initialize`), the Raydium lock (`lock_cp_liquidity`, `collect_cp_fees`) and
//! Jupiter (`route`, `route_v2`), each checking the signers and account identities its real counterpart checks and
//! producing the accounts and balances the handlers read back. Every other CPI is refused with
//! `HOST_CPI_UNSUPPORTED`. `Bank::call` commits the accounts of a successful call and rolls a failed call back as
//! the runtime would, keeping the failed call's account bytes readable (`Bank::dirty`) so a test can prove that a
//! handler which failed after its CPIs never wrote the campaign. Every campaign, receipt, launch and fee state a
//! test reads was produced by the handlers, with one exception: create refuses Family terms (error 91) until a
//! parent-claim path exists, so a Family scenario runs `validate_terms` and then seals the campaign account by
//! hand (`World::seal`) to keep the Family launch and fee cycle tested for the day the gate lifts. Nothing else
//! is written into an account by hand except the fault switches (`Faults`) that make an emulated program
//! misbehave and the foreign accounts a real cluster would hold (reference pools, mints, token accounts).
use super::*;
use fees::*;
use handlers::*;
use launch::*;
use policy::*;
use state::*;
use solana_program::{clock::Clock,instruction::Instruction,program_stubs::{set_syscall_stubs,SyscallStubs}};
use std::cell::RefCell;
use std::sync::Once;
pub const HOST_CPI_UNSUPPORTED:u32=0xF00D;
struct Created{key:Pubkey,data:*mut u8,len:usize,owner:Option<Pubkey>}
/// Switches that make an emulated program misbehave, to prove the read-back checks catch it. `creator_fee_pool`:
/// the CPMM writes the pool with `enable_creator_fee` on, as only `initialize_with_permission` would.
#[derive(Default,Clone,Copy)]
struct Faults{keep_mint_authority:bool,skim_vault:bool,creator_fee_pool:bool}
thread_local!{
 static CLOCK:RefCell<i64>=RefCell::new(0);static PROGRAM:RefCell<Pubkey>=RefCell::new(Pubkey::default());
 static CPI_LOG:RefCell<Vec<(Pubkey,Vec<u8>)>>=RefCell::new(vec![]);static CREATED:RefCell<Vec<Created>>=RefCell::new(vec![]);
 static FAULTS:RefCell<Faults>=RefCell::new(Faults::default());
 /// (token 0, token 1) the emulated lock program pays out at the next `collect_cp_fees`.
 static HARVEST:RefCell<(u64,u64)>=RefCell::new((0,0));
 /// Parent tokens the emulated Jupiter credits at the next route, and lamports it takes from the swap user.
 static FILL:RefCell<u64>=RefCell::new(0);static ACCUMULATOR:RefCell<u64>=RefCell::new(0);
}
fn rent(len:usize)->u64{Rent::default().minimum_balance(len)}
fn isqrt(n:u128)->u128{if n<2{return n}let mut x=n;let mut y=(x+1)/2;while y<x{x=y;y=(x+n/x)/2;}x}
struct HostStubs;
impl SyscallStubs for HostStubs{
 fn sol_log(&self,_message:&str){}
 fn sol_get_clock_sysvar(&self,var_addr:*mut u8)->u64{let clock=Clock{unix_timestamp:CLOCK.with(|n|*n.borrow()),..Clock::default()};unsafe{std::ptr::write(var_addr as *mut Clock,clock)};0}
 fn sol_get_rent_sysvar(&self,var_addr:*mut u8)->u64{unsafe{std::ptr::write(var_addr as *mut Rent,Rent::default())};0}
 fn sol_invoke_signed(&self,instruction:&Instruction,infos:&[AccountInfo],signers_seeds:&[&[&[u8]]])->ProgramResult{
  CPI_LOG.with(|l|l.borrow_mut().push((instruction.program_id,instruction.data.clone())));
  let program=PROGRAM.with(|p|*p.borrow());
  let find=|k:&Pubkey|infos.iter().find(|i|i.key==k).expect("CPI account passed").clone();
  let signed=|k:&Pubkey|find(k).is_signer||signers_seeds.iter().any(|seeds|Pubkey::create_program_address(seeds,&program)==Ok(*k));
  for meta in &instruction.accounts{if meta.is_signer{assert!(signed(&meta.pubkey),"CPI account {} is not signed",meta.pubkey);}}
  let program_id=instruction.program_id;
  if program_id==system_program::id(){return emulate_system(instruction,infos)}
  if is_token_program(&program_id){return emulate_token(&program_id,instruction,infos,&signed)}
  if program_id==RAYDIUM_CPMM{return emulate_cpmm(instruction,infos,&signed)}
  if program_id==RAYDIUM_LOCK{return emulate_lock(instruction,infos,&signed)}
  if program_id==JUPITER_PROGRAM{return emulate_jupiter(instruction,infos,&signed)}
  Err(err(HOST_CPI_UNSUPPORTED))
 }
}
fn account_of<'a>(instruction:&Instruction,infos:&[AccountInfo<'a>],i:usize)->AccountInfo<'a>{infos.iter().find(|info|*info.key==instruction.accounts[i].pubkey).expect("CPI account passed").clone()}
fn move_lamports(from:&AccountInfo,to:&AccountInfo,amount:u64)->ProgramResult{
 if amount==0{return Ok(())}
 {let mut f=from.try_borrow_mut_lamports().unwrap();if **f<amount{return Err(ProgramError::InsufficientFunds)}**f-=amount;}
 **to.try_borrow_mut_lamports().unwrap()+=amount;Ok(())
}
/// System instructions as the program issues them (bincode: u32 tag then fields): 0 CreateAccount, 1 Assign,
/// 2 Transfer, 8 Allocate. An overdraw fails the instruction as the System program would.
fn emulate_system<'a>(instruction:&Instruction,infos:&[AccountInfo<'a>])->ProgramResult{
 let d=&instruction.data;let tag=u32::from_le_bytes(d[..4].try_into().unwrap());
 let account=|i:usize|account_of(instruction,infos,i);
 match tag{
  0=>{let to=account(1);assert_eq!(to.lamports(),0);move_lamports(&account(0),&to,read64(d,4).unwrap())?;allocate(&to,read64(d,12).unwrap() as usize);assign(&to,read_key(d,20).unwrap());Ok(())},
  1=>{assign(&account(0),read_key(d,4).unwrap());Ok(())},
  2=>move_lamports(&account(0),&account(1),read64(d,4).unwrap()),
  8=>{allocate(&account(0),read64(d,4).unwrap() as usize);Ok(())},
  _=>Err(err(HOST_CPI_UNSUPPORTED)),
 }
}
fn allocate(info:&AccountInfo,space:usize){
 assert!(info.data_is_empty(),"allocate on a non-empty account");
 let buffer:&'static mut [u8]=Box::leak(vec![0u8;space].into_boxed_slice());let data=buffer.as_mut_ptr();
 *info.data.borrow_mut()=buffer;
 CREATED.with(|c|{let mut c=c.borrow_mut();match c.iter_mut().find(|x|x.key==*info.key){Some(x)=>{x.data=data;x.len=space}None=>c.push(Created{key:*info.key,data,len:space,owner:None})}});
}
/// Changes the owner in place (as the runtime shows the caller after a CPI) and records it for the commit.
fn assign(info:&AccountInfo,owner:Pubkey){
 info.assign(&owner);
 CREATED.with(|c|{let mut c=c.borrow_mut();match c.iter_mut().find(|x|x.key==*info.key){Some(x)=>x.owner=Some(owner),None=>c.push(Created{key:*info.key,data:std::ptr::null_mut(),len:0,owner:Some(owner)})}});
}
/// What a program does when it creates an account: rent from the payer (topping up whatever the address held),
/// allocate, write the initial bytes, assign.
fn create_account(payer:&AccountInfo,target:&AccountInfo,owner:&Pubkey,data:&[u8])->ProgramResult{
 assert!(target.data_is_empty(),"create on a non-empty account {}",target.key);
 move_lamports(payer,target,rent(data.len()).saturating_sub(target.lamports()))?;
 allocate(target,data.len());target.try_borrow_mut_data().unwrap().copy_from_slice(data);assign(target,*owner);Ok(())
}
fn balance_of(info:&AccountInfo)->u64{read64(&info.try_borrow_data().unwrap(),64).unwrap()}
fn set_balance(info:&AccountInfo,amount:u64){put64(&mut info.try_borrow_mut_data().unwrap(),64,amount);}
fn key_at(info:&AccountInfo,at:usize)->Pubkey{read_key(&info.try_borrow_data().unwrap(),at).unwrap()}
/// Token and Token-2022: 3 Transfer, 6 SetAuthority (revocation only), 8 Burn, 17 SyncNative. Accounts must be
/// owned by the invoked program; the authority must be the account's owner and signed.
fn emulate_token<'a>(program:&Pubkey,instruction:&Instruction,infos:&[AccountInfo<'a>],signed:&dyn Fn(&Pubkey)->bool)->ProgramResult{
 let account=|i:usize|account_of(instruction,infos,i);let data=&instruction.data;
 match data[0]{
  3=>{
   let amount=read64(data,1).unwrap();let source=account(0);let destination=account(1);let authority=instruction.accounts[2].pubkey;
   assert!(signed(&authority),"transfer authority {authority} is not signed");assert_eq!(source.owner,program);assert_eq!(destination.owner,program);
   assert_eq!(key_at(&source,0),key_at(&destination,0),"transfer between mints");assert_eq!(key_at(&source,32),authority,"transfer by a non-owner");
   let b=balance_of(&source);if b<amount{return Err(ProgramError::InsufficientFunds)}set_balance(&source,b-amount);set_balance(&destination,balance_of(&destination)+amount);Ok(())
  },
  6=>{
   let target=account(0);let authority=instruction.accounts[1].pubkey;assert!(signed(&authority));assert_eq!(target.owner,program);
   assert_eq!(data[2],0,"only revocation is emulated");let(flag,key)=if data[1]==0{(0,4)}else{(46,50)};
   {let d=target.try_borrow_data().unwrap();assert_eq!(d[flag..flag+4],[1,0,0,0],"authority already absent");assert_eq!(read_key(&d,key).unwrap(),authority,"not the current authority");}
   if data[1]==0&&FAULTS.with(|f|f.borrow().keep_mint_authority){return Ok(())}
   let mut d=target.try_borrow_mut_data().unwrap();d[flag..flag+4].fill(0);d[key..key+32].fill(0);Ok(())
  },
  8=>{
   let amount=read64(data,1).unwrap();let holder=account(0);let mint=account(1);let authority=instruction.accounts[2].pubkey;
   assert!(signed(&authority));assert_eq!(holder.owner,program);assert_eq!(mint.owner,program);assert_eq!(key_at(&holder,0),*mint.key,"burn against another mint");assert_eq!(key_at(&holder,32),authority);
   let b=balance_of(&holder);if b<amount{return Err(ProgramError::InsufficientFunds)}set_balance(&holder,b-amount);
   let mut m=mint.try_borrow_mut_data().unwrap();let supply=read64(&m,36).unwrap();put64(&mut m,36,supply-amount);Ok(())
  },
  17=>{let holder=account(0);assert_eq!(holder.owner,program);assert_eq!(key_at(&holder,0),WSOL,"sync of a non-native account");let lamports=holder.lamports();set_balance(&holder,lamports-rent(165));Ok(())},
  _=>Err(err(HOST_CPI_UNSUPPORTED)),
 }
}
const OBSERVATION_LEN:usize=2000;
fn pool_state_data(config:&Pubkey,creator:&Pubkey,vault0:&Pubkey,vault1:&Pubkey,lp_mint:&Pubkey,mint0:&Pubkey,mint1:&Pubkey,programs:(&Pubkey,&Pubkey),observation:&Pubkey,lp_supply:u64)->Vec<u8>{
 let mut d=vec![0u8;POOL_STATE_LEN];d[..8].copy_from_slice(&pool_state_discriminator());
 for(i,k)in[config,creator,vault0,vault1,lp_mint,mint0,mint1,programs.0,programs.1,observation].iter().enumerate(){d[8+32*i..40+32*i].copy_from_slice(k.as_ref());}
 d[328]=253;d[POOL_OFF_STATUS]=0;d[330]=9;d[331]=6;d[332]=9;put64(&mut d,POOL_OFF_LP_SUPPLY,lp_supply);d
}
fn locked_state_data(lp_amount:u64,pool:&Pubkey,nft:&Pubkey,owner:&Pubkey,lp_mint:&Pubkey)->Vec<u8>{
 let mut d=vec![0u8;LOCKED_STATE_LEN];d[..8].copy_from_slice(&locked_state_discriminator());put64(&mut d,LOCKED_OFF_LP_AMOUNT,lp_amount);
 for(at,k)in[(LOCKED_OFF_POOL,pool),(LOCKED_OFF_FEE_NFT_MINT,nft),(LOCKED_OFF_OWNER,owner),(LOCKED_OFF_LP_MINT,lp_mint)]{d[at..at+32].copy_from_slice(k.as_ref());}d
}
/// Raydium CPMM `initialize`: checks the canonical addresses, charges the config's create-pool fee and the rents to
/// the creator, moves both deposits into fresh vaults, mints sqrt(a0 × a1) LP (100 stay locked) to the creator's LP
/// account and writes the pool state. A donated WSOL vault counts its lamport surplus as native liquidity.
fn emulate_cpmm<'a>(instruction:&Instruction,infos:&[AccountInfo<'a>],signed:&dyn Fn(&Pubkey)->bool)->ProgramResult{
 assert_eq!(instruction.data[..8],CPMM_INITIALIZE,"only initialize is emulated");
 assert_eq!(instruction.data.len(),CPMM_INITIALIZE_LEN,"plain initialize: three u64 arguments and no creator_fee_on");
 let amount0=read64(&instruction.data,8).unwrap();let amount1=read64(&instruction.data,16).unwrap();
 let account=|i:usize|account_of(instruction,infos,i);
 let(creator,config,authority,pool,mint0,mint1,lp_mint,creator0,creator1,creator_lp,vault0,vault1,fee,observation)=(account(0),account(1),account(2),account(3),account(4),account(5),account(6),account(7),account(8),account(9),account(10),account(11),account(12),account(13));
 assert!(signed(creator.key));assert_eq!(*config.owner,RAYDIUM_CPMM);
 let cp_authority=Pubkey::find_program_address(&[CPMM_AUTH_SEED],&RAYDIUM_CPMM).0;assert_eq!(*authority.key,cp_authority);
 assert!(mint0.key<mint1.key,"mints in canonical order");
 assert_eq!(*pool.key,Pubkey::find_program_address(&[CPMM_POOL_SEED,config.key.as_ref(),mint0.key.as_ref(),mint1.key.as_ref()],&RAYDIUM_CPMM).0);
 assert_eq!(*lp_mint.key,Pubkey::find_program_address(&[CPMM_LP_MINT_SEED,pool.key.as_ref()],&RAYDIUM_CPMM).0);
 assert_eq!(*vault0.key,Pubkey::find_program_address(&[CPMM_VAULT_SEED,pool.key.as_ref(),mint0.key.as_ref()],&RAYDIUM_CPMM).0);
 assert_eq!(*vault1.key,Pubkey::find_program_address(&[CPMM_VAULT_SEED,pool.key.as_ref(),mint1.key.as_ref()],&RAYDIUM_CPMM).0);
 assert_eq!(*observation.key,Pubkey::find_program_address(&[CPMM_OBSERVATION_SEED,pool.key.as_ref()],&RAYDIUM_CPMM).0);
 assert_eq!(*creator_lp.key,ata_key(creator.key,lp_mint.key));assert_eq!(*fee.key,CPMM_CREATE_POOL_FEE_RECEIVER);
 for(holder,mint)in[(&creator0,mint0.key),(&creator1,mint1.key)]{assert_eq!(key_at(holder,0),*mint);assert_eq!(key_at(holder,32),*creator.key);}
 let create_fee=read64(&config.try_borrow_data().unwrap(),36).unwrap();move_lamports(&creator,&fee,create_fee)?;
 for(holder,amount)in[(&creator0,amount0),(&creator1,amount1)]{let b=balance_of(holder);if b<amount{return Err(ProgramError::InsufficientFunds)}set_balance(holder,b-amount);}
 let lp_total=isqrt(amount0 as u128*amount1 as u128) as u64;let lp_amount=lp_total-CPMM_INITIAL_LOCKED_LP;
 let skim=FAULTS.with(|f|f.borrow().skim_vault) as u64;
 for(vault,mint,amount)in[(&vault0,mint0.key,amount0-skim),(&vault1,mint1.key,amount1)]{
  let native_surplus=if *mint==WSOL{vault.lamports().saturating_sub(rent(165))}else{0};
  create_account(&creator,vault,&TOKEN_PROGRAM,&token_data(mint,&cp_authority,amount+native_surplus))?;
 }
 create_account(&creator,&lp_mint,&TOKEN_PROGRAM,&mint_data(lp_total,9,Some(&cp_authority),None))?;
 create_account(&creator,&creator_lp,&TOKEN_PROGRAM,&token_data(lp_mint.key,creator.key,lp_amount))?;
 let mut pool_data=pool_state_data(config.key,creator.key,vault0.key,vault1.key,lp_mint.key,mint0.key,mint1.key,(&TOKEN_PROGRAM,&TOKEN_PROGRAM),observation.key,lp_total);
 if FAULTS.with(|f|f.borrow().creator_fee_pool){pool_data[POOL_OFF_ENABLE_CREATOR_FEE]=1;}
 create_account(&creator,&pool,&RAYDIUM_CPMM,&pool_data)?;
 create_account(&creator,&observation,&RAYDIUM_CPMM,&vec![0u8;OBSERVATION_LEN])
}
/// Raydium lock: `lock_cp_liquidity` moves the LP into the lock authority's vault, mints the fee NFT to its owner and
/// writes the locked state (rents from the payer); `collect_cp_fees` pays the pending harvest from the vaults to the
/// recipients for the holder of the fee NFT.
fn emulate_lock<'a>(instruction:&Instruction,infos:&[AccountInfo<'a>],signed:&dyn Fn(&Pubkey)->bool)->ProgramResult{
 let account=|i:usize|account_of(instruction,infos,i);
 let lock_authority=Pubkey::find_program_address(&[LOCK_AUTH_SEED],&RAYDIUM_LOCK).0;
 if instruction.data[..8]==LOCK_CP_LIQUIDITY{
  let lp_amount=read64(&instruction.data,8).unwrap();let with_metadata=instruction.data[16];
  let(authority,payer,owner,nft_owner,nft_mint,nft_account,pool,locked,lp_mint,owner_lp,lock_vault,vault0,vault1,metadata)=(account(0),account(1),account(2),account(3),account(4),account(5),account(6),account(7),account(8),account(9),account(10),account(11),account(12),account(13));
  assert_eq!(*authority.key,lock_authority);assert!(signed(payer.key)&&signed(owner.key)&&signed(nft_mint.key));
  assert_eq!(*pool.owner,RAYDIUM_CPMM);assert_eq!(key_at(&pool,136),*lp_mint.key);assert_eq!(key_at(&pool,72),*vault0.key);assert_eq!(key_at(&pool,104),*vault1.key);
  assert_eq!(key_at(&owner_lp,0),*lp_mint.key);assert_eq!(key_at(&owner_lp,32),*owner.key);
  assert_eq!(*locked.key,Pubkey::find_program_address(&[LOCKED_LIQUIDITY_SEED,nft_mint.key.as_ref()],&RAYDIUM_LOCK).0);assert!(locked.data_is_empty()&&nft_mint.data_is_empty());
  assert_eq!(*nft_account.key,ata_key(nft_owner.key,nft_mint.key));assert_eq!(*lock_vault.key,ata_key(&lock_authority,lp_mint.key));
  let b=balance_of(&owner_lp);if b<lp_amount{return Err(ProgramError::InsufficientFunds)}set_balance(&owner_lp,b-lp_amount);
  if lock_vault.data_is_empty(){create_account(&payer,&lock_vault,&TOKEN_PROGRAM,&token_data(lp_mint.key,&lock_authority,0))?;}
  set_balance(&lock_vault,balance_of(&lock_vault)+lp_amount);
  create_account(&payer,&nft_mint,&TOKEN_PROGRAM,&mint_data(1,0,None,None))?;
  create_account(&payer,&nft_account,&TOKEN_PROGRAM,&token_data(nft_mint.key,nft_owner.key,1))?;
  create_account(&payer,&locked,&RAYDIUM_LOCK,&locked_state_data(lp_amount,pool.key,nft_mint.key,owner.key,lp_mint.key))?;
  if with_metadata==1{create_account(&payer,&metadata,&METADATA_PROGRAM,&vec![0u8;679])?;}
  return Ok(())
 }
 assert_eq!(instruction.data[..8],COLLECT_CP_FEES,"only lock and collect are emulated");
 assert!(read64(&instruction.data,8).unwrap()>0);
 let(authority,nft_owner,nft_account,locked,pool,lp_mint,recipient0,recipient1,vault0,vault1,mint0,mint1,lock_vault)=(account(0),account(1),account(2),account(3),account(6),account(7),account(8),account(9),account(10),account(11),account(12),account(13),account(14));
 assert_eq!(*authority.key,lock_authority);assert!(signed(nft_owner.key));
 assert_eq!(*locked.owner,RAYDIUM_LOCK);assert_eq!(key_at(&locked,LOCKED_OFF_POOL),*pool.key);
 assert_eq!(key_at(&nft_account,0),key_at(&locked,LOCKED_OFF_FEE_NFT_MINT),"the fee NFT of this position");assert_eq!(key_at(&nft_account,32),*nft_owner.key);assert_eq!(balance_of(&nft_account),1);
 assert_eq!(*pool.owner,RAYDIUM_CPMM);assert_eq!(key_at(&pool,136),*lp_mint.key);assert_eq!(key_at(&pool,72),*vault0.key);assert_eq!(key_at(&pool,104),*vault1.key);assert_eq!(key_at(&pool,168),*mint0.key);assert_eq!(key_at(&pool,200),*mint1.key);
 assert_eq!(key_at(&recipient0,0),*mint0.key);assert_eq!(key_at(&recipient1,0),*mint1.key);assert_eq!(*lock_vault.key,ata_key(&lock_authority,lp_mint.key));
 let(h0,h1)=HARVEST.with(|h|std::mem::take(&mut *h.borrow_mut()));
 for(vault,recipient,amount)in[(&vault0,&recipient0,h0),(&vault1,&recipient1,h1)]{let b=balance_of(vault);if b<amount{return Err(ProgramError::InsufficientFunds)}set_balance(vault,b-amount);set_balance(recipient,balance_of(recipient)+amount);}
 Ok(())
}
/// Jupiter `route_v2` / `route`: debits the header's input amount from the user source, credits the pending fill to
/// the user destination and takes the pending accumulator lamports from the swap user (the Pump AMM leg).
fn emulate_jupiter<'a>(instruction:&Instruction,infos:&[AccountInfo<'a>],signed:&dyn Fn(&Pubkey)->bool)->ProgramResult{
 let account=|i:usize|account_of(instruction,infos,i);let d=&instruction.data;
 let(user,source,destination,destination_mint,in_amount)=if d[..8]==JUPITER_ROUTE_V2{(account(0),account(1),account(2),account(4),read64(d,8).unwrap())}else{assert_eq!(d[..8],JUPITER_ROUTE_V1);(account(1),account(2),account(3),account(5),read64(d,d.len()-19).unwrap())};
 assert!(signed(user.key));assert_eq!(key_at(&source,32),*user.key);assert_eq!(key_at(&destination,0),*destination_mint.key);
 let b=balance_of(&source);if b<in_amount{return Err(ProgramError::InsufficientFunds)}set_balance(&source,b-in_amount);
 let fill=FILL.with(|f|std::mem::take(&mut *f.borrow_mut()));set_balance(&destination,balance_of(&destination)+fill);
 let accumulator=ACCUMULATOR.with(|a|std::mem::take(&mut *a.borrow_mut()));
 {let mut l=user.try_borrow_mut_lamports().unwrap();if **l<accumulator{return Err(ProgramError::InsufficientFunds)}**l-=accumulator;}
 Ok(())
}
static INSTALL:Once=Once::new();
fn install(program:&Pubkey,now:i64){INSTALL.call_once(||{set_syscall_stubs(Box::new(HostStubs));});PROGRAM.with(|p|*p.borrow_mut()=*program);set_now(now);clear_cpis();FAULTS.with(|f|*f.borrow_mut()=Faults::default());HARVEST.with(|h|*h.borrow_mut()=(0,0));FILL.with(|f|*f.borrow_mut()=0);ACCUMULATOR.with(|a|*a.borrow_mut()=0);}
fn set_now(now:i64){CLOCK.with(|n|*n.borrow_mut()=now);}
fn cpi_count()->usize{CPI_LOG.with(|l|l.borrow().len())}
fn clear_cpis(){CPI_LOG.with(|l|l.borrow_mut().clear());}
fn set_fault(mutate:impl FnOnce(&mut Faults)){FAULTS.with(|f|mutate(&mut f.borrow_mut()));}
fn set_harvest(token0:u64,token1:u64){HARVEST.with(|h|*h.borrow_mut()=(token0,token1));}
fn set_fill(amount:u64){FILL.with(|f|*f.borrow_mut()=amount);}
fn set_accumulator(lamports:u64){ACCUMULATOR.with(|a|*a.borrow_mut()=lamports);}
#[derive(Clone,PartialEq,Eq,Debug)]
struct Acc{key:Pubkey,lamports:u64,data:Vec<u8>,owner:Pubkey,signer:bool,writable:bool,executable:bool}
impl Acc{
 fn new(key:Pubkey,owner:Pubkey,data:Vec<u8>)->Self{Self{key,lamports:1_000_000_000,data,owner,signer:false,writable:true,executable:false}}
 fn signer(mut self)->Self{self.signer=true;self}
 fn with_lamports(mut self,n:u64)->Self{self.lamports=n;self}
 fn program(key:Pubkey,owner:Pubkey)->Self{let mut a=Self::new(key,owner,vec![]);a.executable=true;a.writable=false;a}
 fn empty(key:Pubkey)->Self{Self::new(key,system_program::id(),vec![])}
 /// An address nobody has touched: no lamports, no data, System-owned. What a PDA looks like before creation.
 fn unfunded(key:Pubkey)->Self{let mut a=Self::empty(key);a.lamports=0;a}
 /// A token account at its rent, so a native (WSOL) account's balance stays consistent with its lamports.
 fn token(key:Pubkey,program:Pubkey,data:Vec<u8>)->Self{Self::new(key,program,data).with_lamports(rent(165))}
}
fn infos<'a>(accounts:&'a mut [Acc])->Vec<AccountInfo<'a>>{accounts.iter_mut().map(|a|AccountInfo::new(&a.key,a.signer,a.writable,&mut a.lamports,&mut a.data,&a.owner,a.executable,0)).collect()}
fn run(program:&Pubkey,accounts:&mut [Acc],data:&[u8])->ProgramResult{
 PROGRAM.with(|p|*p.borrow_mut()=*program);CREATED.with(|c|c.borrow_mut().clear());
 let result={let infos=infos(accounts);process_instruction(program,&infos,data)};
 if result.is_ok(){CREATED.with(|c|for created in c.borrow().iter(){
  let acc=accounts.iter_mut().find(|a|a.key==created.key).expect("created account was passed to the call");
  if !created.data.is_null(){acc.data=unsafe{std::slice::from_raw_parts(created.data,created.len)}.to_vec();}
  if let Some(owner)=created.owner{acc.owner=owner;}
 })}
 result
}
/// Every account of a scenario, addressed by key. `call` lends the named accounts to one instruction and takes
/// them back afterwards, so balances and data carry over from call to call as they do on chain. A key named
/// twice is passed as a clone (aliasing tests); a key never added is passed as an untouched address. A failed call
/// is rolled back as the runtime rolls back a failed instruction; its account bytes stay readable in `dirty`.
struct Bank{accounts:Vec<Acc>,dirty:Vec<Acc>}
impl Bank{
 fn new()->Self{Self{accounts:vec![],dirty:vec![]}}
 fn add(&mut self,acc:Acc)->Pubkey{let key=acc.key;assert!(self.accounts.iter().all(|a|a.key!=key),"duplicate account {key}");self.accounts.push(acc);key}
 fn add_once(&mut self,acc:Acc)->Pubkey{let key=acc.key;if self.accounts.iter().all(|a|a.key!=key){self.accounts.push(acc);}key}
 fn get(&self,key:&Pubkey)->&Acc{self.accounts.iter().find(|a|a.key==*key).unwrap_or_else(||panic!("no account {key}"))}
 fn get_mut(&mut self,key:&Pubkey)->&mut Acc{if self.accounts.iter().all(|a|a.key!=*key){self.accounts.push(Acc::unfunded(*key));}self.accounts.iter_mut().find(|a|a.key==*key).unwrap()}
 /// The account as the last failed call left it before the rollback.
 fn dirty(&self,key:&Pubkey)->&Acc{self.dirty.iter().find(|a|a.key==*key).unwrap_or_else(||panic!("no dirty account {key}"))}
 fn call(&mut self,program:&Pubkey,keys:&[Pubkey],data:&[u8])->ProgramResult{
  let mut selected:Vec<Acc>=vec![];
  for key in keys{match selected.iter().find(|a|a.key==*key){Some(taken)=>{let clone=taken.clone();selected.push(clone)}None=>{let acc=self.get_mut(key);selected.push(std::mem::replace(acc,Acc::unfunded(*key)))}}}
  let snapshot=selected.clone();
  let result=run(program,&mut selected,data);
  if result.is_err(){self.dirty=selected;selected=snapshot;}
  let mut restored:Vec<Pubkey>=vec![];
  for acc in selected{let key=acc.key;if restored.contains(&key){continue}restored.push(key);*self.get_mut(&key)=acc;}
  result
 }
 fn campaign(&self,key:&Pubkey)->Campaign{Campaign::decode(&self.get(key).data).expect("campaign decodes")}
 fn receipt(&self,key:&Pubkey)->Receipt{Receipt::decode(&self.get(key).data).expect("receipt decodes")}
}
const SUPPLY:u64=1_000_000_000_000_000;
const SOL:u64=1_000_000_000;
const NOW:i64=1_790_000_000;
const GENESIS:[u8;32]=[7u8;32];
const TIER_7:(u16,Pubkey,u64)=AMM_CONFIG_TIERS[1];
/// Raydium's pool-creation fee as the config's `create_pool_fee` (0.15 SOL); paid from the sponsored setup budget.
const CREATE_POOL_FEE:u64=150_000_000;
const AMM_CONFIG_OFF_CREATE_POOL_FEE:usize=36;
/// `creator_fee_rate` (offset 108) of both approved mainnet tiers, index 2 and index 7, read on 24 September 2026.
/// Every sealed config here carries it, so create and launch are tested against the real bytes.
const MAINNET_CREATOR_FEE_RATE:u64=500;
fn campaign_rent()->u64{rent(CAMPAIGN_LEN)}
fn receipt_rent()->u64{rent(RECEIPT_LEN)}
fn uri(text:&str)->([u8;METADATA_URI_MAX],u8){let mut u=[0u8;METADATA_URI_MAX];u[..text.len()].copy_from_slice(text.as_bytes());(u,text.len() as u8)}
fn standard_terms(creator:Pubkey,nonce:u64,opens_at:i64)->Terms{
 let(metadata_uri,metadata_uri_len)=uri("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/kids.json");
 Terms{layout_version:LAYOUT_VERSION,mode:MODE_STANDARD,decimals:6,split_policy:SPLIT_POLICY_STANDARD,vesting_rule:VESTING_RULE_THREE_MONTHS,fee_routing_version:FEE_ROUTING_VERSION_1,creator_fee_enabled:0,
  genesis:GENESIS,creator,nonce,dev:Pubkey::new_unique(),treasury:PLATFORM_TREASURY,child_mint:Pubkey::new_unique(),supply:SUPPLY,
  opens_at,deadline:opens_at+7200,launch_deadline:opens_at+14400,soft:50*SOL,hard:100*SOL,
  amm_program:RAYDIUM_CPMM,amm_config:TIER_7.1,amm_trade_fee_rate:TIER_7.2,amm_config_index:TIER_7.0,
  fee_weights:FEE_WEIGHTS_STANDARD,split_bps:SPLIT_STANDARD,vesting:VESTING_THREE_MONTHS,buyback_max_slippage_bps:0,lock_program:RAYDIUM_LOCK,distribution_program:Pubkey::default(),
  parent_mint:[Pubkey::default();2],parent_program:[Pubkey::default();2],parent_slot:[0;2],parent_root:[[0u8;32];2],parent_supply:[0;2],parent_eligible:[0;2],parent_expiry_seconds:0,
  metadata_hash:[9u8;32],metadata_uri_len,metadata_uri,parent_reference_config:[0;2]}
}
/// Family terms: parent A (classic Token) quotes against the config-0 pool, parent B (Token-2022) against the
/// config-7 pool, fills may land 1.5 % below the reference pool's own output.
const FAMILY_SLIPPAGE_BPS:u16=150;
const REFERENCE_CONFIG:[u8;2]=[1,8];
fn family_terms(creator:Pubkey,nonce:u64,opens_at:i64)->Terms{
 let mut t=standard_terms(creator,nonce,opens_at);
 t.mode=MODE_FAMILY;t.split_policy=SPLIT_POLICY_FAMILY;t.split_bps=SPLIT_FAMILY;t.fee_weights=FEE_WEIGHTS_FAMILY;
 t.parent_mint=[Pubkey::new_unique(),Pubkey::new_unique()];t.parent_program=[TOKEN_PROGRAM,TOKEN_2022_PROGRAM];t.parent_slot=[446_208_617,446_208_617];
 t.parent_root=[[1u8;32],[2u8;32]];t.parent_supply=[1_000_000_000_000,500_000_000_000];t.parent_eligible=[400_000_000_000,200_000_000_000];t.parent_expiry_seconds=2_592_000;
 t.buyback_max_slippage_bps=FAMILY_SLIPPAGE_BPS;t.parent_reference_config=REFERENCE_CONFIG;t
}
/// Reference pool reserves per parent as (WSOL, parent units): parent A trades at 10,000 units per lamport, parent B at
/// 5,000. `REFERENCE_HELD` is what each pool holds for its protocol and fund on the parent side, not part of the reserve.
/// Parent A's config (index 0) is created at 0.25 %; parent B's index 7 is the campaign's own 2.5 % tier already in the bank.
const REFERENCE_RESERVES:[(u64,u64);2]=[(100*SOL,1_000_000_000_000),(50*SOL,250_000_000_000)];
const REFERENCE_HELD:u64=1_000;
const REFERENCE_TRADE_FEE_RATE:u64=2_500;
fn body(terms:&Terms)->Vec<u8>{let mut d=vec![0u8;SEALED_END];terms.encode(&mut d);[vec![TAG_CREATE],d[SEALED_START..SEALED_END].to_vec()].concat()}
fn amm_config_data(index:u16,rate:u64,disabled:u8,creator_fee:u64)->Vec<u8>{let mut d=vec![0u8;AMM_CONFIG_LEN];d[..8].copy_from_slice(&amm_config_discriminator());d[AMM_CONFIG_OFF_DISABLE]=disabled;d[AMM_CONFIG_OFF_INDEX..AMM_CONFIG_OFF_INDEX+2].copy_from_slice(&index.to_le_bytes());put64(&mut d,AMM_CONFIG_OFF_TRADE_FEE_RATE,rate);put64(&mut d,AMM_CONFIG_OFF_PROTOCOL_FEE_RATE,AMM_PROTOCOL_FEE_RATE);put64(&mut d,AMM_CONFIG_OFF_FUND_FEE_RATE,AMM_FUND_FEE_RATE);put64(&mut d,AMM_CONFIG_OFF_CREATE_POOL_FEE,CREATE_POOL_FEE);put64(&mut d,AMM_CONFIG_OFF_CREATOR_FEE_RATE,creator_fee);d}
fn amm_config_acc(terms:&Terms)->Acc{Acc::new(terms.amm_config,terms.amm_program,amm_config_data(terms.amm_config_index,terms.amm_trade_fee_rate,0,MAINNET_CREATOR_FEE_RATE))}
fn mint_data(supply:u64,decimals:u8,mint_authority:Option<&Pubkey>,freeze_authority:Option<&Pubkey>)->Vec<u8>{let mut d=vec![0u8;82];if let Some(k)=mint_authority{d[..4].copy_from_slice(&[1,0,0,0]);d[4..36].copy_from_slice(k.as_ref());}put64(&mut d,36,supply);d[44]=decimals;d[45]=1;if let Some(k)=freeze_authority{d[46..50].copy_from_slice(&[1,0,0,0]);d[50..82].copy_from_slice(k.as_ref());}d}
fn token_data(mint:&Pubkey,owner:&Pubkey,amount:u64)->Vec<u8>{let mut d=vec![0u8;165];d[..32].copy_from_slice(mint.as_ref());d[32..64].copy_from_slice(owner.as_ref());put64(&mut d,64,amount);d[108]=1;d}
/// A Token-2022 token account: the classic layout, the account type byte, no extensions.
fn token_2022_data(mint:&Pubkey,owner:&Pubkey,amount:u64)->Vec<u8>{let mut d=token_data(mint,owner,amount);d.push(2);d}
fn ata_key(owner:&Pubkey,mint:&Pubkey)->Pubkey{Pubkey::find_program_address(&[owner.as_ref(),TOKEN_PROGRAM.as_ref(),mint.as_ref()],&ASSOCIATED_TOKEN_PROGRAM).0}
fn token_2022_mint_data(supply:u64)->Vec<u8>{let mut d=vec![0u8;166];put64(&mut d,36,supply);d[45]=1;d[165]=1;d.extend_from_slice(&18u16.to_le_bytes());d.extend_from_slice(&64u16.to_le_bytes());d.extend_from_slice(&[0u8;64]);d}
fn balance(acc:&Acc)->u64{read64(&acc.data,64).unwrap()}
/// One campaign scenario: the program, the creator, the sealed terms and the bank of accounts. Changing a sealed
/// field on `terms` before `create` keeps the campaign address (it depends on the creator and nonce only).
struct World{program:Pubkey,creator:Pubkey,terms:Terms,campaign:Pubkey,bump:u8,bank:Bank,system:Pubkey,launch_keys:Option<Vec<Pubkey>>,operator:Pubkey}
impl World{
 fn build(terms_of:fn(Pubkey,u64,i64)->Terms,now:i64)->Self{
  let program=Pubkey::new_unique();install(&program,now);let creator=Pubkey::new_unique();let terms=terms_of(creator,11,now+100);
  let(campaign,bump)=terms.campaign_address(&program);
  let mut bank=Bank::new();bank.add(Acc::empty(creator).signer().with_lamports(10*SOL));bank.add(Acc::unfunded(campaign));
  let system=bank.add(Acc::program(system_program::id(),Pubkey::default()));bank.add(amm_config_acc(&terms));
  if terms.is_family(){bank.add(Acc::new(terms.parent_mint[0],TOKEN_PROGRAM,mint_data(terms.parent_supply[0],9,None,None)));bank.add(Acc::new(terms.parent_mint[1],TOKEN_2022_PROGRAM,token_2022_mint_data(terms.parent_supply[1])));}
  let operator=bank.add(Acc::empty(Pubkey::new_unique()).signer().with_lamports(5*SOL));
  Self{program,creator,terms,campaign,bump,bank,system,launch_keys:None,operator}
 }
 fn standard()->Self{Self::build(standard_terms,NOW)}
 fn family()->Self{Self::build(family_terms,NOW)}
 fn create_keys(&self)->Vec<Pubkey>{let mut k=vec![self.creator,self.campaign,self.system,self.terms.amm_config];if self.terms.has_distribution(){k.push(self.terms.distribution_program);}if self.terms.is_family(){k.extend(self.terms.parent_mint);}k}
 fn create(&mut self)->ProgramResult{let keys=self.create_keys();let data=body(&self.terms);self.bank.call(&self.program,&keys,&data)}
 /// Writes a fresh campaign account for the current terms as create would, without create: for the paths create
 /// refuses today (Family, a sealed distribution program) whose later instructions must stay tested.
 fn seal_by_hand(&mut self){
  let campaign=Campaign::fresh(self.terms,self.bump);let mut data=vec![0u8;CAMPAIGN_LEN];campaign.encode(&mut data);
  let(key,program)=(self.campaign,self.program);let acc=self.bank.get_mut(&key);acc.data=data;acc.owner=program;acc.lamports=campaign_rent();
 }
 /// Create, or for Family terms the same validation followed by `seal_by_hand` (create refuses Family, error 91).
 fn seal(&mut self)->ProgramResult{
  if !self.terms.is_family(){return self.create()}
  validate_terms(&self.terms,&self.creator,CLOCK.with(|n|*n.borrow()))?;self.seal_by_hand();Ok(())
 }
 fn created()->Self{let mut w=Self::standard();w.create().unwrap();w}
 fn wallet(&mut self,lamports:u64)->Pubkey{let key=self.bank.add(Acc::empty(Pubkey::new_unique()).signer().with_lamports(lamports));self.bank.add(Acc::unfunded(Receipt::address(&self.program,&self.campaign,&key).0));key}
 fn receipt_key(&self,owner:&Pubkey)->Pubkey{Receipt::address(&self.program,&self.campaign,owner).0}
 fn commit_body(&self,amount:u64,sequence:u64)->Vec<u8>{let mut b=vec![TAG_COMMIT];b.extend_from_slice(&self.terms.genesis);b.extend_from_slice(&amount.to_le_bytes());b.extend_from_slice(&sequence.to_le_bytes());b}
 fn commit(&mut self,owner:&Pubkey,amount:u64,sequence:u64)->ProgramResult{let keys=[*owner,self.campaign,self.receipt_key(owner),self.system];let data=self.commit_body(amount,sequence);self.bank.call(&self.program,&keys,&data)}
 fn finalize(&mut self)->ProgramResult{self.bank.call(&self.program,&[self.campaign],&[TAG_FINALIZE])}
 fn settle(&mut self,owner:&Pubkey)->ProgramResult{let keys=[self.campaign,self.receipt_key(owner)];self.bank.call(&self.program,&keys,&[TAG_SETTLE])}
 fn refund(&mut self,owner:&Pubkey)->ProgramResult{let keys=[self.campaign,self.receipt_key(owner),*owner];self.bank.call(&self.program,&keys,&[TAG_REFUND])}
 fn assert_ready(&mut self)->ProgramResult{self.bank.call(&self.program,&[self.campaign],&[TAG_ASSERT_READY])}
 fn campaign(&self)->Campaign{self.bank.campaign(&self.campaign)}
 fn receipt(&self,owner:&Pubkey)->Receipt{self.bank.receipt(&self.receipt_key(owner))}
 fn authority(&self)->Pubkey{Pubkey::find_program_address(&[LAUNCH_AUTHORITY_SEED,self.campaign.as_ref()],&self.program).0}
 fn lamports(&self,key:&Pubkey)->u64{self.bank.get(key).lamports}
 fn set_campaign(&mut self,c:&Campaign){let key=self.campaign;c.encode(&mut self.bank.get_mut(&key).data);}
 /// A funded, settled campaign at the launch boundary: three wallets, oversubscribed, everything settled.
 fn settled_with(terms_of:fn(Pubkey,u64,i64)->Terms,now:i64)->(Self,Vec<Pubkey>){
  let mut w=Self::build(terms_of,now);w.seal().unwrap();set_now(w.terms.opens_at);
  let wallets:Vec<Pubkey>=(0..3).map(|_|w.wallet(200*SOL)).collect();
  for(i,owner)in wallets.iter().enumerate(){w.commit(owner,(40+20*i as u64)*SOL,0).unwrap();}
  set_now(w.terms.deadline);w.finalize().unwrap();for owner in &wallets{w.settle(owner).unwrap();}
  (w,wallets)
 }
 fn settled()->(Self,Vec<Pubkey>){Self::settled_with(standard_terms,NOW)}
 fn custody(&self)->Pubkey{ata_key(&self.authority(),&self.terms.child_mint)}
 fn wsol_custody(&self)->Pubkey{ata_key(&self.authority(),&WSOL)}
 fn pool_keys(&self)->(Pubkey,Pubkey,Pubkey,Pubkey,Pubkey,Pubkey,Pubkey){
  let t=&self.terms;let(m0,m1)=if t.child_mint<WSOL{(t.child_mint,WSOL)}else{(WSOL,t.child_mint)};
  let pool=Pubkey::find_program_address(&[CPMM_POOL_SEED,t.amm_config.as_ref(),m0.as_ref(),m1.as_ref()],&t.amm_program).0;
  let lp_mint=Pubkey::find_program_address(&[CPMM_LP_MINT_SEED,pool.as_ref()],&t.amm_program).0;
  let vault0=Pubkey::find_program_address(&[CPMM_VAULT_SEED,pool.as_ref(),m0.as_ref()],&t.amm_program).0;
  let vault1=Pubkey::find_program_address(&[CPMM_VAULT_SEED,pool.as_ref(),m1.as_ref()],&t.amm_program).0;
  let observation=Pubkey::find_program_address(&[CPMM_OBSERVATION_SEED,pool.as_ref()],&t.amm_program).0;
  (pool,lp_mint,vault0,vault1,observation,m0,m1)
 }
 fn lock_authority(&self)->Pubkey{Pubkey::find_program_address(&[LOCK_AUTH_SEED],&self.terms.lock_program).0}
 fn cpmm_authority(&self)->Pubkey{Pubkey::find_program_address(&[CPMM_AUTH_SEED],&self.terms.amm_program).0}
 /// The 29 tag 6 accounts as the keeper prepares them: a keeper with rent money, the launch authority address funded
 /// with the setup budget, the child mint under the launch authority, the custody holding the whole supply, an empty
 /// WSOL custody, a fresh fee NFT signer, the programs and sysvars, and every pool and lock address untouched.
 fn launch_keys(&mut self)->Vec<Pubkey>{
  if let Some(keys)=&self.launch_keys{return keys.clone()}
  let t=self.terms;let authority=self.authority();let mint=t.child_mint;
  let keeper=self.bank.add(Acc::empty(Pubkey::new_unique()).signer().with_lamports(5*SOL));
  self.bank.add(Acc::empty(authority).with_lamports(SOL));
  self.bank.add(Acc::new(mint,TOKEN_PROGRAM,mint_data(t.supply,t.decimals,Some(&authority),None)));
  let custody=self.bank.add(Acc::token(ata_key(&authority,&mint),TOKEN_PROGRAM,token_data(&mint,&authority,t.supply)));
  let wsol_custody=self.bank.add(Acc::token(ata_key(&authority,&WSOL),TOKEN_PROGRAM,token_data(&WSOL,&authority,0)));
  let nft=self.bank.add(Acc::unfunded(Pubkey::new_unique()).signer());
  for(program,owner)in[(TOKEN_PROGRAM,BPF_LOADER_UPGRADEABLE),(ASSOCIATED_TOKEN_PROGRAM,BPF_LOADER_UPGRADEABLE),(t.amm_program,BPF_LOADER_UPGRADEABLE),(t.lock_program,BPF_LOADER_UPGRADEABLE),(METADATA_PROGRAM,BPF_LOADER_UPGRADEABLE)]{self.bank.add_once(Acc::program(program,owner));}
  self.bank.add_once(Acc::new(solana_program::sysvar::rent::id(),solana_program::sysvar::id(),vec![]));
  self.bank.add_once(Acc::new(WSOL,TOKEN_PROGRAM,mint_data(u64::MAX/4,9,None,None)));
  let(pool,lp_mint,vault0,vault1,observation,_,_)=self.pool_keys();let lock_authority=self.lock_authority();
  let locked=Pubkey::find_program_address(&[LOCKED_LIQUIDITY_SEED,nft.as_ref()],&t.lock_program).0;
  let metadata=Pubkey::find_program_address(&[METADATA_SEED,METADATA_PROGRAM.as_ref(),nft.as_ref()],&METADATA_PROGRAM).0;
  let keys=vec![self.campaign,keeper,authority,mint,custody,wsol_custody,nft,ata_key(&self.campaign,&nft),locked,ata_key(&lock_authority,&lp_mint),metadata,TOKEN_PROGRAM,ASSOCIATED_TOKEN_PROGRAM,self.system,solana_program::sysvar::rent::id(),t.amm_program,t.amm_config,self.cpmm_authority(),pool,lp_mint,ata_key(&authority,&lp_mint),vault0,vault1,CPMM_CREATE_POOL_FEE_RECEIVER,observation,t.lock_program,lock_authority,METADATA_PROGRAM,WSOL];
  assert_eq!(keys.len(),LAUNCH_ACCOUNTS);self.launch_keys=Some(keys.clone());keys
 }
 fn launch(&mut self)->ProgramResult{let keys=self.launch_keys();self.bank.call(&self.program,&keys,&[TAG_LAUNCH])}
 fn launch_with(&mut self,keys:&[Pubkey])->ProgramResult{self.bank.call(&self.program,keys,&[TAG_LAUNCH])}
 /// A launched campaign: settled, then tag 6 at the funding deadline.
 fn live_with(terms_of:fn(Pubkey,u64,i64)->Terms,now:i64)->(Self,Vec<Pubkey>){let(mut w,wallets)=Self::settled_with(terms_of,now);w.launch().unwrap();(w,wallets)}
 fn live()->(Self,Vec<Pubkey>){Self::live_with(standard_terms,NOW)}
 /// A Standard campaign launched exactly at `launch_time` (its funding deadline).
 fn live_at(launch_time:i64)->(Self,Vec<Pubkey>){Self::live_with(standard_terms,launch_time-7300)}
 fn holder_ata(&mut self,owner:&Pubkey)->Pubkey{let mint=self.terms.child_mint;self.bank.add(Acc::token(ata_key(owner,&mint),TOKEN_PROGRAM,token_data(&mint,owner,0)))}
 fn claim_participant(&mut self,owner:&Pubkey)->ProgramResult{let keys=[self.campaign,self.receipt_key(owner),self.authority(),self.terms.child_mint,self.custody(),ata_key(owner,&self.terms.child_mint),TOKEN_PROGRAM];self.bank.call(&self.program,&keys,&[TAG_CLAIM_PARTICIPANT])}
 fn claim_dev(&mut self)->ProgramResult{let keys=[self.campaign,self.authority(),self.terms.child_mint,self.custody(),ata_key(&self.terms.dev,&self.terms.child_mint),TOKEN_PROGRAM];self.bank.call(&self.program,&keys,&[TAG_CLAIM_DEV])}
 fn balance(&self,token_account:&Pubkey)->u64{balance(self.bank.get(token_account))}
 fn fee_authority(&self)->Pubkey{fees::fee_authority(&self.campaign,&self.program).0}
 fn fee_state_key(&self)->Pubkey{fees::fee_state_address(&self.campaign,&self.program).0}
 fn fee_state(&self)->FeeState{FeeState::decode(&self.bank.get(&self.fee_state_key()).data,&self.campaign).expect("fee state decodes")}
 fn fee_child_custody(&self)->Pubkey{ata_key(&self.fee_authority(),&self.terms.child_mint)}
 fn fee_wsol_custody(&self)->Pubkey{ata_key(&self.fee_authority(),&WSOL)}
 fn parent_custody(&self,parent:usize)->Pubkey{parent_ata(&self.fee_authority(),&self.terms.parent_mint[parent],&self.terms.parent_program[parent])}
 /// The fee-cycle accounts as the operator prepares them: the fee authority holding some lamports, its empty
 /// custody accounts (child, WSOL and, for Family, both parents), the recipients' WSOL accounts, the programs.
 fn fee_setup(&mut self){
  let authority=self.fee_authority();let t=self.terms;
  self.bank.add(Acc::empty(authority).with_lamports(SOL/10));
  self.bank.add(Acc::token(ata_key(&authority,&t.child_mint),TOKEN_PROGRAM,token_data(&t.child_mint,&authority,0)));
  self.bank.add(Acc::token(ata_key(&authority,&WSOL),TOKEN_PROGRAM,token_data(&WSOL,&authority,0)));
  self.bank.add(Acc::token(ata_key(&t.treasury,&WSOL),TOKEN_PROGRAM,token_data(&WSOL,&t.treasury,0)));
  self.bank.add(Acc::token(ata_key(&t.dev,&WSOL),TOKEN_PROGRAM,token_data(&WSOL,&t.dev,0)));
  self.bank.add_once(Acc::empty(t.treasury).signer().with_lamports(SOL));
  for(program,owner)in[(TOKEN_2022_PROGRAM,BPF_LOADER_UPGRADEABLE),(MEMO_PROGRAM,BPF_LOADER_UPGRADEABLE),(JUPITER_PROGRAM,BPF_LOADER_UPGRADEABLE)]{self.bank.add_once(Acc::program(program,owner));}
  if t.is_family(){
   self.bank.add_once(Acc::token(self.parent_custody(0),t.parent_program[0],token_data(&t.parent_mint[0],&authority,0)));
   self.bank.add_once(Acc::token(self.parent_custody(1),t.parent_program[1],token_2022_data(&t.parent_mint[1],&authority,0)));
   for parent in 0..2{self.add_reference_pool(parent);}
  }
 }
 /// The reference pool of one parent as a cluster would hold it: the AMM config at its index, the canonical pool
 /// state (with fees held for the protocol and fund on the parent side), and both vaults owned by the CPMM authority.
 fn add_reference_pool(&mut self,parent:usize){
  let t=self.terms;let Some(index)=t.reference_config_index(parent)else{return};
  let(config,pool,parent_vault,wsol_vault)=self.reference_keys(parent);let parent_mint=t.parent_mint[parent];let program=t.parent_program[parent];
  self.bank.add_once(Acc::new(config,t.amm_program,amm_config_data(index,REFERENCE_TRADE_FEE_RATE,0,MAINNET_CREATOR_FEE_RATE)));
  let(m0,m1,v0,v1,p0,p1)=if parent_mint<WSOL{(parent_mint,WSOL,parent_vault,wsol_vault,program,TOKEN_PROGRAM)}else{(WSOL,parent_mint,wsol_vault,parent_vault,TOKEN_PROGRAM,program)};
  let observation=Pubkey::find_program_address(&[CPMM_OBSERVATION_SEED,pool.as_ref()],&t.amm_program).0;
  let mut state=pool_state_data(&config,&Pubkey::new_unique(),&v0,&v1,&Pubkey::new_unique(),&m0,&m1,(&p0,&p1),&observation,1);
  let(protocol_at,fund_at)=if m0==parent_mint{(POOL_OFF_PROTOCOL_FEES_0,POOL_OFF_FUND_FEES_0)}else{(POOL_OFF_PROTOCOL_FEES_1,POOL_OFF_FUND_FEES_1)};
  put64(&mut state,protocol_at,REFERENCE_HELD/2);put64(&mut state,fund_at,REFERENCE_HELD/2);
  self.bank.add_once(Acc::new(pool,t.amm_program,state));
  let(reserve_wsol,reserve_parent)=REFERENCE_RESERVES[parent];let cpmm_authority=self.cpmm_authority();
  let parent_data=if program==TOKEN_2022_PROGRAM{token_2022_data(&parent_mint,&cpmm_authority,reserve_parent+REFERENCE_HELD)}else{token_data(&parent_mint,&cpmm_authority,reserve_parent+REFERENCE_HELD)};
  self.bank.add_once(Acc::token(parent_vault,program,parent_data));
  self.bank.add_once(Acc::token(wsol_vault,TOKEN_PROGRAM,token_data(&WSOL,&cpmm_authority,reserve_wsol)));
 }
 /// (config, pool, parent vault, WSOL vault) of a parent's reference pool; placeholders when the terms seal none.
 fn reference_keys(&self,parent:usize)->(Pubkey,Pubkey,Pubkey,Pubkey){
  let t=self.terms;let Some(index)=t.reference_config_index(parent)else{return(Pubkey::new_unique(),Pubkey::new_unique(),Pubkey::new_unique(),Pubkey::new_unique())};
  let config=amm_config_address(&t.amm_program,index);let parent_mint=t.parent_mint[parent];
  let(m0,m1)=if parent_mint<WSOL{(parent_mint,WSOL)}else{(WSOL,parent_mint)};
  let pool=Pubkey::find_program_address(&[CPMM_POOL_SEED,config.as_ref(),m0.as_ref(),m1.as_ref()],&t.amm_program).0;
  let vault=|mint:&Pubkey|Pubkey::find_program_address(&[CPMM_VAULT_SEED,pool.as_ref(),mint.as_ref()],&t.amm_program).0;
  (config,pool,vault(&parent_mint),vault(&WSOL))
 }
 /// The trade fee rate of a parent's reference config as the bank holds it.
 fn reference_rate(&self,parent:usize)->u64{let(config,..)=self.reference_keys(parent);read64(&self.bank.get(&config).data,AMM_CONFIG_OFF_TRADE_FEE_RATE).unwrap()}
 /// The floor tag 25 must see for a slice, from the sealed reserves, the config's rate and the sealed slippage
 /// (`policy::reference_out`, `buyback_floor`).
 fn reference_floor(&self,parent:usize,amount:u64)->u64{
  let(reserve_wsol,reserve_parent)=REFERENCE_RESERVES[parent];
  buyback_floor(reference_out(amount,reserve_wsol,reserve_parent,self.reference_rate(parent)).unwrap(),self.terms.buyback_max_slippage_bps)
 }
 fn fee_keys(&self,signer:Pubkey)->Vec<Pubkey>{vec![self.campaign,signer,self.fee_state_key(),self.fee_authority()]}
 fn fees_init_by(&mut self,signer:Pubkey,operator:Pubkey)->ProgramResult{let mut keys=self.fee_keys(signer);keys.push(self.system);let data=[vec![TAG_FEES_INIT],operator.to_bytes().to_vec()].concat();self.bank.call(&self.program,&keys,&data)}
 fn fees_init(&mut self)->ProgramResult{let(treasury,operator)=(self.terms.treasury,self.operator);self.fees_init_by(treasury,operator)}
 fn fees_rotate_by(&mut self,signer:Pubkey,operator:Pubkey)->ProgramResult{let keys=self.fee_keys(signer);let data=[vec![TAG_FEES_ROTATE_OPERATOR],operator.to_bytes().to_vec()].concat();self.bank.call(&self.program,&keys,&data)}
 fn collect_keys(&self)->Vec<Pubkey>{
  let c=self.campaign();let t=self.terms;let(pool,lp_mint,vault0,vault1,_,m0,m1)=self.pool_keys();
  let mut keys=self.fee_keys(self.operator);
  keys.extend([self.fee_child_custody(),self.fee_wsol_custody(),ata_key(&self.campaign,&c.state.fee_nft),Pubkey::find_program_address(&[LOCKED_LIQUIDITY_SEED,c.state.fee_nft.as_ref()],&t.lock_program).0,pool,lp_mint,vault0,vault1,m0,m1,ata_key(&self.lock_authority(),&lp_mint),t.amm_program,self.cpmm_authority(),t.lock_program,self.lock_authority(),TOKEN_PROGRAM,TOKEN_2022_PROGRAM,MEMO_PROGRAM]);keys
 }
 fn fees_collect(&mut self,fee_lp_amount:u64)->ProgramResult{let keys=self.collect_keys();let data=[vec![TAG_FEES_COLLECT],fee_lp_amount.to_le_bytes().to_vec()].concat();self.bank.call(&self.program,&keys,&data)}
 fn distribute_keys(&self)->Vec<Pubkey>{let mut keys=self.fee_keys(self.operator);keys.extend([self.fee_wsol_custody(),ata_key(&self.terms.treasury,&WSOL),ata_key(&self.terms.dev,&WSOL),TOKEN_PROGRAM]);keys}
 fn fees_distribute(&mut self)->ProgramResult{let keys=self.distribute_keys();self.bank.call(&self.program,&keys,&[TAG_FEES_DISTRIBUTE])}
 fn fees_burn_child(&mut self,amount:u64)->ProgramResult{let mut keys=self.fee_keys(self.operator);keys.extend([self.fee_child_custody(),self.terms.child_mint,TOKEN_PROGRAM]);let data=[vec![TAG_FEES_BURN_CHILD],amount.to_le_bytes().to_vec()].concat();self.bank.call(&self.program,&keys,&data)}
 fn buy_burn_keys(&self,parent:usize,remaining:&[Pubkey])->Vec<Pubkey>{
  let mut keys=self.fee_keys(self.operator);let t=self.terms;let(config,pool,parent_vault,wsol_vault)=self.reference_keys(parent);
  keys.extend([self.fee_wsol_custody(),self.parent_custody(parent),t.parent_mint[parent],WSOL,TOKEN_PROGRAM,t.parent_program[parent],JUPITER_PROGRAM,Pubkey::find_program_address(&[JUPITER_EVENT_AUTHORITY_SEED],&JUPITER_PROGRAM).0,config,pool,parent_vault,wsol_vault]);
  assert_eq!(keys.len(),BUY_BURN_FIXED_ACCOUNTS);keys.extend_from_slice(remaining);keys
 }
 fn buy_burn_body(parent:u8,amount:u64,min:u64,expiry:i64,route:&[u8])->Vec<u8>{let mut b=vec![TAG_FEES_BUY_BURN,parent];b.extend_from_slice(&amount.to_le_bytes());b.extend_from_slice(&min.to_le_bytes());b.extend_from_slice(&(expiry as u64).to_le_bytes());b.extend_from_slice(route);b}
 fn fees_buy_burn(&mut self,parent:u8,amount:u64,min:u64,expiry:i64,route:&[u8],remaining:&[Pubkey])->ProgramResult{let keys=self.buy_burn_keys(parent as usize,remaining);let data=Self::buy_burn_body(parent,amount,min,expiry,route);self.bank.call(&self.program,&keys,&data)}
 fn parent_supply(&self,parent:usize)->u64{read64(&self.bank.get(&self.terms.parent_mint[parent]).data,36).unwrap()}
}
fn route_v2(in_amount:u64,quoted:u64,slippage:u16)->Vec<u8>{fees::tests::route_v2_header(in_amount,quoted,slippage,0,1)}
#[test]fn campaign_layout_offsets_match_the_table_and_round_trip(){
 let creator=Pubkey::new_unique();let mut terms=family_terms(creator,5,NOW);terms.distribution_program=Pubkey::new_unique();
 let mut c=Campaign::fresh(terms,251);c.state.phase=1;c.state.flags=FLAG_DISTRIBUTION_ACTIVATED;c.state.total=1;c.state.refunded=2;c.state.receipt_count=3;c.state.settled_count=4;c.state.settled_accepted=5;c.state.participant_claimed=6;c.state.dev_claimed=7;c.state.parent_claimed=[8,9];c.state.launch_time=10;c.state.pool=Pubkey::new_unique();c.state.fee_nft=Pubkey::new_unique();
 let mut d=vec![0u8;CAMPAIGN_LEN];c.encode(&mut d);
 assert_eq!(&d[..8],b"KIDSLV2C");assert_eq!(u16::from_le_bytes([d[8],d[9]]),2);assert_eq!(d[10],MODE_FAMILY);assert_eq!(d[11],6);assert_eq!(d[12],2);assert_eq!(d[13],1);assert_eq!(d[14],1);assert_eq!(d[15],0);
 assert_eq!(d[16..48],GENESIS);assert_eq!(&d[48..80],creator.as_ref());assert_eq!(read64(&d,80).unwrap(),5);assert_eq!(&d[88..120],terms.dev.as_ref());assert_eq!(&d[120..152],terms.treasury.as_ref());assert_eq!(&d[152..184],terms.child_mint.as_ref());
 assert_eq!(read64(&d,184).unwrap(),SUPPLY);assert_eq!(read64(&d,192).unwrap() as i64,NOW);assert_eq!(read64(&d,200).unwrap() as i64,NOW+7200);assert_eq!(read64(&d,208).unwrap() as i64,NOW+14400);assert_eq!(read64(&d,216).unwrap(),50*SOL);assert_eq!(read64(&d,224).unwrap(),100*SOL);
 assert_eq!(&d[232..264],RAYDIUM_CPMM.as_ref());assert_eq!(&d[264..296],TIER_7.1.as_ref());assert_eq!(read64(&d,296).unwrap(),25_000);assert_eq!(u16::from_le_bytes([d[304],d[305]]),7);
 assert_eq!(d[306..314],[98,0,20,0,25,0,25,0]);assert_eq!(d[314..324],[0xfe,0x10,0xfe,0x10,0xf4,0x01,0xf4,0x01,0x2c,0x01],"4350, 4350, 500, 500, 300");
 assert_eq!(d[324..329],[100,0,200,0,3]);assert_eq!(d[329..332],[150,0,0],"slippage cap u16 then one zero byte");assert_eq!(&d[332..364],RAYDIUM_LOCK.as_ref());assert_eq!(&d[364..396],terms.distribution_program.as_ref());
 assert_eq!(&d[396..428],terms.parent_mint[0].as_ref());assert_eq!(&d[428..460],terms.parent_mint[1].as_ref());assert_eq!(&d[460..492],TOKEN_PROGRAM.as_ref());assert_eq!(&d[492..524],TOKEN_2022_PROGRAM.as_ref());
 assert_eq!(read64(&d,524).unwrap(),446_208_617);assert_eq!(read64(&d,532).unwrap(),446_208_617);assert_eq!(d[540..572],[1u8;32]);assert_eq!(d[572..604],[2u8;32]);
 assert_eq!(read64(&d,604).unwrap(),1_000_000_000_000);assert_eq!(read64(&d,612).unwrap(),500_000_000_000);assert_eq!(read64(&d,620).unwrap(),400_000_000_000);assert_eq!(read64(&d,628).unwrap(),200_000_000_000);assert_eq!(read64(&d,636).unwrap(),2_592_000);
 assert_eq!(d[644..676],[9u8;32]);assert_eq!(d[676] as usize,terms.metadata_uri().len());assert_eq!(&d[677..677+terms.metadata_uri().len()],terms.metadata_uri());assert_eq!(d[805..808],[1,8,0],"reference config index plus one per parent, then one zero byte");
 assert_eq!(terms.reference_config_index(0),Some(0));assert_eq!(terms.reference_config_index(1),Some(7));assert_eq!(standard_terms(creator,5,NOW).reference_config_index(0),None);
 assert_eq!(d[808..840],terms_hash(&d[8..808]));assert_eq!(d[840],1);assert_eq!(d[841],251);assert_eq!(d[842],1);assert_eq!(d[843..848],[0;5]);
 for(at,n)in[(848,1u64),(856,2),(864,3),(872,4),(880,5),(888,6),(896,7),(904,8),(912,9),(920,10)]{assert_eq!(read64(&d,at).unwrap(),n,"offset {at}");}
 assert_eq!(&d[928..960],c.state.pool.as_ref());assert_eq!(&d[960..992],c.state.fee_nft.as_ref());assert_eq!(d[992..],[0u8;32]);
 assert_eq!(Campaign::decode(&d).unwrap(),c);assert_eq!(Terms::decode(&d).unwrap(),terms);
 let mut altered=d.clone();altered[OFF_SOFT]^=1;assert_eq!(Campaign::decode(&altered).unwrap_err(),err(E_TERMS_INVALID),"terms bytes that do not hash to the stored hash are unreadable");
 let mut wrong_magic=d.clone();wrong_magic[0]^=1;assert_eq!(Campaign::decode(&wrong_magic).unwrap_err(),ProgramError::InvalidAccountData);
 let mut wrong_version=d.clone();wrong_version[8]=1;assert_eq!(Campaign::decode(&wrong_version).unwrap_err(),ProgramError::InvalidAccountData);
 assert_eq!(Campaign::decode(&d[..1000]).unwrap_err(),ProgramError::InvalidAccountData);
 let mut r=Receipt::new(Pubkey::new_unique(),Pubkey::new_unique(),9);r.committed=1;r.refunded=2;r.sequence=3;r.accepted=4;r.claimed_tokens=5;r.settled=true;r.claimed=true;
 let mut rd=vec![0u8;RECEIPT_LEN];r.encode(&mut rd);assert_eq!(&rd[..8],b"KIDSLV2R");assert_eq!(&rd[8..40],r.campaign.as_ref());assert_eq!(&rd[40..72],r.owner.as_ref());
 for(at,n)in[(72,1u64),(80,2),(88,3),(96,4),(104,5)]{assert_eq!(read64(&rd,at).unwrap(),n);}assert_eq!(rd[112..115],[9,1,1]);assert_eq!(rd[115..],[0u8;13]);assert_eq!(Receipt::decode(&rd).unwrap(),r);
}
#[test]fn campaign_read_binds_owner_address_and_bump(){
 let w=World::created();let c=w.campaign();assert_eq!(c.state.bump,w.bump);assert_eq!(c.state.phase,PHASE_FUNDING);assert_eq!(c.terms,w.terms);
 let good=w.bank.get(&w.campaign).clone();
 let read=|acc:&mut Acc|{let i=infos(std::slice::from_mut(acc));Campaign::read(&i[0],&w.program).map(|c|c.state.bump)};
 assert_eq!(read(&mut good.clone()).unwrap(),w.bump);
 let mut foreign=good.clone();foreign.owner=Pubkey::new_unique();assert_eq!(read(&mut foreign).unwrap_err(),ProgramError::IncorrectProgramId);
 let mut moved=good.clone();moved.key=Pubkey::new_unique();assert_eq!(read(&mut moved).unwrap_err(),ProgramError::InvalidSeeds);
 let mut other_program=good.clone();{let i=infos(std::slice::from_mut(&mut other_program));assert_eq!(Campaign::read(&i[0],&Pubkey::new_unique()).unwrap_err(),ProgramError::IncorrectProgramId);}
}
#[test]fn create_seals_standard_terms_pays_rent_from_the_creator_and_refuses_a_second_creation(){
 let mut w=World::standard();let before=w.lamports(&w.creator);
 w.create().unwrap();
 let acc=w.bank.get(&w.campaign);assert_eq!(acc.owner,w.program);assert_eq!(acc.lamports,campaign_rent());assert_eq!(before-w.lamports(&w.creator),campaign_rent());
 let c=w.campaign();assert_eq!(c.terms,w.terms);assert_eq!(c.state.terms_hash,w.terms.hash());assert_eq!(c.state.total,0);assert_eq!(c.state.receipt_count,0);assert!(!c.distribution_activated());
 assert_eq!(c.terms.parent_mint,[Pubkey::default();2]);assert_eq!(c.terms.split().unwrap().parent_a,0);assert_eq!(c.terms.split().unwrap().parent_b,0,"Standard allocates no parent reserve");
 assert_eq!(w.create().unwrap_err(),ProgramError::AccountAlreadyInitialized);
 assert_eq!(w.campaign(),c,"a refused second creation changes nothing");
}
#[test]fn create_refuses_an_opening_time_in_the_past_beyond_the_tolerance(){
 for(offset,expected)in[(-OPENS_AT_TOLERANCE_SECONDS-1,Some(E_OPENS_AT_IN_PAST)),(-OPENS_AT_TOLERANCE_SECONDS,None),(0,None),(1,None),(3600,None)]{
  let mut w=World::standard();w.terms=standard_terms(w.creator,11,NOW+offset);
  let result=w.create();
  match expected{Some(code)=>assert_eq!(result.unwrap_err(),err(code),"offset {offset}"),None=>{result.unwrap();assert_eq!(w.campaign().terms.opens_at,NOW+offset);}}
 }
}
fn create_with(mutate:impl FnOnce(&mut Terms))->ProgramResult{let mut w=World::standard();mutate(&mut w.terms);w.create()}
fn create_family_with(mutate:impl FnOnce(&mut Terms))->ProgramResult{let mut w=World::family();mutate(&mut w.terms);w.create()}
#[test]fn create_refuses_every_out_of_range_or_inconsistent_sealed_field(){
 create_with(|_|{}).unwrap();
 let invalid=err(E_TERMS_INVALID);
 assert_eq!(create_with(|t|t.layout_version=1).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.mode=2).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.creator=Pubkey::new_unique()).unwrap_err(),invalid,"the sealed creator must be the signer");
 assert_eq!(create_with(|t|t.genesis=[0;32]).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.dev=Pubkey::default()).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.treasury=Pubkey::default()).unwrap_err(),err(E_TREASURY_NOT_PLATFORM));
 assert_eq!(create_with(|t|t.treasury=Pubkey::new_unique()).unwrap_err(),err(E_TREASURY_NOT_PLATFORM),"the treasury is the platform key, never creator-chosen");
 assert_eq!(create_with(|t|t.treasury=t.creator).unwrap_err(),err(E_TREASURY_NOT_PLATFORM));
 assert_eq!(PLATFORM_TREASURY.to_string(),"91eLwFTAxkcQLPSMxbzdSFkTyEwyRYcoZk64HMZj8vX");
 assert_eq!(create_with(|t|t.child_mint=Pubkey::default()).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.child_mint=WSOL).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.supply=9_999).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.decimals=10).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.deadline=t.opens_at).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.launch_deadline=t.deadline).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.soft=0).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.soft=t.hard+1).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.soft=t.hard).unwrap_err(),invalid,"equal caps can be bricked by settlement rounding");
 assert_eq!(create_with(|t|t.hard=t.soft+t.soft/100-1).unwrap_err(),invalid,"one lamport short of the one percent margin");
 create_with(|t|t.hard=t.soft+t.soft/100).unwrap();
 assert_eq!(least_hard_cap(50*SOL).unwrap(),50*SOL+SOL/2);assert_eq!(least_hard_cap(1).unwrap(),2,"the margin rounds up");assert_eq!(least_hard_cap(99).unwrap(),100);assert_eq!(least_hard_cap(100).unwrap(),101);
 assert!(least_hard_cap(u64::MAX).is_err());
 assert_eq!(create_with(|t|{t.soft=1;t.hard=1}).unwrap_err(),invalid);create_with(|t|{t.soft=1;t.hard=2}).unwrap();
 assert_eq!(create_with(|t|{t.soft=u64::MAX;t.hard=u64::MAX}).unwrap_err(),invalid,"no margin fits above u64::MAX");
 assert_eq!(create_with(|t|t.creator_fee_enabled=1).unwrap_err(),invalid);
 assert_eq!(create_with(|t|t.lock_program=Pubkey::new_unique()).unwrap_err(),invalid);
 let table=err(E_POLICY_TABLE);
 assert_eq!(create_with(|t|t.split_policy=SPLIT_POLICY_FAMILY).unwrap_err(),table,"Standard cannot seal the Family split id");
 assert_eq!(create_with(|t|t.split_bps=SPLIT_FAMILY).unwrap_err(),table);
 assert_eq!(create_with(|t|t.split_bps.participants=4851).unwrap_err(),table);
 assert_eq!(create_with(|t|t.vesting_rule=2).unwrap_err(),table);
 assert_eq!(create_with(|t|t.vesting.months=4).unwrap_err(),table);
 assert_eq!(create_with(|t|t.vesting.instant_bps=200).unwrap_err(),table);
 assert_eq!(create_with(|t|t.fee_routing_version=2).unwrap_err(),table);
 assert_eq!(create_with(|t|t.fee_weights=FEE_WEIGHTS_FAMILY).unwrap_err(),table,"Standard cannot seal the Family routing");
 assert_eq!(create_with(|t|t.fee_weights.treasury=149).unwrap_err(),table);
 let config=err(E_AMM_CONFIG);
 assert_eq!(create_with(|t|t.amm_program=Pubkey::new_unique()).unwrap_err(),config);
 assert_eq!(create_with(|t|t.amm_trade_fee_rate=30_000).unwrap_err(),config,"index 7 is 2.5 %");
 assert_eq!(create_with(|t|t.amm_config_index=2).unwrap_err(),config,"index 2 is another address");
 assert_eq!(create_with(|t|t.amm_config=Pubkey::new_unique()).unwrap_err(),config);
 let metadata=err(E_METADATA);
 assert_eq!(create_with(|t|t.metadata_hash=[0;32]).unwrap_err(),metadata);
 assert_eq!(create_with(|t|t.metadata_uri_len=0).unwrap_err(),metadata);
 assert_eq!(create_with(|t|t.metadata_uri_len=129).unwrap_err(),metadata);
 assert_eq!(create_with(|t|t.metadata_uri[0]=b' ').unwrap_err(),metadata,"printable ASCII only");
 assert_eq!(create_with(|t|t.metadata_uri[127]=b'x').unwrap_err(),metadata,"bytes past the length must be zero");
 create_with(|t|{let(u,l)=uri(&"a".repeat(128));t.metadata_uri=u;t.metadata_uri_len=l;}).unwrap();
}
#[test]fn create_refuses_parent_state_on_standard_and_requires_it_on_family(){
 let parents=err(E_MODE_PARENTS);
 assert_eq!(create_with(|t|t.parent_mint[0]=Pubkey::new_unique()).unwrap_err(),parents);
 assert_eq!(create_with(|t|t.parent_program[1]=TOKEN_PROGRAM).unwrap_err(),parents);
 assert_eq!(create_with(|t|t.parent_slot[0]=1).unwrap_err(),parents);
 assert_eq!(create_with(|t|t.parent_root[1]=[1;32]).unwrap_err(),parents);
 assert_eq!(create_with(|t|t.parent_supply[0]=1).unwrap_err(),parents);
 assert_eq!(create_with(|t|t.parent_eligible[1]=1).unwrap_err(),parents);
 assert_eq!(create_with(|t|t.parent_expiry_seconds=1).unwrap_err(),parents);
 assert_eq!(create_with(|t|t.buyback_max_slippage_bps=1).unwrap_err(),parents,"Standard has no buyback");
 assert_eq!(create_with(|t|t.parent_reference_config[1]=1).unwrap_err(),parents);
 let family_gate=err(E_FAMILY_NOT_AVAILABLE);
 assert_eq!(create_family_with(|_|{}).unwrap_err(),family_gate,"valid Family terms pass every rule and are refused at the gate");
 assert_eq!(create_family_with(|t|t.parent_expiry_seconds=0).unwrap_err(),family_gate);
 assert_eq!(create_family_with(|t|t.parent_reference_config=[0,0]).unwrap_err(),family_gate,"a parent without a reference pool is a valid term (tag 25 refuses that parent)");
 assert_eq!(create_family_with(|t|t.buyback_max_slippage_bps=BUYBACK_SLIPPAGE_CEILING_BPS).unwrap_err(),family_gate);
 assert_eq!(create_family_with(|t|t.buyback_max_slippage_bps=0).unwrap_err(),parents,"Family needs a slippage cap");
 assert_eq!(create_family_with(|t|t.buyback_max_slippage_bps=BUYBACK_SLIPPAGE_CEILING_BPS+1).unwrap_err(),parents,"above 5 %");
 assert_eq!(create_family_with(|t|t.parent_mint[1]=t.parent_mint[0]).unwrap_err(),parents,"two distinct parents");
 assert_eq!(create_family_with(|t|t.parent_mint[0]=t.child_mint).unwrap_err(),parents);
 assert_eq!(create_family_with(|t|{t.parent_mint[0]=WSOL;t.parent_program[0]=TOKEN_PROGRAM}).unwrap_err(),parents,"WSOL cannot be a parent: tag 25 would read and write one custody");
 assert_eq!(create_family_with(|t|{t.parent_mint[1]=WSOL;t.parent_program[1]=TOKEN_PROGRAM}).unwrap_err(),parents);
 assert_eq!(create_family_with(|t|t.parent_program[0]=Pubkey::new_unique()).unwrap_err(),parents);
 assert_eq!(create_family_with(|t|t.parent_slot[1]=0).unwrap_err(),parents);
 assert_eq!(create_family_with(|t|t.parent_root[0]=[0;32]).unwrap_err(),parents);
 assert_eq!(create_family_with(|t|t.parent_supply[1]=0).unwrap_err(),parents);
 assert_eq!(create_family_with(|t|t.parent_eligible[0]=0).unwrap_err(),parents);
 assert_eq!(create_family_with(|t|t.parent_eligible[0]=t.parent_supply[0]+1).unwrap_err(),parents);
 assert_eq!(create_family_with(|t|t.split_policy=SPLIT_POLICY_STANDARD).unwrap_err(),err(E_POLICY_TABLE));
 assert_eq!(create_family_with(|t|t.fee_weights=FEE_WEIGHTS_STANDARD).unwrap_err(),err(E_POLICY_TABLE));
 let mut w=World::family();w.seal().unwrap();let s=w.campaign().terms.split().unwrap();
 assert_eq!((s.participants,s.liquidity,s.parent_a,s.parent_b,s.dev),(435_000_000_000_000,435_000_000_000_000,50_000_000_000_000,50_000_000_000_000,30_000_000_000_000));
}
#[test]fn create_refuses_family_and_a_distribution_program_after_every_other_rule_and_writes_nothing(){
 let mut w=World::family();let keys=w.create_keys();let data=body(&w.terms);let before=w.bank.get(&w.campaign).clone();let creator_before=w.lamports(&w.creator);
 assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),err(E_FAMILY_NOT_AVAILABLE));
 assert_eq!(*w.bank.get(&w.campaign),before,"no campaign account was created");assert_eq!(w.lamports(&w.creator),creator_before,"no rent was paid");assert_eq!(cpi_count(),0);
 let mut wrong_pda=keys.clone();wrong_pda[1]=Pubkey::new_unique();assert_eq!(w.bank.call(&w.program,&wrong_pda,&data).unwrap_err(),ProgramError::InvalidSeeds,"the gate comes after every other rule");
 let mut d=World::standard();let distribution=d.bank.add(Acc::program(Pubkey::new_unique(),BPF_LOADER_UPGRADEABLE));d.terms.distribution_program=distribution;
 assert_eq!(d.create().unwrap_err(),err(E_DISTRIBUTION_NOT_WIRED));assert!(d.bank.get(&d.campaign).data.is_empty());assert_eq!(cpi_count(),0);
 d.terms.distribution_program=Pubkey::default();d.create().unwrap();
}
#[test]fn create_checks_the_parent_mint_accounts_the_amm_config_and_the_distribution_program(){
 let mut w=World::family();
 let keys=w.create_keys();let data=body(&w.terms);
 let mint_b=w.terms.parent_mint[1];let mint_a=w.terms.parent_mint[0];
 w.bank.get_mut(&mint_b).owner=TOKEN_PROGRAM;assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),err(E_PARENT_MINT),"the sealed token program must own the mint");
 w.bank.get_mut(&mint_b).owner=TOKEN_2022_PROGRAM;
 let good=w.bank.get(&mint_b).data.clone();
 w.bank.get_mut(&mint_b).data[166..168].copy_from_slice(&1u16.to_le_bytes());assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),err(E_PARENT_MINT_EXTENSION),"transfer fee extension");
 w.bank.get_mut(&mint_b).data=good;
 w.bank.get_mut(&mint_a).data[45]=0;assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),err(E_PARENT_MINT),"uninitialised mint");
 w.bank.get_mut(&mint_a).data[45]=1;
 let mut swapped=keys.clone();swapped.swap(4,5);assert_eq!(w.bank.call(&w.program,&swapped,&data).unwrap_err(),err(E_PARENT_MINT),"parents in the sealed order");
 let mut short=keys.clone();short.pop();assert_eq!(w.bank.call(&w.program,&short,&data).unwrap_err(),err(E_ACCOUNT_COUNT));
 let mut long=keys.clone();long.push(w.system);assert_eq!(w.bank.call(&w.program,&long,&data).unwrap_err(),err(E_ACCOUNT_COUNT));
 let config=w.terms.amm_config;let good_config=w.bank.get(&config).data.clone();
 w.bank.get_mut(&config).data[AMM_CONFIG_OFF_DISABLE]=1;assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),err(E_AMM_CONFIG),"disabled config");
 w.bank.get_mut(&config).data=amm_config_data(7,20_000,0,0);assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),err(E_AMM_CONFIG),"rate differs from the sealed rate");
 w.bank.get_mut(&config).data=amm_config_data(2,25_000,0,0);assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),err(E_AMM_CONFIG),"index differs");
 w.bank.get_mut(&config).data=amm_config_data(7,25_000,0,10_000);assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),err(E_FAMILY_NOT_AVAILABLE),"the config's creator fee rate is no rule: every account check passed and only the Family gate refused");
 w.bank.get_mut(&config).data=good_config.clone();put64(&mut w.bank.get_mut(&config).data,AMM_CONFIG_OFF_FUND_FEE_RATE,50_000);assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),err(E_AMM_CONFIG));
 w.bank.get_mut(&config).data=good_config[..200].to_vec();assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),err(E_AMM_CONFIG));
 w.bank.get_mut(&config).data=good_config.clone();w.bank.get_mut(&config).owner=Pubkey::new_unique();assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),err(E_AMM_CONFIG),"config not owned by the sealed AMM program");
 w.bank.get_mut(&config).owner=RAYDIUM_CPMM;
 let creator=w.creator;w.bank.get_mut(&creator).signer=false;assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),ProgramError::MissingRequiredSignature);
 w.bank.get_mut(&creator).signer=true;
 let mut wrong_pda=keys.clone();wrong_pda[1]=Pubkey::new_unique();assert_eq!(w.bank.call(&w.program,&wrong_pda,&data).unwrap_err(),ProgramError::InvalidSeeds);
 for at in [OFF_BUYBACK_MAX_SLIPPAGE_BPS+2,OFF_PARENT_REFERENCE_CONFIG+2]{let mut padded=data.clone();padded[1+at-SEALED_START]=1;assert_eq!(w.bank.call(&w.program,&keys,&padded).unwrap_err(),err(E_TERMS_INVALID),"padding byte {at} must be zero");}
 assert_eq!(w.bank.call(&w.program,&keys,&data[..data.len()-1]).unwrap_err(),err(E_TERMS_INVALID),"short body");
 assert_eq!(cpi_count(),0,"no refused creation reached a CPI");
 assert_eq!(w.bank.call(&w.program,&keys,&data).unwrap_err(),err(E_FAMILY_NOT_AVAILABLE),"every account check passed; Family is refused at the gate");
 let mut d=World::standard();let distribution=Pubkey::new_unique();d.terms.distribution_program=distribution;
 d.bank.add(Acc::program(distribution,BPF_LOADER_UPGRADEABLE));let keys=d.create_keys();let data=body(&d.terms);assert_eq!(keys.len(),5);
 d.bank.get_mut(&distribution).executable=false;assert_eq!(d.bank.call(&d.program,&keys,&data).unwrap_err(),err(E_DISTRIBUTION_PROGRAM_INVALID));
 d.bank.get_mut(&distribution).executable=true;d.bank.get_mut(&distribution).owner=Pubkey::new_unique();assert_eq!(d.bank.call(&d.program,&keys,&data).unwrap_err(),err(E_DISTRIBUTION_PROGRAM_INVALID));
 d.bank.get_mut(&distribution).owner=BPF_LOADER_UPGRADEABLE;
 let mut other=keys.clone();other[4]=d.bank.add(Acc::program(Pubkey::new_unique(),BPF_LOADER_UPGRADEABLE));assert_eq!(d.bank.call(&d.program,&other,&data).unwrap_err(),err(E_DISTRIBUTION_PROGRAM_INVALID),"the account must be the sealed program");
 let mut itself=World::standard();itself.terms.distribution_program=itself.program;let own=itself.program;itself.bank.add(Acc::program(own,BPF_LOADER_UPGRADEABLE));
 assert_eq!(itself.create().unwrap_err(),err(E_DISTRIBUTION_PROGRAM_INVALID),"a program cannot be its own distribution");
 assert_eq!(d.bank.call(&d.program,&keys,&data).unwrap_err(),err(E_DISTRIBUTION_NOT_WIRED),"a valid distribution program is refused at the gate");assert!(d.bank.get(&d.campaign).data.is_empty());
}
#[test]fn commit_is_open_exactly_between_opens_at_and_the_deadline_by_the_chain_clock(){
 let mut w=World::created();let owner=w.wallet(10*SOL);
 set_now(w.terms.opens_at-1);assert_eq!(w.commit(&owner,SOL,0).unwrap_err(),err(E_FUNDING_NOT_OPEN_YET));
 assert!(w.bank.get(&w.receipt_key(&owner)).data.is_empty(),"no receipt before opening");assert_eq!(w.campaign().state.total,0);
 set_now(w.terms.opens_at);w.commit(&owner,SOL,0).unwrap();assert_eq!(w.campaign().state.total,SOL);
 set_now(w.terms.deadline-1);w.commit(&owner,SOL,1).unwrap();assert_eq!(w.campaign().state.total,2*SOL);
 set_now(w.terms.deadline);assert_eq!(w.commit(&owner,SOL,2).unwrap_err(),err(E_FUNDING_CLOSED));
 set_now(w.terms.deadline+1);assert_eq!(w.commit(&owner,SOL,2).unwrap_err(),err(E_FUNDING_CLOSED));
 assert_eq!(w.campaign().state.total,2*SOL);assert_eq!(w.receipt(&owner).committed,2*SOL);assert_eq!(w.receipt(&owner).sequence,2);
 set_now(w.terms.deadline);w.finalize().unwrap();set_now(w.terms.deadline-1);
 assert_eq!(w.commit(&owner,SOL,2).unwrap_err(),err(E_FUNDING_CLOSED),"phase 1 refuses commits whatever the clock says");
}
#[test]fn commit_creates_the_receipt_at_the_wallets_expense_and_moves_exactly_the_amount(){
 let mut w=World::created();set_now(w.terms.opens_at);let owner=w.wallet(10*SOL);let other=w.wallet(10*SOL);
 let before=(w.lamports(&owner),w.lamports(&w.campaign));
 w.commit(&owner,3*SOL,0).unwrap();
 let receipt=w.bank.get(&w.receipt_key(&owner));assert_eq!(receipt.owner,w.program);assert_eq!(receipt.lamports,receipt_rent());
 assert_eq!(before.0-w.lamports(&owner),3*SOL+receipt_rent(),"the wallet pays the amount and its own receipt rent");
 assert_eq!(w.lamports(&w.campaign)-before.1,3*SOL,"the campaign receives exactly the amount");
 let r=w.receipt(&owner);assert_eq!((r.owner,r.campaign,r.committed,r.sequence,r.refunded,r.accepted,r.settled,r.claimed),(owner,w.campaign,3*SOL,1,0,0,false,false));
 let c=w.campaign();assert_eq!((c.state.total,c.state.receipt_count),(3*SOL,1));
 w.commit(&owner,2*SOL,1).unwrap();assert_eq!(w.receipt(&owner).committed,5*SOL);assert_eq!(w.campaign().state.receipt_count,1,"a second commit reuses the receipt");
 w.commit(&other,SOL,0).unwrap();assert_eq!(w.campaign().state.receipt_count,2);assert_eq!(w.campaign().state.total,6*SOL);
 assert_eq!(w.commit(&owner,SOL,1).unwrap_err(),err(E_RECEIPT_SEQUENCE),"a replayed sequence is refused");
 assert_eq!(w.commit(&owner,SOL,3).unwrap_err(),err(E_RECEIPT_SEQUENCE));
 assert_eq!(w.commit(&owner,0,2).unwrap_err(),err(E_ZERO_AMOUNT));
 let mut wrong_genesis=w.commit_body(SOL,2);wrong_genesis[1]^=1;let keys=[owner,w.campaign,w.receipt_key(&owner),w.system];assert_eq!(w.bank.call(&w.program,&keys,&wrong_genesis).unwrap_err(),err(E_NETWORK_MISMATCH));
 assert_eq!(w.bank.call(&w.program,&keys,&w.commit_body(SOL,2)[..40]).unwrap_err(),err(E_TERMS_INVALID));
 let others_receipt=[owner,w.campaign,w.receipt_key(&other),w.system];assert_eq!(w.bank.call(&w.program,&others_receipt,&w.commit_body(SOL,2)).unwrap_err(),ProgramError::InvalidSeeds,"another wallet's receipt");
 w.bank.get_mut(&owner).signer=false;assert_eq!(w.commit(&owner,SOL,2).unwrap_err(),ProgramError::MissingRequiredSignature);w.bank.get_mut(&owner).signer=true;
 assert_eq!(w.campaign().state.total,6*SOL);assert_eq!(w.receipt(&owner).sequence,2);
}
#[test]fn commit_into_another_programs_or_another_campaigns_accounts_is_refused(){
 let mut w=World::created();set_now(w.terms.opens_at);let owner=w.wallet(10*SOL);let cpis_after_create=cpi_count();
 let foreign=w.bank.add(Acc::new(Pubkey::new_unique(),Pubkey::new_unique(),w.bank.get(&w.campaign).data.clone()));
 let keys=[owner,foreign,w.receipt_key(&owner),w.system];assert_eq!(w.bank.call(&w.program,&keys,&w.commit_body(SOL,0)).unwrap_err(),ProgramError::IncorrectProgramId,"campaign owned by another program");
 let copy=w.bank.add(Acc::new(Pubkey::new_unique(),w.program,w.bank.get(&w.campaign).data.clone()));
 let keys=[owner,copy,w.receipt_key(&owner),w.system];assert_eq!(w.bank.call(&w.program,&keys,&w.commit_body(SOL,0)).unwrap_err(),ProgramError::InvalidSeeds,"campaign data at the wrong address");
 let keys=[owner,w.campaign,w.receipt_key(&owner),w.terms.amm_config];assert_eq!(w.bank.call(&w.program,&keys,&w.commit_body(SOL,0)).unwrap_err(),ProgramError::IncorrectProgramId,"not the System program");
 assert_eq!(w.campaign().state.total,0);assert_eq!(cpi_count(),cpis_after_create,"no refused commit reached a CPI");
}
#[test]fn the_hard_cap_never_closes_funding(){
 let mut w=World::created();set_now(w.terms.opens_at);
 let a=w.wallet(500*SOL);let b=w.wallet(500*SOL);
 w.commit(&a,100*SOL,0).unwrap();assert_eq!(w.campaign().state.total,w.terms.hard);
 w.commit(&b,300*SOL,0).unwrap();assert_eq!(w.campaign().state.total,400*SOL,"commits above the hard cap are accepted and settled pro rata");
 w.commit(&a,1,1).unwrap();assert_eq!(w.campaign().state.phase,PHASE_FUNDING);
}
/// Conservation of a closed campaign. Funded: committed = accepted + refunded for every receipt and the campaign
/// keeps rent plus the accepted total. Failed: every receipt got its whole commitment back, whatever its
/// settlement said, and the campaign keeps only its rent.
fn check_conservation(w:&World,wallets:&[Pubkey],failed:bool){
 let c=w.campaign();let mut accepted_sum=0u64;let mut refunded_sum=0u64;let mut committed_sum=0u64;
 for owner in wallets{let r=w.receipt(owner);if failed{assert_eq!(r.refunded,r.committed,"receipt {owner}: everything back after a failure");}else{assert_eq!(r.committed,r.accepted+r.refunded,"receipt {owner}: committed = accepted + refunded");}accepted_sum+=r.accepted;refunded_sum+=r.refunded;committed_sum+=r.committed;}
 assert_eq!(c.state.total,committed_sum);assert_eq!(c.state.refunded,refunded_sum);
 assert_eq!(w.lamports(&w.campaign),campaign_rent()+committed_sum-refunded_sum,"the campaign holds rent plus what is not refunded");
 if !failed{assert_eq!(c.state.settled_accepted,accepted_sum);assert!(accepted_sum<=c.terms.hard.min(c.state.total));assert_eq!(w.lamports(&w.campaign),campaign_rent()+accepted_sum);}
}
#[test]fn oversubscribed_campaign_settles_pro_rata_and_refunds_exactly_the_excess(){
 let(mut w,wallets)=World::settled();let c=w.campaign();
 assert_eq!(c.state.total,180*SOL);assert_eq!(c.state.phase,PHASE_CLOSED);assert_eq!(c.state.settled_count,3);
 let expected:[u64;3]=[accepted(40*SOL,180*SOL,100*SOL),accepted(60*SOL,180*SOL,100*SOL),accepted(80*SOL,180*SOL,100*SOL)];
 assert_eq!(expected,[22_222_222_222,33_333_333_333,44_444_444_444]);
 for(i,owner)in wallets.iter().enumerate(){assert_eq!(w.receipt(owner).accepted,expected[i]);}
 assert_eq!(c.state.settled_accepted,expected.iter().sum::<u64>());assert!(c.state.settled_accepted<c.terms.hard,"integer rounding leaves the accepted total below the hard cap, never forced up");
 w.assert_ready().unwrap();
 for owner in &wallets{let before=w.lamports(owner);w.refund(owner).unwrap();let r=w.receipt(owner);assert_eq!(w.lamports(owner)-before,r.committed-r.accepted);w.refund(owner).unwrap();assert_eq!(w.lamports(owner)-before,r.committed-r.accepted,"a second refund pays nothing");}
 check_conservation(&w,&wallets,false);
 assert_eq!(w.campaign().state.phase,PHASE_CLOSED);w.assert_ready().unwrap();
 let settled_before=w.campaign().state.settled_accepted;for owner in &wallets{w.settle(owner).unwrap();}assert_eq!(w.campaign().state.settled_accepted,settled_before,"settle is idempotent");assert_eq!(w.campaign().state.settled_count,3);
}
#[test]fn settlement_and_refund_wait_for_the_deadline_and_bind_the_destination(){
 let mut w=World::created();set_now(w.terms.opens_at);let owner=w.wallet(200*SOL);let other=w.wallet(200*SOL);w.commit(&owner,60*SOL,0).unwrap();w.commit(&other,60*SOL,0).unwrap();
 set_now(w.terms.deadline-1);
 assert_eq!(w.settle(&owner).unwrap_err(),err(E_BEFORE_DEADLINE));assert_eq!(w.refund(&owner).unwrap_err(),err(E_BEFORE_DEADLINE));assert_eq!(w.finalize().unwrap_err(),err(E_BEFORE_DEADLINE));assert_eq!(w.assert_ready().unwrap_err(),err(E_NOT_READY));
 set_now(w.terms.deadline);
 let keys=[w.campaign,w.receipt_key(&owner),other];assert_eq!(w.bank.call(&w.program,&keys,&[TAG_REFUND]).unwrap_err(),err(E_REFUND_DESTINATION),"refund goes to the receipt owner only");
 let keys=[w.campaign,w.receipt_key(&owner),w.campaign];assert_eq!(w.bank.call(&w.program,&keys,&[TAG_REFUND]).unwrap_err(),err(E_REFUND_DESTINATION));
 let keys=[w.campaign,w.receipt_key(&owner),w.receipt_key(&owner)];assert_eq!(w.bank.call(&w.program,&keys,&[TAG_REFUND]).unwrap_err(),err(E_REFUND_DESTINATION));
 let foreign_receipt=w.bank.add(Acc::new(Pubkey::new_unique(),w.program,w.bank.get(&w.receipt_key(&owner)).data.clone()));
 let keys=[w.campaign,foreign_receipt,owner];assert_eq!(w.bank.call(&w.program,&keys,&[TAG_REFUND]).unwrap_err(),ProgramError::InvalidSeeds,"receipt data at another address");
 let keys=[w.campaign,foreign_receipt];assert_eq!(w.bank.call(&w.program,&keys,&[TAG_SETTLE]).unwrap_err(),ProgramError::InvalidSeeds);
 assert_eq!(w.assert_ready().unwrap_err(),err(E_NOT_READY),"nothing settled yet");
 w.settle(&owner).unwrap();assert_eq!(w.assert_ready().unwrap_err(),err(E_NOT_READY),"one of two settled");
 w.settle(&other).unwrap();w.assert_ready().unwrap();
 let before=w.lamports(&owner);w.refund(&owner).unwrap();assert_eq!(w.lamports(&owner)-before,10*SOL,"120 committed against a 100 cap: 10 excess each");
 assert_eq!(w.receipt(&owner).refunded,10*SOL);
 let c=w.campaign();assert_eq!(c.state.phase,PHASE_CLOSED);assert_eq!(c.state.refunded,10*SOL);
}
#[test]fn a_campaign_below_the_soft_cap_refunds_everything_and_can_never_launch(){
 let mut w=World::created();set_now(w.terms.opens_at);let wallets:Vec<Pubkey>=(0..2).map(|_|w.wallet(100*SOL)).collect();
 w.commit(&wallets[0],30*SOL,0).unwrap();w.commit(&wallets[1],19*SOL+999_999_999,0).unwrap();
 set_now(w.terms.deadline);w.finalize().unwrap();assert_eq!(w.campaign().state.phase,PHASE_REFUND_ONLY);
 for owner in &wallets{w.settle(owner).unwrap();}
 assert_eq!(w.assert_ready().unwrap_err(),err(E_NOT_READY));
 assert_eq!(w.launch().unwrap_err(),err(E_NOT_READY));
 for owner in &wallets{let before=w.lamports(owner);w.refund(owner).unwrap();assert_eq!(w.lamports(owner)-before,w.receipt(owner).committed);w.refund(owner).unwrap();assert_eq!(w.lamports(owner)-before,w.receipt(owner).committed);}
 check_conservation(&w,&wallets,true);
 assert_eq!(w.lamports(&w.campaign),campaign_rent(),"only the rent stays");
 set_now(w.terms.launch_deadline+1);assert_eq!(w.launch().unwrap_err(),err(E_NOT_READY));assert_eq!(w.campaign().state.phase,PHASE_REFUND_ONLY);
}
#[test]fn exactly_the_soft_cap_is_enough_and_one_lamport_less_is_not(){
 for(short,expect_ready)in[(1u64,false),(0,true)]{
  let mut w=World::created();set_now(w.terms.opens_at);let owner=w.wallet(100*SOL);w.commit(&owner,w.terms.soft-short,0).unwrap();
  set_now(w.terms.deadline);w.finalize().unwrap();w.settle(&owner).unwrap();
  assert_eq!(w.assert_ready().is_ok(),expect_ready,"short by {short}");
  assert_eq!(w.campaign().state.phase,if expect_ready{PHASE_CLOSED}else{PHASE_REFUND_ONLY});
  let before=w.lamports(&owner);w.refund(&owner).unwrap();assert_eq!(w.lamports(&owner)-before,if expect_ready{0}else{w.terms.soft-short});
 }
}
#[test]fn exactly_the_hard_cap_accepts_everything_and_one_lamport_more_is_pro_rated(){
 for(over,expected)in[(0u64,[50*SOL,50*SOL]),(1,[accepted(50*SOL,100*SOL+1,100*SOL),accepted(50*SOL+1,100*SOL+1,100*SOL)])]{
  let mut w=World::created();set_now(w.terms.opens_at);let a=w.wallet(100*SOL);let b=w.wallet(100*SOL);w.commit(&a,50*SOL,0).unwrap();w.commit(&b,50*SOL+over,0).unwrap();
  set_now(w.terms.deadline);w.finalize().unwrap();w.settle(&a).unwrap();w.settle(&b).unwrap();
  assert_eq!([w.receipt(&a).accepted,w.receipt(&b).accepted],expected,"over by {over}");
  assert!(w.campaign().state.settled_accepted<=w.terms.hard);w.assert_ready().unwrap();
  w.refund(&a).unwrap();w.refund(&b).unwrap();check_conservation(&w,&[a,b],false);
  if over==1{assert_eq!(expected,[49_999_999_999,50_000_000_000]);assert_eq!(w.receipt(&a).refunded+w.receipt(&b).refunded,2,"the excess lamport and the rounding lamport are both refunded, never kept");}
 }
}
#[test]fn tiny_receipts_that_round_to_nothing_leave_the_campaign_unlaunchable_and_fully_refundable(){
 let mut w=World::standard();w.terms.soft=10;w.terms.hard=20;w.create().unwrap();
 set_now(w.terms.opens_at);let wallets:Vec<Pubkey>=(0..30).map(|_|w.wallet(SOL)).collect();for owner in &wallets{w.commit(owner,1,0).unwrap();}
 set_now(w.terms.deadline);w.finalize().unwrap();assert_eq!(w.campaign().state.phase,PHASE_CLOSED,"30 lamports is above the soft cap of 10");
 for owner in &wallets{w.settle(owner).unwrap();assert_eq!(w.receipt(owner).accepted,0,"floor(1 × 20 / 30) = 0");}
 assert_eq!(w.campaign().state.settled_accepted,0);assert_eq!(w.assert_ready().unwrap_err(),err(E_NOT_READY),"accepted total below the soft cap after rounding");
 for owner in &wallets{let before=w.lamports(owner);w.refund(owner).unwrap();assert_eq!(w.lamports(owner)-before,1,"the excess is the whole lamport");}
 check_conservation(&w,&wallets,false);
 set_now(w.terms.launch_deadline);w.finalize().unwrap();assert_eq!(w.campaign().state.phase,PHASE_REFUND_ONLY);check_conservation(&w,&wallets,true);
}
#[test]fn extreme_commitments_settle_without_overflow(){
 let mut w=World::standard();w.terms.soft=1<<62;w.terms.hard=(1<<63)-1;w.create().unwrap();
 set_now(w.terms.opens_at);let a=w.wallet(u64::MAX/2);let b=w.wallet(u64::MAX/2);
 w.commit(&a,1<<62,0).unwrap();w.commit(&b,(1<<62)+12345,0).unwrap();assert_eq!(w.campaign().state.total,(1<<63)+12345);
 set_now(w.terms.deadline);w.finalize().unwrap();w.settle(&a).unwrap();w.settle(&b).unwrap();
 let c=w.campaign();assert!(c.state.settled_accepted<=c.terms.hard);assert!(c.state.settled_accepted>=c.terms.soft);w.assert_ready().unwrap();
 w.refund(&a).unwrap();w.refund(&b).unwrap();check_conservation(&w,&[a,b],false);
 assert_eq!(w.receipt(&a).accepted,accepted(1<<62,(1<<63)+12345,(1<<63)-1));
}
#[test]fn wallet_splitting_is_neutral_up_to_integer_dust(){
 let mut whole=World::created();set_now(whole.terms.opens_at);let big=whole.wallet(500*SOL);let filler=whole.wallet(500*SOL);whole.commit(&big,90*SOL+7,0).unwrap();whole.commit(&filler,210*SOL,0).unwrap();
 let mut halves=World::created();set_now(halves.terms.opens_at);let h1=halves.wallet(500*SOL);let h2=halves.wallet(500*SOL);let filler2=halves.wallet(500*SOL);halves.commit(&h1,45*SOL+3,0).unwrap();halves.commit(&h2,45*SOL+4,0).unwrap();halves.commit(&filler2,210*SOL,0).unwrap();
 for w in [&mut whole,&mut halves]{set_now(w.terms.deadline);w.finalize().unwrap();}
 whole.settle(&big).unwrap();whole.settle(&filler).unwrap();halves.settle(&h1).unwrap();halves.settle(&h2).unwrap();halves.settle(&filler2).unwrap();
 let together=halves.receipt(&h1).accepted+halves.receipt(&h2).accepted;let alone=whole.receipt(&big).accepted;
 assert!(alone>=together&&alone-together<=1,"one wallet {alone}, two wallets {together}");
}
#[test]fn refund_versus_launch_race_at_the_launch_deadline(){
 let(mut w,wallets)=World::settled();w.launch_keys();
 set_now(w.terms.launch_deadline-1);
 let before=w.lamports(&wallets[0]);w.refund(&wallets[0]).unwrap();let r=w.receipt(&wallets[0]);assert_eq!(w.lamports(&wallets[0])-before,r.committed-r.accepted,"before the deadline a refund pays only the excess");
 assert_eq!(w.campaign().state.phase,PHASE_CLOSED);
 w.launch().unwrap();assert_eq!(w.campaign().state.phase,PHASE_LIVE,"one second before the launch deadline every rule passes; an excess refund does not block the launch");
 set_now(w.terms.launch_deadline+5);
 let mut refunded=0;for owner in &wallets{w.refund(owner).unwrap();let r=w.receipt(owner);assert_eq!(r.refunded,r.committed-r.accepted,"after the launch only the excess is ever refundable");refunded+=r.refunded;}
 let c=w.campaign();assert_eq!(c.state.refunded,refunded);assert_eq!(refunded,c.state.total-c.state.settled_accepted);
 assert_eq!(w.lamports(&w.campaign),campaign_rent(),"the accepted total went to the pool, the excess back to the wallets, the rent stays");
 let(mut late,late_wallets)=World::settled();late.launch_keys();set_now(late.terms.launch_deadline);
 assert_eq!(late.launch().unwrap_err(),err(E_NOT_READY),"at the launch deadline the launch is refused");
 let before=late.lamports(&late_wallets[1]);late.refund(&late_wallets[1]).unwrap();assert_eq!(late.lamports(&late_wallets[1])-before,late.receipt(&late_wallets[1]).committed,"and the refund is the whole commitment");
 assert_eq!(late.campaign().state.phase,PHASE_REFUND_ONLY);
 set_now(late.terms.launch_deadline-1);assert_eq!(late.launch().unwrap_err(),err(E_NOT_READY),"once a refund recorded the failure, no earlier clock reading can launch");
 assert_eq!(late.assert_ready().unwrap_err(),err(E_NOT_READY));
 set_now(late.terms.launch_deadline);for owner in &late_wallets{late.refund(owner).unwrap();}check_conservation(&late,&late_wallets,true);
 assert_eq!(late.lamports(&late.campaign),campaign_rent());
}
#[test]fn standard_launch_creates_the_pool_locks_every_lp_token_revokes_the_mint_and_writes_the_campaign_last(){
 let(mut w,wallets)=World::settled();let keys=w.launch_keys();let c_before=w.campaign();let split=w.terms.split().unwrap();
 let(pool,lp_mint,vault0,vault1,_,m0,_)=w.pool_keys();let authority=w.authority();let keeper=keys[1];let nft=keys[6];
 let keeper_before=w.lamports(&keeper);let budget_before=w.lamports(&authority);clear_cpis();
 w.launch().unwrap();
 let c=w.campaign();assert_eq!(c.state.phase,PHASE_LIVE);assert_eq!(c.state.launch_time,w.terms.deadline);assert_eq!(c.state.pool,pool);assert_eq!(c.state.fee_nft,nft);
 assert_eq!(c.terms,c_before.terms);assert_eq!((c.state.total,c.state.refunded,c.state.settled_accepted,c.state.settled_count),(c_before.state.total,0,c_before.state.settled_accepted,3));
 let accepted=c.state.settled_accepted;assert_eq!(accepted,99_999_999_999);
 assert_eq!(w.balance(&w.custody()),SUPPLY-split.liquidity,"participants and dev reserves stay in custody");assert_eq!(SUPPLY-split.liquidity,split.participants+split.dev);
 let(child_vault,sol_vault)=if m0==w.terms.child_mint{(vault0,vault1)}else{(vault1,vault0)};
 assert_eq!(w.balance(&child_vault),split.liquidity,"the liquidity reserve is in the pool");assert_eq!(w.balance(&sol_vault),accepted,"the accepted SOL is in the pool");
 assert_eq!(w.balance(&w.wsol_custody()),0);
 assert_eq!(w.lamports(&w.campaign),campaign_rent()+c.state.total-accepted,"the campaign keeps rent plus the refund liability");
 let mint=w.bank.get(&w.terms.child_mint);assert_eq!(mint.data[..4],[0;4],"mint authority revoked");assert_eq!(mint.data[46..50],[0;4],"no freeze authority");assert_eq!(read64(&mint.data,36).unwrap(),SUPPLY);
 let lp_amount=(isqrt(split.liquidity as u128*accepted as u128) as u64)-CPMM_INITIAL_LOCKED_LP;
 assert_eq!(w.balance(&ata_key(&authority,&lp_mint)),0,"the launch authority keeps no LP");
 assert_eq!(w.balance(&ata_key(&w.lock_authority(),&lp_mint)),lp_amount,"every LP token is in the lock vault");
 let locked=w.bank.get(&Pubkey::find_program_address(&[LOCKED_LIQUIDITY_SEED,nft.as_ref()],&RAYDIUM_LOCK).0);
 assert_eq!(locked.owner,RAYDIUM_LOCK);assert_eq!(read64(&locked.data,LOCKED_OFF_LP_AMOUNT).unwrap(),lp_amount);assert_eq!(read_key(&locked.data,LOCKED_OFF_OWNER).unwrap(),authority);assert_eq!(read_key(&locked.data,LOCKED_OFF_POOL).unwrap(),pool);
 assert_eq!(w.balance(&ata_key(&w.campaign,&nft)),1,"the campaign PDA holds the fee NFT");
 let nft_mint=w.bank.get(&nft);assert_eq!(nft_mint.owner,TOKEN_PROGRAM);assert_eq!(read64(&nft_mint.data,36).unwrap(),1);assert_eq!(nft_mint.data[44],0);assert_eq!(nft_mint.data[..4],[0;4]);
 let p=w.bank.get(&pool);assert_eq!(p.owner,RAYDIUM_CPMM);assert_eq!(read_key(&p.data,40).unwrap(),authority,"the launch authority is the pool creator");assert_eq!(read_key(&p.data,8).unwrap(),w.terms.amm_config);assert_eq!(read64(&p.data,POOL_OFF_LP_SUPPLY).unwrap(),lp_amount+CPMM_INITIAL_LOCKED_LP);
 assert!(w.lamports(&authority)<budget_before-CREATE_POOL_FEE&&w.lamports(&authority)>0,"the sponsored budget paid the create-pool fee and the pool rents");
 assert!(w.lamports(&keeper)<keeper_before&&keeper_before-w.lamports(&keeper)<SOL/10,"the keeper paid the lock rents only");
 assert_eq!(w.lamports(&CPMM_CREATE_POOL_FEE_RECEIVER),CREATE_POOL_FEE);
 let programs:Vec<Pubkey>=CPI_LOG.with(|l|l.borrow().iter().map(|(p,_)|*p).collect());
 assert_eq!(programs,vec![TOKEN_PROGRAM,system_program::id(),TOKEN_PROGRAM,RAYDIUM_CPMM,RAYDIUM_LOCK,TOKEN_PROGRAM],"sync, wrap, sync, pool, lock, revoke the mint authority (no freeze authority was set)");
 assert_eq!(w.launch().unwrap_err(),err(E_NOT_READY),"a live campaign cannot launch again");
 assert_eq!(w.assert_ready().unwrap_err(),err(E_NOT_READY));
 let owner=wallets[0];let ata=w.holder_ata(&owner);w.claim_participant(&owner).unwrap();
 assert_eq!(w.balance(&ata),participant_tokens(split.participants,w.receipt(&owner).accepted,accepted).unwrap(),"claims pay from the real launch custody");
}
#[test]fn family_launch_keeps_both_parent_reserves_in_custody_and_pools_the_liquidity_reserve(){
 let(mut w,_)=World::settled_with(family_terms,NOW);let split=w.terms.split().unwrap();
 assert_eq!((split.parent_a,split.parent_b),(50_000_000_000_000,50_000_000_000_000));
 w.launch().unwrap();
 let(_,_,vault0,vault1,_,m0,_)=w.pool_keys();let child_vault=if m0==w.terms.child_mint{vault0}else{vault1};
 assert_eq!(w.balance(&child_vault),split.liquidity);
 assert_eq!(w.balance(&w.custody()),split.participants+split.parent_a+split.parent_b+split.dev,"participants, both parents and dev stay in custody");
 assert_eq!(w.balance(&w.custody())+w.balance(&child_vault),SUPPLY,"nothing is lost");
 let c=w.campaign();assert_eq!(c.state.phase,PHASE_LIVE);assert!(c.terms.is_family());assert_eq!(c.state.parent_claimed,[0,0]);
 set_now(c.state.launch_time);let dev_ata=w.holder_ata(&w.terms.dev.clone());w.claim_dev().unwrap();assert_eq!(w.balance(&dev_ata),SUPPLY/100);
}
#[test]fn a_launch_whose_authorities_were_revoked_at_creation_needs_no_revocation_and_a_donated_vault_is_tolerated(){
 let(mut w,_)=World::settled();let keys=w.launch_keys();let mint=keys[3];let authority=w.authority();
 w.bank.get_mut(&mint).data=mint_data(SUPPLY,6,None,None);
 let(_,_,vault0,vault1,_,m0,_)=w.pool_keys();let sol_vault=if m0==WSOL{vault0}else{vault1};
 w.bank.get_mut(&sol_vault).lamports=rent(165)+777;
 clear_cpis();w.launch().unwrap();
 let programs:Vec<Pubkey>=CPI_LOG.with(|l|l.borrow().iter().map(|(p,_)|*p).collect());
 assert_eq!(programs,vec![TOKEN_PROGRAM,system_program::id(),TOKEN_PROGRAM,RAYDIUM_CPMM,RAYDIUM_LOCK],"no SetAuthority when both authorities are already gone");
 assert_eq!(w.balance(&sol_vault),w.campaign().state.settled_accepted+777,"the donated lamports count as native liquidity and are expected in the read-back");
 assert_eq!(w.balance(&w.custody()),SUPPLY-w.terms.split().unwrap().liquidity);
 let mut frozen=World::settled().0;let keys=frozen.launch_keys();frozen.bank.get_mut(&keys[3]).data=mint_data(SUPPLY,6,Some(&frozen.authority()),Some(&frozen.authority()));
 let _=authority;clear_cpis();frozen.launch().unwrap();
 assert_eq!(cpi_count(),7,"both authorities revoked: two SetAuthority calls");
 let d=&frozen.bank.get(&keys[3]).data;assert_eq!(d[..4],[0;4]);assert_eq!(d[46..50],[0;4]);
}
#[test]fn launch_refuses_every_wrong_account_and_state_before_any_cpi(){
 let(mut w,_)=World::settled();let keys=w.launch_keys();
 let snapshot=|w:&World|(w.bank.get(&w.campaign).clone(),w.bank.get(&keys[1]).clone(),w.bank.get(&keys[3]).clone(),w.bank.get(&keys[4]).clone());
 let before=snapshot(&w);clear_cpis();
 assert_eq!(w.bank.call(&w.program,&keys,&[TAG_LAUNCH,0]).unwrap_err(),err(E_TERMS_INVALID),"no body");
 assert_eq!(w.bank.call(&w.program,&keys[..28],&[TAG_LAUNCH]).unwrap_err(),err(E_ACCOUNT_COUNT));
 let mut extra=keys.clone();extra.push(w.system);assert_eq!(w.bank.call(&w.program,&extra,&[TAG_LAUNCH]).unwrap_err(),err(E_ACCOUNT_COUNT));
 w.bank.get_mut(&keys[1]).signer=false;assert_eq!(w.launch().unwrap_err(),ProgramError::MissingRequiredSignature,"the keeper signs");w.bank.get_mut(&keys[1]).signer=true;
 w.bank.get_mut(&keys[6]).signer=false;assert_eq!(w.launch().unwrap_err(),ProgramError::MissingRequiredSignature,"the fee NFT mint signs");w.bank.get_mut(&keys[6]).signer=true;
 let mut wrong_authority=keys.clone();wrong_authority[2]=Pubkey::new_unique();assert_eq!(w.launch_with(&wrong_authority).unwrap_err(),ProgramError::InvalidSeeds);
 let authority=keys[2];w.bank.get_mut(&authority).data=vec![1];assert_eq!(w.launch().unwrap_err(),err(E_LAUNCH_ACCOUNT),"the launch authority must be an untouched System address");w.bank.get_mut(&authority).data=vec![];
 let mint=keys[3];let good_mint=w.bank.get(&mint).data.clone();
 put64(&mut w.bank.get_mut(&mint).data,36,SUPPLY-1);assert_eq!(w.launch().unwrap_err(),err(E_CHILD_MINT),"supply differs from the sealed supply");
 w.bank.get_mut(&mint).data=good_mint.clone();w.bank.get_mut(&mint).data[44]=9;assert_eq!(w.launch().unwrap_err(),err(E_CHILD_MINT),"decimals differ");
 w.bank.get_mut(&mint).data=mint_data(SUPPLY,6,Some(&Pubkey::new_unique()),None);assert_eq!(w.launch().unwrap_err(),err(E_CHILD_MINT),"a foreign mint authority");
 w.bank.get_mut(&mint).data=mint_data(SUPPLY,6,None,Some(&Pubkey::new_unique()));assert_eq!(w.launch().unwrap_err(),err(E_CHILD_MINT),"a foreign freeze authority");
 w.bank.get_mut(&mint).owner=TOKEN_2022_PROGRAM;assert_eq!(w.launch().unwrap_err(),err(E_CHILD_MINT));w.bank.get_mut(&mint).owner=TOKEN_PROGRAM;
 let mut other_mint=keys.clone();other_mint[3]=w.bank.add(Acc::new(Pubkey::new_unique(),TOKEN_PROGRAM,good_mint.clone()));assert_eq!(w.launch_with(&other_mint).unwrap_err(),err(E_CHILD_MINT),"not the sealed mint");
 w.bank.get_mut(&mint).data=good_mint;
 let config=keys[16];let good_config=w.bank.get(&config).data.clone();
 w.bank.get_mut(&config).data=amm_config_data(7,25_000,1,0);assert_eq!(w.launch().unwrap_err(),err(E_AMM_CONFIG),"the config was disabled after creation");
 w.bank.get_mut(&config).data=amm_config_data(7,30_000,0,0);assert_eq!(w.launch().unwrap_err(),err(E_AMM_CONFIG),"the rate was changed after creation");
 w.bank.get_mut(&config).data=good_config;
 let mut other_config=keys.clone();other_config[16]=w.bank.add(Acc::new(AMM_CONFIG_TIERS[0].1,RAYDIUM_CPMM,amm_config_data(2,20_000,0,0)));assert_eq!(w.launch_with(&other_config).unwrap_err(),err(E_AMM_CONFIG),"another approved tier is still not the sealed config");
 let other_lock=w.bank.add(Acc::program(Pubkey::new_unique(),BPF_LOADER_UPGRADEABLE));
 let mut wrong_lock=keys.clone();wrong_lock[25]=other_lock;assert_eq!(w.launch_with(&wrong_lock).unwrap_err(),err(E_LAUNCH_ACCOUNT),"not the sealed lock program");
 let mut wrong_lock_authority=keys.clone();wrong_lock_authority[26]=Pubkey::find_program_address(&[LOCK_AUTH_SEED],&other_lock).0;assert_eq!(w.launch_with(&wrong_lock_authority).unwrap_err(),err(E_LAUNCH_ACCOUNT),"the lock authority is derived from the sealed lock program");
 let mut wrong_cpmm=keys.clone();wrong_cpmm[15]=other_lock;assert_eq!(w.launch_with(&wrong_cpmm).unwrap_err(),err(E_LAUNCH_ACCOUNT),"not the sealed AMM program");
 for(index,label)in[(4,"custody"),(5,"WSOL custody"),(7,"fee NFT account"),(8,"locked liquidity"),(9,"lock vault"),(10,"metadata"),(17,"AMM authority"),(18,"pool"),(19,"LP mint"),(20,"LP account"),(21,"vault 0"),(22,"vault 1"),(23,"fee receiver"),(24,"observation"),(27,"Metadata program"),(28,"WSOL mint")]{
  let mut wrong=keys.clone();wrong[index]=Pubkey::new_unique();assert_eq!(w.launch_with(&wrong).unwrap_err(),err(E_LAUNCH_ACCOUNT),"{label} substituted");
 }
 for index in [11,12,13,15,25,27]{w.bank.get_mut(&keys[index]).executable=false;assert_eq!(w.launch().unwrap_err(),err(E_LAUNCH_ACCOUNT),"account {index} must be executable");w.bank.get_mut(&keys[index]).executable=true;}
 let custody=keys[4];put64(&mut w.bank.get_mut(&custody).data,64,SUPPLY-1);assert_eq!(w.launch().unwrap_err(),err(E_LAUNCH_ACCOUNT),"custody must hold the whole supply");put64(&mut w.bank.get_mut(&custody).data,64,SUPPLY);
 w.bank.get_mut(&keys[6]).data=vec![0u8;82];assert_eq!(w.launch().unwrap_err(),err(E_LAUNCH_ACCOUNT),"the fee NFT mint must not exist yet");w.bank.get_mut(&keys[6]).data=vec![];
 w.bank.get_mut(&keys[18]).data=vec![1];assert_eq!(w.launch().unwrap_err(),err(E_LAUNCH_ACCOUNT),"the pool must not exist yet");w.bank.get_mut(&keys[18]).data=vec![];
 w.bank.get_mut(&keys[21]).data=vec![1];assert_eq!(w.launch().unwrap_err(),err(E_LAUNCH_ACCOUNT),"a vault must not exist yet");w.bank.get_mut(&keys[21]).data=vec![];
 assert_eq!(cpi_count(),0,"no refused launch reached a CPI");assert_eq!(snapshot(&w),before,"nothing changed");
 set_now(w.terms.deadline-1);assert_eq!(w.launch().unwrap_err(),err(E_NOT_READY),"before the funding deadline");set_now(w.terms.deadline);
 let mut c=w.campaign();c.state.settled_count=2;w.set_campaign(&c);assert_eq!(w.launch().unwrap_err(),err(E_NOT_READY),"a receipt not settled");
 c.state.settled_count=3;c.state.phase=PHASE_LIVE;w.set_campaign(&c);assert_eq!(w.launch().unwrap_err(),err(E_NOT_READY),"already live");
 c.state.phase=PHASE_CLOSED;w.set_campaign(&c);
 // Create refuses a sealed distribution program (error 90); tag 6 keeps the same refusal for a campaign sealed before that rule.
 let mut sealed=World::standard();let distribution=Pubkey::new_unique();sealed.terms.distribution_program=distribution;sealed.bank.add(Acc::program(distribution,BPF_LOADER_UPGRADEABLE));sealed.seal_by_hand();
 set_now(sealed.terms.opens_at);let owner=sealed.wallet(100*SOL);sealed.commit(&owner,60*SOL,0).unwrap();set_now(sealed.terms.deadline);sealed.settle(&owner).unwrap();sealed.assert_ready().unwrap();
 clear_cpis();assert_eq!(sealed.launch().unwrap_err(),err(E_DISTRIBUTION_NOT_WIRED),"a sealed distribution program has no activation path yet");assert_eq!(cpi_count(),0);
 set_now(sealed.terms.launch_deadline);let before=sealed.lamports(&owner);sealed.refund(&owner).unwrap();assert_eq!(sealed.lamports(&owner)-before,60*SOL,"and the commitment comes back after the launch deadline");
 set_now(w.terms.deadline);w.launch().unwrap();
}
/// A launch that fails after its CPIs writes nothing: the campaign bytes the failed call left behind are the bytes it
/// started with, and after the runtime's rollback every account is what it was.
fn assert_failed_launch_left_nothing(w:&mut World,expected:ProgramError){
 let keys=w.launch_keys();let watched=[w.campaign,keys[1],keys[3],keys[4],keys[5],keys[2]];
 let before:Vec<Acc>=watched.iter().map(|k|w.bank.get(k).clone()).collect();let campaign_bytes=w.bank.get(&w.campaign).data.clone();
 let cpis=cpi_count();
 assert_eq!(w.launch().unwrap_err(),expected);
 assert!(cpi_count()>cpis+3,"the failure came after the pool and lock CPIs");
 assert_eq!(w.bank.dirty(&w.campaign).data,campaign_bytes,"the campaign was never written by the failed launch");
 let after:Vec<Acc>=watched.iter().map(|k|w.bank.get(k).clone()).collect();assert_eq!(after,before,"campaign, keeper, mint, custody and launch authority are byte-identical after the rollback");
 for key in [w.pool_keys().0,keys[8],keys[6]]{assert!(w.bank.get(&key).data.is_empty(),"no pool, lock or fee NFT survives a failed launch");}
}
#[test]fn a_pool_that_holds_less_than_it_was_sent_fails_the_launch_and_leaves_no_trace(){
 let(mut w,_)=World::settled();w.launch_keys();
 set_fault(|f|f.skim_vault=true);assert_failed_launch_left_nothing(&mut w,err(E_LAUNCH_VERIFY));
 set_fault(|f|f.skim_vault=false);w.launch().unwrap();assert_eq!(w.campaign().state.phase,PHASE_LIVE,"the same accounts launch once the pool behaves");
}
#[test]fn the_mainnet_config_creator_fee_rate_is_accepted_and_the_pool_is_made_with_the_creator_fee_off(){
 let(mut w,_)=World::settled();let keys=w.launch_keys();let config=keys[16];
 assert_eq!(read64(&w.bank.get(&config).data,AMM_CONFIG_OFF_CREATOR_FEE_RATE).unwrap(),MAINNET_CREATOR_FEE_RATE,"the sealed config carries the mainnet creator fee rate, and create accepted it");
 put64(&mut w.bank.get_mut(&config).data,AMM_CONFIG_OFF_CREATOR_FEE_RATE,10_000);
 let split=w.terms.split().unwrap();let accepted=w.campaign().state.settled_accepted;
 clear_cpis();w.launch().unwrap();
 let sent:Vec<Vec<u8>>=CPI_LOG.with(|l|l.borrow().iter().filter(|(p,_)|*p==RAYDIUM_CPMM).map(|(_,d)|d.clone()).collect());
 let(m0,_)=if w.terms.child_mint<WSOL{(w.terms.child_mint,WSOL)}else{(WSOL,w.terms.child_mint)};
 let(amount0,amount1)=if m0==w.terms.child_mint{(split.liquidity,accepted)}else{(accepted,split.liquidity)};
 assert_eq!(sent,vec![cpmm_initialize_data(amount0,amount1,0)],"one plain initialize: discriminator, two amounts, open time 0, no creator_fee_on");
 assert_eq!(sent[0].len(),CPMM_INITIALIZE_LEN);
 let pool=w.bank.get(&w.pool_keys().0);assert_eq!(pool.data[POOL_OFF_ENABLE_CREATOR_FEE],0,"the pool's creator fee switch is off whatever the config's rate");
 assert_eq!(w.campaign().state.phase,PHASE_LIVE);
 let mut fresh=World::standard();fresh.bank.get_mut(&fresh.terms.amm_config.clone()).data=amm_config_data(TIER_7.0,TIER_7.2,0,10_000);fresh.create().unwrap();
}
#[test]fn a_pool_that_reads_back_with_the_creator_fee_on_fails_the_launch_and_leaves_no_trace(){
 let(mut w,_)=World::settled();w.launch_keys();
 set_fault(|f|f.creator_fee_pool=true);assert_failed_launch_left_nothing(&mut w,err(E_LAUNCH_VERIFY));
 set_fault(|f|f.creator_fee_pool=false);w.launch().unwrap();assert_eq!(w.bank.get(&w.pool_keys().0).data[POOL_OFF_ENABLE_CREATOR_FEE],0);
}
#[test]fn only_the_plain_cpmm_initialize_body_passes_the_pre_cpi_guard(){
 let discriminator=|name:&str|solana_program::hash::hash(format!("global:{name}").as_bytes()).to_bytes()[..8].to_vec();
 assert_eq!(CPMM_INITIALIZE.to_vec(),discriminator("initialize"));
 let plain=cpmm_initialize_data(1,2,0);assert_eq!(plain.len(),CPMM_INITIALIZE_LEN);assert!(cpmm_initialize_keeps_creator_fee_off(&plain));
 // initialize_with_permission: the same three u64 arguments, then creator_fee_on u8 (0 both, 1 token 0, 2 token 1).
 for creator_fee_on in 0u8..3{let mut with_permission=discriminator("initialize_with_permission");with_permission.extend_from_slice(&plain[8..]);with_permission.push(creator_fee_on);assert!(!cpmm_initialize_keeps_creator_fee_off(&with_permission),"creator_fee_on {creator_fee_on}");}
 let mut extra=plain.clone();extra.push(0);assert!(!cpmm_initialize_keeps_creator_fee_off(&extra),"an extra argument on the plain body");
 assert!(!cpmm_initialize_keeps_creator_fee_off(&plain[..31]));
 let mut other=plain.clone();other[0]^=1;assert!(!cpmm_initialize_keeps_creator_fee_off(&other));
}
#[test]fn a_mint_authority_that_survives_the_revocation_fails_the_launch_and_leaves_no_trace(){
 let(mut w,_)=World::settled();w.launch_keys();
 set_fault(|f|f.keep_mint_authority=true);assert_failed_launch_left_nothing(&mut w,err(E_LAUNCH_VERIFY));
 let mint=w.terms.child_mint;assert_eq!(w.bank.get(&mint).data[..4],[1,0,0,0],"the mint authority is still there after the rollback");
 set_fault(|f|f.keep_mint_authority=false);w.launch().unwrap();assert_eq!(w.bank.get(&mint).data[..4],[0;4]);
}
#[test]fn a_launch_without_the_sponsored_setup_budget_fails_inside_the_pool_creation_and_rolls_back(){
 let(mut w,_)=World::settled();let keys=w.launch_keys();
 w.bank.get_mut(&keys[2]).lamports=0;
 let campaign_before=w.bank.get(&w.campaign).clone();
 assert_eq!(w.launch().unwrap_err(),ProgramError::InsufficientFunds,"the CPMM program cannot take its fee");
 assert_eq!(w.bank.dirty(&w.campaign).data,campaign_before.data);assert_eq!(*w.bank.get(&w.campaign),campaign_before);
 w.bank.get_mut(&keys[2]).lamports=SOL;w.launch().unwrap();
}
#[test]fn a_campaign_short_of_its_accepted_total_plus_reserve_is_refused_before_any_cpi(){
 let(mut w,_)=World::settled();w.launch_keys();let campaign=w.campaign;
 let before=w.bank.get(&campaign).clone();
 w.bank.get_mut(&campaign).lamports=before.lamports-1;
 clear_cpis();assert_eq!(w.launch().unwrap_err(),err(E_LAUNCH_FUNDS));assert_eq!(cpi_count(),0,"the funds check runs before SyncNative");
 assert_eq!(w.bank.get(&campaign).data,before.data);
 w.bank.get_mut(&campaign).lamports=before.lamports;w.launch().unwrap();
}
#[test]fn finalize_records_success_failure_and_the_launch_timeout(){
 let(mut w,_)=World::settled();assert_eq!(w.campaign().state.phase,PHASE_CLOSED);
 w.finalize().unwrap();assert_eq!(w.campaign().state.phase,PHASE_CLOSED,"finalize is idempotent");
 set_now(w.terms.launch_deadline-1);w.finalize().unwrap();assert_eq!(w.campaign().state.phase,PHASE_CLOSED);
 set_now(w.terms.launch_deadline);w.finalize().unwrap();assert_eq!(w.campaign().state.phase,PHASE_REFUND_ONLY);
 assert_eq!(w.bank.call(&w.program,&[w.campaign],&[TAG_FINALIZE,1]).unwrap_err(),err(E_TERMS_INVALID));
 assert_eq!(w.bank.call(&w.program,&[w.campaign,w.system],&[TAG_FINALIZE]).unwrap_err(),err(E_ACCOUNT_COUNT));
 let mut live=World::created();set_now(live.terms.opens_at);let owner=live.wallet(100*SOL);live.commit(&owner,60*SOL,0).unwrap();set_now(live.terms.deadline);live.settle(&owner).unwrap();
 set_now(live.terms.deadline+10);live.launch().unwrap();assert_eq!(live.campaign().state.launch_time,live.terms.deadline+10);
 set_now(live.terms.launch_deadline+5);live.finalize().unwrap();assert_eq!(live.campaign().state.phase,PHASE_LIVE,"a live campaign never times out");
 let before=live.lamports(&owner);live.refund(&owner).unwrap();assert_eq!(live.lamports(&owner),before,"nothing to refund after a launch inside the cap");
}
#[test]fn participant_claims_pay_the_proportional_reserve_once_and_only_after_launch(){
 let(mut w,wallets)=World::settled();w.launch_keys();
 let owner=wallets[0];let ata=w.holder_ata(&owner);let custody=w.custody();
 assert_eq!(w.claim_participant(&owner).unwrap_err(),err(E_NOT_LAUNCHED),"settled but not launched");
 w.launch().unwrap();
 let split=w.terms.split().unwrap();let c=w.campaign();let r=w.receipt(&owner);
 let expected=participant_tokens(split.participants,r.accepted,c.state.settled_accepted).unwrap();
 assert_eq!(expected,(485_000_000_000_000u128*22_222_222_222/99_999_999_999) as u64);
 w.claim_participant(&owner).unwrap();
 assert_eq!(w.balance(&ata),expected);assert_eq!(w.balance(&custody),SUPPLY-split.liquidity-expected);
 let r=w.receipt(&owner);assert!(r.claimed);assert_eq!(r.claimed_tokens,expected);assert_eq!(w.campaign().state.participant_claimed,expected);
 let cpis=cpi_count();w.claim_participant(&owner).unwrap();assert_eq!(w.balance(&ata),expected,"a second claim pays nothing");assert_eq!(cpi_count(),cpis);
 let stranger_ata=w.holder_ata(&Pubkey::new_unique());
 let keys=[w.campaign,w.receipt_key(&owner),w.authority(),w.terms.child_mint,custody,stranger_ata,TOKEN_PROGRAM];w.bank.call(&w.program,&keys,&[TAG_CLAIM_PARTICIPANT]).unwrap();
 assert_eq!(w.balance(&stranger_ata),0,"a claimed receipt is a no-op whatever destination is passed");
 let mut total=expected;for other in &wallets[1..]{let other_ata=w.holder_ata(other);w.claim_participant(other).unwrap();total+=w.balance(&other_ata);}
 assert!(total<=split.participants&&split.participants-total<3,"every participant paid, dust below one unit per receipt stays in custody");assert_eq!(w.campaign().state.participant_claimed,total);
 let fresh=w.wallet(SOL);let fresh_ata=w.holder_ata(&fresh);let fresh_receipt=w.receipt_key(&fresh);
 let mut unsettled=Receipt::new(w.campaign,fresh,Receipt::address(&w.program,&w.campaign,&fresh).1);unsettled.committed=SOL;let mut d=vec![0u8;RECEIPT_LEN];unsettled.encode(&mut d);
 {let acc=w.bank.get_mut(&fresh_receipt);acc.data=d;acc.owner=w.program;}
 assert_eq!(w.claim_participant(&fresh).unwrap_err(),err(E_CLAIM_INVALID),"an unsettled receipt cannot claim");
 let keys=[w.campaign,w.receipt_key(&wallets[1]),w.authority(),w.terms.child_mint,custody,fresh_ata,TOKEN_PROGRAM];w.bank.call(&w.program,&keys,&[TAG_CLAIM_PARTICIPANT]).unwrap();assert_eq!(w.balance(&fresh_ata),0,"claimed already: a no-op, nothing to a substituted destination");
 let unsettled_keys=[w.campaign,fresh_receipt,w.authority(),w.terms.child_mint,custody,stranger_ata,TOKEN_PROGRAM];assert_eq!(w.bank.call(&w.program,&unsettled_keys,&[TAG_CLAIM_PARTICIPANT]).unwrap_err(),err(E_CLAIM_INVALID));
 let mut c=w.campaign();c.state.flags=FLAG_DISTRIBUTION_ACTIVATED;w.set_campaign(&c);
 assert_eq!(w.claim_participant(&fresh).unwrap_err(),err(E_DISTRIBUTION_ACTIVATED),"custody claims stop once the distribution program pays");
 assert_eq!(w.balance(&stranger_ata),0);assert_eq!(w.balance(&fresh_ata),0);
}
#[test]fn a_claimed_receipt_is_a_no_op_and_an_unrelated_destination_never_receives_tokens(){
 let(mut w,wallets)=World::live();let custody=w.custody();
 let owner=wallets[1];let ata=w.holder_ata(&owner);w.claim_participant(&owner).unwrap();let paid=w.balance(&ata);assert!(paid>0);
 let stranger_ata=w.holder_ata(&Pubkey::new_unique());
 let keys=[w.campaign,w.receipt_key(&owner),w.authority(),w.terms.child_mint,custody,stranger_ata,TOKEN_PROGRAM];w.bank.call(&w.program,&keys,&[TAG_CLAIM_PARTICIPANT]).unwrap();
 assert_eq!(w.balance(&stranger_ata),0);assert_eq!(w.balance(&ata),paid);
 let unclaimed=wallets[2];w.holder_ata(&unclaimed);
 let keys=[w.campaign,w.receipt_key(&unclaimed),w.authority(),w.terms.child_mint,custody,stranger_ata,TOKEN_PROGRAM];assert_eq!(w.bank.call(&w.program,&keys,&[TAG_CLAIM_PARTICIPANT]).unwrap_err(),err(E_CLAIM_INVALID),"an unclaimed receipt pays only its owner's associated token account");
 let keys=[w.campaign,w.receipt_key(&unclaimed),w.authority(),w.terms.child_mint,ata,ata_key(&unclaimed,&w.terms.child_mint),TOKEN_PROGRAM];assert_eq!(w.bank.call(&w.program,&keys,&[TAG_CLAIM_PARTICIPANT]).unwrap_err(),err(E_CLAIM_INVALID),"the source must be the custody");
 let keys=[w.campaign,w.receipt_key(&unclaimed),w.authority(),w.terms.child_mint,custody,ata_key(&unclaimed,&w.terms.child_mint),w.system];assert_eq!(w.bank.call(&w.program,&keys,&[TAG_CLAIM_PARTICIPANT]).unwrap_err(),err(E_CLAIM_INVALID),"the token program must be the Token program");
 assert!(!w.receipt(&unclaimed).claimed);
}
#[test]fn dev_claims_follow_the_calendar_vesting_and_are_cumulative(){
 let launch_time=days_from_civil(2027,11,30)*SECONDS_PER_DAY+3600;let end=calendar_months_after(launch_time,3).unwrap();assert_eq!(end,days_from_civil(2028,2,29)*SECONDS_PER_DAY+3600);
 let(mut w,_)=World::live_at(launch_time);assert_eq!(w.campaign().state.launch_time,launch_time);
 let custody=w.custody();let dev=w.terms.dev;let dev_ata=w.holder_ata(&dev);let split=w.terms.split().unwrap();
 set_now(launch_time-1);assert_eq!(w.claim_dev().unwrap_err(),err(E_NOT_YET_CLAIMABLE),"before the launch time nothing is entitled");
 set_now(launch_time);w.claim_dev().unwrap();assert_eq!(w.balance(&dev_ata),SUPPLY/100,"1 % at launch");assert_eq!(w.campaign().state.dev_claimed,SUPPLY/100);
 w.claim_dev().unwrap();assert_eq!(w.balance(&dev_ata),SUPPLY/100,"nothing more at the same instant");
 set_now(launch_time+(end-launch_time)/2);w.claim_dev().unwrap();assert_eq!(w.balance(&dev_ata),SUPPLY/50,"2 % halfway");
 set_now(end-1);w.claim_dev().unwrap();assert!(w.balance(&dev_ata)<SUPPLY*3/100);
 set_now(end);w.claim_dev().unwrap();assert_eq!(w.balance(&dev_ata),SUPPLY*3/100,"3 % exactly at the end");assert_eq!(w.balance(&dev_ata),split.dev);
 set_now(end+86_400*365);let cpis=cpi_count();w.claim_dev().unwrap();assert_eq!(w.balance(&dev_ata),split.dev);assert_eq!(cpi_count(),cpis,"nothing left: no transfer");
 assert_eq!(w.balance(&custody),SUPPLY-split.liquidity-split.dev);
 let stranger_ata=w.holder_ata(&Pubkey::new_unique());let keys=[w.campaign,w.authority(),w.terms.child_mint,custody,stranger_ata,TOKEN_PROGRAM];
 assert_eq!(w.bank.call(&w.program,&keys,&[TAG_CLAIM_DEV]).unwrap_err(),err(E_CLAIM_INVALID),"only the sealed dev's associated token account");
 let keys=[w.campaign,w.authority(),w.terms.child_mint,dev_ata,custody,TOKEN_PROGRAM];assert_eq!(w.bank.call(&w.program,&keys,&[TAG_CLAIM_DEV]).unwrap_err(),err(E_CLAIM_INVALID),"source and destination swapped");
 let mint=w.terms.child_mint;let authority=w.authority();
 w.bank.get_mut(&mint).data=mint_data(SUPPLY,6,Some(&authority),None);assert_eq!(w.claim_dev().unwrap_err(),err(E_CLAIM_INVALID),"a mint that still has an authority is not a launched mint");
 w.bank.get_mut(&mint).data=mint_data(SUPPLY+1,6,None,None);assert_eq!(w.claim_dev().unwrap_err(),err(E_CLAIM_INVALID),"more supply than sealed");
 w.bank.get_mut(&mint).data=mint_data(SUPPLY-1_000,6,None,None);w.claim_dev().unwrap();
 assert_eq!(w.balance(&dev_ata),split.dev,"holder burns do not change the entitlement");
 let mut c=w.campaign();c.state.flags=FLAG_DISTRIBUTION_ACTIVATED;w.set_campaign(&c);assert_eq!(w.claim_dev().unwrap_err(),err(E_DISTRIBUTION_ACTIVATED));
}
#[test]fn dev_vesting_across_a_leap_day_and_a_month_end_clamp_from_the_thirty_first(){
 let launch_time=days_from_civil(2028,1,31)*SECONDS_PER_DAY+7;let end=calendar_months_after(launch_time,3).unwrap();assert_eq!(end,days_from_civil(2028,4,30)*SECONDS_PER_DAY+7,"31 January plus three months is 30 April");
 let(mut w,_)=World::live_at(launch_time);let dev=w.terms.dev;let dev_ata=w.holder_ata(&dev);
 let leap_day=days_from_civil(2028,2,29)*SECONDS_PER_DAY+7;set_now(leap_day);w.claim_dev().unwrap();
 assert_eq!(w.balance(&dev_ata),dev_entitled(SUPPLY,VESTING_THREE_MONTHS,launch_time,leap_day).unwrap());
 assert_eq!(w.balance(&dev_ata),SUPPLY/100+SUPPLY/50*29/90,"29 of 90 days elapsed on the leap day");
 set_now(end);w.claim_dev().unwrap();assert_eq!(w.balance(&dev_ata),SUPPLY*3/100);
}
#[test]fn tags_outside_the_table_and_empty_data_are_refused(){
 let w=World::created();let mut acc=vec![w.bank.get(&w.campaign).clone()];
 assert_eq!(run(&w.program,&mut acc,&[]).unwrap_err(),ProgramError::InvalidInstructionData);
 for tag in [9u8,10,24,27,255]{assert_eq!(run(&w.program,&mut acc,&[tag]).unwrap_err(),ProgramError::InvalidInstructionData,"tag {tag}");}
 for tag in [TAG_FEES_INIT,TAG_FEES_COLLECT,TAG_FEES_ROTATE_OPERATOR,TAG_FEES_DISTRIBUTE,TAG_FEES_BUY_BURN,TAG_FEES_BURN_CHILD]{assert_eq!(run(&w.program,&mut acc,&[tag]).unwrap_err(),err(E_ACCOUNT_COUNT),"fee tag {tag} with one account");}
}
/// The harvest the emulated lock pays at the next collect, given as (child, SOL) whatever the pool's mint order.
fn set_pool_harvest(w:&World,child:u64,sol:u64){let(_,_,_,_,_,m0,_)=w.pool_keys();if m0==w.terms.child_mint{set_harvest(child,sol)}else{set_harvest(sol,child)}}
#[test]fn fee_state_is_created_once_and_names_the_operator(){
 let(mut w,_)=World::settled();w.fee_setup();let operator=w.operator;let treasury=w.terms.treasury;
 assert_eq!(w.fees_init().unwrap_err(),err(E_NOT_LAUNCHED),"no fee cycle before the launch");
 w.launch().unwrap();
 let creator=w.creator;
 assert_eq!(w.fees_init_by(treasury,Pubkey::default()).unwrap_err(),err(E_FEE_OPERATOR),"an operator must be named");
 assert_eq!(w.fees_init_by(treasury,w.fee_authority()).unwrap_err(),err(E_FEE_OPERATOR),"the fee authority cannot be its own operator");
 let mut keys=w.fee_keys(treasury);keys.push(w.system);assert_eq!(w.bank.call(&w.program,&keys,&[TAG_FEES_INIT]).unwrap_err(),err(E_TERMS_INVALID),"the body is the operator key");
 assert_eq!(w.bank.call(&w.program,&keys[..4],&[vec![TAG_FEES_INIT],operator.to_bytes().to_vec()].concat()).unwrap_err(),err(E_ACCOUNT_COUNT));
 let mut wrong_pda=keys.clone();wrong_pda[2]=Pubkey::new_unique();assert_eq!(w.bank.call(&w.program,&wrong_pda,&[vec![TAG_FEES_INIT],operator.to_bytes().to_vec()].concat()).unwrap_err(),err(E_FEE_ACCOUNT));
 let mut wrong_authority=keys.clone();wrong_authority[3]=Pubkey::new_unique();assert_eq!(w.bank.call(&w.program,&wrong_authority,&[vec![TAG_FEES_INIT],operator.to_bytes().to_vec()].concat()).unwrap_err(),err(E_FEE_ACCOUNT));
 w.bank.get_mut(&creator).signer=false;assert_eq!(w.fees_init_by(creator,operator).unwrap_err(),ProgramError::MissingRequiredSignature,"the payer must sign, not merely be listed");w.bank.get_mut(&creator).signer=true;
 assert!(w.bank.get(&w.fee_state_key()).data.is_empty(),"no refused call created the fee state");
 // Standard: the operator is inert (tag 25 refuses Standard campaigns), so any signer may open the cycle and pay the rent.
 let before=w.lamports(&creator);w.fees_init_by(creator,operator).unwrap();
 let state=w.fee_state();assert_eq!(state.operator,operator);assert_eq!(state,FeeState{operator,..FeeState::default()});
 let acc=w.bank.get(&w.fee_state_key());assert_eq!(acc.owner,w.program);assert_eq!(acc.lamports,rent(FEE_STATE_LEN));assert_eq!(before-w.lamports(&creator),rent(FEE_STATE_LEN),"the payer pays the rent");
 assert_eq!(w.fees_init().unwrap_err(),ProgramError::AccountAlreadyInitialized,"once");
}
#[test]fn family_fee_state_is_created_by_the_sealed_treasury_only(){
 let(mut w,_)=World::live_with(family_terms,NOW);w.fee_setup();let operator=w.operator;let creator=w.creator;let treasury=w.terms.treasury;
 assert_eq!(w.fees_init_by(creator,operator).unwrap_err(),err(E_FEE_OPERATOR),"the creator cannot name the operator: a public creator would capture the parent buyback cycle");
 assert_eq!(w.fees_init_by(operator,operator).unwrap_err(),err(E_FEE_OPERATOR));
 w.bank.get_mut(&treasury).signer=false;assert_eq!(w.fees_init().unwrap_err(),ProgramError::MissingRequiredSignature,"the treasury must sign, not merely be listed");w.bank.get_mut(&treasury).signer=true;
 assert!(w.bank.get(&w.fee_state_key()).data.is_empty(),"no refused call created the fee state");
 let before=w.lamports(&treasury);w.fees_init().unwrap();assert_eq!(before-w.lamports(&treasury),rent(FEE_STATE_LEN),"the treasury pays the rent");
 assert_eq!(w.fee_state().operator,operator);
}
#[test]fn the_treasury_rotates_the_operator_and_nobody_else_can(){
 let(mut w,_)=World::live_with(family_terms,NOW);w.fee_setup();w.fees_init().unwrap();
 let treasury=w.terms.treasury;let old=w.operator;let new=w.bank.add(Acc::empty(Pubkey::new_unique()).signer().with_lamports(SOL));
 assert_eq!(w.fees_rotate_by(w.creator,new).unwrap_err(),err(E_FEE_OPERATOR),"the creator cannot rotate");
 assert_eq!(w.fees_rotate_by(old,new).unwrap_err(),err(E_FEE_OPERATOR),"nor the operator itself");
 assert_eq!(w.fees_rotate_by(new,new).unwrap_err(),err(E_FEE_OPERATOR));
 assert_eq!(w.fees_rotate_by(treasury,Pubkey::default()).unwrap_err(),err(E_FEE_OPERATOR));
 assert_eq!(w.fees_rotate_by(treasury,w.fee_authority()).unwrap_err(),err(E_FEE_OPERATOR));
 let mut keys=w.fee_keys(treasury);keys.push(w.system);assert_eq!(w.bank.call(&w.program,&keys,&[vec![TAG_FEES_ROTATE_OPERATOR],new.to_bytes().to_vec()].concat()).unwrap_err(),err(E_ACCOUNT_COUNT),"tag 22 takes the four common accounts only");
 assert_eq!(w.bank.call(&w.program,&keys[..4],&[TAG_FEES_ROTATE_OPERATOR]).unwrap_err(),err(E_TERMS_INVALID));
 w.bank.get_mut(&treasury).signer=false;assert_eq!(w.fees_rotate_by(treasury,new).unwrap_err(),ProgramError::MissingRequiredSignature);w.bank.get_mut(&treasury).signer=true;
 assert_eq!(w.fee_state().operator,old,"no refused rotation changed the operator");
 set_pool_harvest(&w,0,33_600_000_000);w.fees_collect(9).unwrap();w.fees_distribute().unwrap();
 let state_before=w.fee_state();
 w.fees_rotate_by(treasury,new).unwrap();
 let state=w.fee_state();assert_eq!(state.operator,new);assert_eq!(FeeState{operator:old,..state},state_before,"rotation changes the operator and nothing else");
 let now=w.campaign().state.launch_time;set_now(now);let expiry=now+60;let floor=w.reference_floor(0,1_000);
 assert_eq!(w.fees_buy_burn(0,1_000,floor,expiry,&route_v2(1_000,floor+100,100),&[]).unwrap_err(),err(E_FEE_OPERATOR),"the replaced operator is refused");
 w.operator=new;set_fill(floor);w.fees_buy_burn(0,1_000,floor,expiry,&route_v2(1_000,floor+100,100),&[]).unwrap();
 assert_eq!(w.fee_state().burned_a,floor,"the new operator runs the buyback");
 w.fees_rotate_by(treasury,old).unwrap();assert_eq!(w.fee_state().operator,old,"and back");
}
#[test]fn standard_fee_cycle_is_permissionless_burns_the_coin_side_and_pays_treasury_and_dev_by_the_sealed_weights(){
 let(mut w,_)=World::live();w.fee_setup();w.fees_init().unwrap();
 let(pool,_,vault0,vault1,_,m0,_)=w.pool_keys();let(child_vault,sol_vault)=if m0==w.terms.child_mint{(vault0,vault1)}else{(vault1,vault0)};
 let(child_before,sol_before)=(w.balance(&child_vault),w.balance(&sol_vault));
 assert_eq!(w.fees_collect(0).unwrap_err(),err(E_TERMS_INVALID),"a zero LP share is not a harvest");
 let mut wrong_pool=w.collect_keys();wrong_pool[8]=Pubkey::new_unique();assert_eq!(w.bank.call(&w.program,&wrong_pool,&[vec![TAG_FEES_COLLECT],1u64.to_le_bytes().to_vec()].concat()).unwrap_err(),err(E_FEE_ACCOUNT),"the recorded pool only");
 let other_lock=w.bank.add(Acc::program(Pubkey::new_unique(),BPF_LOADER_UPGRADEABLE));
 let mut wrong_lock=w.collect_keys();wrong_lock[17]=other_lock;assert_eq!(w.bank.call(&w.program,&wrong_lock,&[vec![TAG_FEES_COLLECT],1u64.to_le_bytes().to_vec()].concat()).unwrap_err(),err(E_FEE_ACCOUNT),"the sealed lock program only");
 let mut stranger_custody=w.collect_keys();stranger_custody[5]=w.bank.add(Acc::token(Pubkey::new_unique(),TOKEN_PROGRAM,token_data(&WSOL,&w.fee_authority(),0)));assert_eq!(w.bank.call(&w.program,&stranger_custody,&[vec![TAG_FEES_COLLECT],1u64.to_le_bytes().to_vec()].concat()).unwrap_err(),err(E_FEE_ACCOUNT),"custody is the fee authority's associated token account");
 assert_eq!(w.fee_state(),FeeState{operator:w.operator,..FeeState::default()},"no refused call changed the state");
 // Anyone may harvest: a wallet that is not the operator and does not even sign.
 let stranger=w.bank.add(Acc::empty(Pubkey::new_unique()));
 set_pool_harvest(&w,1_000_000_000,2_000_000_000);
 let mut keys=w.collect_keys();keys[1]=stranger;w.bank.call(&w.program,&keys,&[vec![TAG_FEES_COLLECT],5u64.to_le_bytes().to_vec()].concat()).unwrap();
 let s=w.fee_state();assert_eq!((s.child,s.total),(1_000_000_000,2_000_000_000));
 assert_eq!(w.balance(&w.fee_child_custody()),1_000_000_000);assert_eq!(w.balance(&w.fee_wsol_custody()),2_000_000_000,"the harvest lands in the custody whoever calls");
 assert_eq!(w.balance(&child_vault),child_before-1_000_000_000);assert_eq!(w.balance(&sol_vault),sol_before-2_000_000_000);
 let _=pool;
 assert_eq!(w.fees_burn_child(1_000_000_001).unwrap_err(),err(E_FEE_ARITHMETIC),"cannot burn more than collected");
 assert_eq!(w.fees_burn_child(0).unwrap_err(),err(E_FEE_ARITHMETIC));
 let supply_before=read64(&w.bank.get(&w.terms.child_mint).data,36).unwrap();
 let mut burn_keys=w.fee_keys(stranger);burn_keys.extend([w.fee_child_custody(),w.terms.child_mint,TOKEN_PROGRAM]);
 w.bank.call(&w.program,&burn_keys,&[vec![TAG_FEES_BURN_CHILD],600_000_000u64.to_le_bytes().to_vec()].concat()).unwrap();
 let s=w.fee_state();assert_eq!((s.child,s.burned_child),(400_000_000,600_000_000),"anyone may burn the coin side");
 assert_eq!(w.balance(&w.fee_child_custody()),400_000_000);assert_eq!(read64(&w.bank.get(&w.terms.child_mint).data,36).unwrap(),supply_before-600_000_000,"burned out of existence");
 w.fees_burn_child(400_000_000).unwrap();assert_eq!(w.fee_state().child,0);
 let e=fee_entitlements(2_000_000_000,FEE_WEIGHTS_STANDARD).unwrap();assert_eq!((e.treasury,e.dev,e.parent_a,e.parent_b),(1_761_904_761,238_095_238,0,0));
 let mut stranger_ata=w.distribute_keys();stranger_ata[5]=w.bank.add(Acc::token(ata_key(&Pubkey::new_unique(),&WSOL),TOKEN_PROGRAM,token_data(&WSOL,&Pubkey::new_unique(),0)));
 assert_eq!(w.bank.call(&w.program,&stranger_ata,&[TAG_FEES_DISTRIBUTE]).unwrap_err(),err(E_FEE_ACCOUNT),"nobody can redirect the treasury share");
 let mut swapped=w.distribute_keys();swapped.swap(5,6);assert_eq!(w.bank.call(&w.program,&swapped,&[TAG_FEES_DISTRIBUTE]).unwrap_err(),err(E_FEE_ACCOUNT),"nor swap treasury and dev");
 let mut by_stranger=w.distribute_keys();by_stranger[1]=stranger;w.bank.call(&w.program,&by_stranger,&[TAG_FEES_DISTRIBUTE]).unwrap();
 let s=w.fee_state();assert_eq!((s.treasury,s.dev,s.parent_a,s.parent_b),(e.treasury,e.dev,0,0),"anyone may distribute; the sealed recipients are paid");
 assert_eq!(w.balance(&ata_key(&w.terms.treasury,&WSOL)),e.treasury);assert_eq!(w.balance(&ata_key(&w.terms.dev,&WSOL)),e.dev);
 assert_eq!(w.balance(&w.fee_wsol_custody()),e.dust);assert_eq!(s.liability().unwrap(),e.dust,"only the rounding dust stays");
 let cpis=cpi_count();w.fees_distribute().unwrap();assert_eq!(cpi_count(),cpis,"nothing more to pay: no transfer");
 set_pool_harvest(&w,0,168);w.fees_collect(1).unwrap();w.fees_distribute().unwrap();
 let s=w.fee_state();let e2=fee_entitlements(2_000_000_168,FEE_WEIGHTS_STANDARD).unwrap();
 assert_eq!((s.treasury,s.dev),(e2.treasury,e2.dev),"cumulative: the second distribution pays only the difference");
 assert_eq!(w.balance(&ata_key(&w.terms.treasury,&WSOL)),e2.treasury);assert_eq!(w.balance(&ata_key(&w.terms.dev,&WSOL)),e2.dev);
 assert_eq!(w.balance(&w.fee_wsol_custody()),2_000_000_168-e2.treasury-e2.dev);
 assert_eq!(w.fees_buy_burn(0,1,1,NOW+60,&route_v2(1,1,0),&[]).unwrap_err(),err(E_MODE_PARENTS),"a Standard campaign has no parent to buy");
}
#[test]fn family_fee_cycle_splits_four_ways_and_buys_and_burns_both_parents_through_jupiter_at_or_above_the_floor(){
 let(mut w,_)=World::live_with(family_terms,NOW);w.fee_setup();w.fees_init().unwrap();
 set_pool_harvest(&w,5_000_000,3_360_000_000);w.fees_collect(9).unwrap();w.fees_burn_child(5_000_000).unwrap();
 let e=fee_entitlements(3_360_000_000,FEE_WEIGHTS_FAMILY).unwrap();assert_eq!((e.treasury,e.dev,e.parent_a,e.parent_b,e.dust),(1_960_000_000,400_000_000,500_000_000,500_000_000,0));
 w.fees_distribute().unwrap();
 let s=w.fee_state();assert_eq!((s.treasury,s.dev,s.parent_a,s.parent_b),(e.treasury,e.dev,e.parent_a,e.parent_b));
 assert_eq!(w.balance(&ata_key(&w.terms.treasury,&WSOL)),e.treasury);assert_eq!(w.balance(&ata_key(&w.terms.dev,&WSOL)),e.dev);
 assert_eq!(w.balance(&w.fee_wsol_custody()),1_000_000_000,"both parent budgets wait in custody");assert_eq!(s.liability().unwrap(),1_000_000_000);
 let now=w.campaign().state.launch_time;set_now(now);let expiry=now+60;let market=Pubkey::new_unique();
 let supply_a=w.parent_supply(0);let supply_b=w.parent_supply(1);let authority_lamports=w.lamports(&w.fee_authority());
 let floor_a=w.reference_floor(0,300_000_000);assert_eq!(floor_a,2_938_818_086,"0.3 SOL against 100 SOL / 1e12 at 0.25 %, less 1.5 %");
 let fill=floor_a+1_000;set_fill(fill);set_accumulator(1_500_000);
 w.fees_buy_burn(0,300_000_000,floor_a,expiry,&route_v2(300_000_000,floor_a+floor_a/50,100),&[market,w.fee_wsol_custody(),w.parent_custody(0)]).unwrap();
 let s=w.fee_state();assert_eq!((s.spent_a,s.burned_a,s.spent_b,s.burned_b),(300_000_000,fill,0,0));
 assert_eq!(w.balance(&w.fee_wsol_custody()),700_000_000);assert_eq!(w.balance(&w.parent_custody(0)),0,"everything bought was burned");
 assert_eq!(w.parent_supply(0),supply_a-fill,"parent A supply fell by the burn");
 assert_eq!(w.lamports(&w.fee_authority()),authority_lamports-1_500_000,"the route may take lamports from the fee authority (the Pump AMM accumulator)");
 assert_eq!(s.pending(0).unwrap(),200_000_000);assert_eq!(s.liability().unwrap(),700_000_000);
 assert_eq!(w.reference_rate(1),25_000,"index 7 is the 2.5 % tier");let floor_b=w.reference_floor(1,500_000_000);assert_eq!(floor_b,2_377_754_394);
 set_fill(floor_b);
 w.fees_buy_burn(1,500_000_000,floor_b,expiry,&fees::tests::route_v1(500_000_000,floor_b+25_000,0,0,2),&[market]).unwrap();
 let s=w.fee_state();assert_eq!((s.spent_b,s.burned_b),(500_000_000,floor_b));assert_eq!(w.parent_supply(1),supply_b-floor_b,"a Token-2022 parent burns through its own program");
 assert_eq!(w.balance(&w.parent_custody(1)),0);assert_eq!(w.balance(&w.fee_wsol_custody()),200_000_000);assert_eq!(s.pending(1).unwrap(),0);
 assert_eq!(w.reference_floor(1,1_000),4_800);
 set_fill(5_000);assert_eq!(w.fees_buy_burn(1,1_000,4_800,expiry,&route_v2(1_000,5_000,100),&[]).unwrap_err(),err(E_FEE_ARITHMETIC),"parent B's budget is spent");
 let floor_rest=w.reference_floor(0,200_000_000);assert_eq!(floor_rest,1_961_162_480);
 set_fill(floor_rest+7);w.fees_buy_burn(0,200_000_000,floor_rest,expiry,&route_v2(200_000_000,floor_rest+floor_rest/50,100),&[]).unwrap();
 let s=w.fee_state();assert_eq!((s.spent_a,s.burned_a),(500_000_000,fill+floor_rest+7));assert_eq!(w.balance(&w.fee_wsol_custody()),0);assert_eq!(s.liability().unwrap(),0);
 assert_eq!(w.parent_supply(0),supply_a-fill-floor_rest-7);assert_eq!(w.parent_supply(1),supply_b-floor_b);
}
#[test]fn buy_and_burn_enforces_the_route_header_the_slice_cap_the_aliasing_guard_and_the_fill(){
 let(mut w,_)=World::live_with(family_terms,NOW);w.fee_setup();w.fees_init().unwrap();
 set_pool_harvest(&w,0,33_600_000_000);w.fees_collect(9).unwrap();w.fees_distribute().unwrap();
 assert_eq!(w.fee_state().pending(0).unwrap(),5_000_000_000);
 let now=w.campaign().state.launch_time;set_now(now);let expiry=now+60;let good=|amount:u64|route_v2(amount,10_000,100);
 assert_eq!(w.reference_floor(0,1_000),9_819,"1,000 lamports: 9,969 from the pool, less 1.5 %");
 let before=(w.fee_state(),w.balance(&w.fee_wsol_custody()),w.parent_supply(0));let cpis=cpi_count();
 let route=err(E_FEE_ROUTE);
 assert_eq!(w.fees_buy_burn(0,500_000_001,9_900,expiry,&good(500_000_001),&[]).unwrap_err(),route,"above the 0.5 SOL slice cap");
 assert_eq!(w.fees_buy_burn(0,0,9_900,expiry,&good(0),&[]).unwrap_err(),route,"nothing to spend");
 assert_eq!(w.fees_buy_burn(0,1_000,0,expiry,&good(1_000),&[]).unwrap_err(),route,"a positive minimum is required");
 assert_eq!(w.fees_buy_burn(0,1_000,9_900,now-1,&good(1_000),&[]).unwrap_err(),route,"expired quote");
 assert_eq!(w.fees_buy_burn(0,1_000,9_900,now+121,&good(1_000),&[]).unwrap_err(),route,"a quote may not be valid longer than 120 seconds");
 assert_eq!(w.fees_buy_burn(0,1_000,9_900,expiry,&good(999),&[]).unwrap_err(),route,"the route must spend exactly the slice");
 assert_eq!(w.fees_buy_burn(0,1_000,9_900,expiry,&route_v2(1_000,10_000,101),&[]).unwrap_err(),route,"slippage above 1 %");
 assert_eq!(w.fees_buy_burn(0,1_000,9_901,expiry,&good(1_000),&[]).unwrap_err(),route,"the quote minus slippage must clear the minimum");
 assert_eq!(w.fees_buy_burn(0,1_000,9_900,expiry,&fees::tests::route_v2_header(1_000,10_000,100,1,1),&[]).unwrap_err(),route,"no platform fee");
 assert_eq!(w.fees_buy_burn(0,1_000,9_900,expiry,&fees::tests::route_v2_header(1_000,10_000,100,0,9),&[]).unwrap_err(),route,"at most 8 steps");
 let mut foreign=good(1_000);foreign[0]^=1;assert_eq!(w.fees_buy_burn(0,1_000,9_900,expiry,&foreign,&[]).unwrap_err(),route,"only Jupiter's route instructions");
 assert_eq!(w.fees_buy_burn(0,1_000,9_900,expiry,&good(1_000)[..33],&[]).unwrap_err(),err(E_TERMS_INVALID),"a short body");
 assert_eq!(w.bank.call(&w.program,&w.buy_burn_keys(0,&[]),&World::buy_burn_body(2,1_000,9_900,expiry,&good(1_000))).unwrap_err(),err(E_FEE_ACCOUNT),"two parents only");
 let guard=err(E_FEE_ACCOUNT);
 assert_eq!(w.fees_buy_burn(0,1_000,9_900,expiry,&good(1_000),&[w.fee_child_custody()]).unwrap_err(),guard,"the coin custody may not appear in a route");
 assert_eq!(w.fees_buy_burn(0,1_000,9_900,expiry,&good(1_000),&[Pubkey::new_unique(),w.parent_custody(1)]).unwrap_err(),guard,"nor the other parent's custody");
 let other_classic=parent_ata(&w.fee_authority(),&w.terms.parent_mint[1],&TOKEN_PROGRAM);assert_eq!(w.fees_buy_burn(0,1_000,9_900,expiry,&good(1_000),&[other_classic]).unwrap_err(),guard,"under either token program");
 assert_eq!(w.fees_buy_burn(1,1_000,4_800,expiry,&route_v2(1_000,5_000,100),&[w.parent_custody(0)]).unwrap_err(),guard);
 let mut swapped_mint=w.buy_burn_keys(0,&[]);swapped_mint[6]=w.terms.parent_mint[1];assert_eq!(w.bank.call(&w.program,&swapped_mint,&World::buy_burn_body(0,1_000,9_900,expiry,&good(1_000))).unwrap_err(),guard,"the sealed parent mint only");
 let mut wrong_program=w.buy_burn_keys(0,&[]);wrong_program[9]=TOKEN_2022_PROGRAM;assert_eq!(w.bank.call(&w.program,&wrong_program,&World::buy_burn_body(0,1_000,9_900,expiry,&good(1_000))).unwrap_err(),guard,"the parent's own token program");
 let mut wrong_jupiter=w.buy_burn_keys(0,&[]);wrong_jupiter[10]=TOKEN_PROGRAM;assert_eq!(w.bank.call(&w.program,&wrong_jupiter,&World::buy_burn_body(0,1_000,9_900,expiry,&good(1_000))).unwrap_err(),guard,"Jupiter only");
 let mut wrong_event=w.buy_burn_keys(0,&[]);wrong_event[11]=Pubkey::new_unique();assert_eq!(w.bank.call(&w.program,&wrong_event,&World::buy_burn_body(0,1_000,9_900,expiry,&good(1_000))).unwrap_err(),guard);
 let mut not_operator=w.buy_burn_keys(0,&[]);not_operator[1]=w.creator;assert_eq!(w.bank.call(&w.program,&not_operator,&World::buy_burn_body(0,1_000,9_900,expiry,&good(1_000))).unwrap_err(),err(E_FEE_OPERATOR),"the creator is not the operator");
 let mut by_treasury=w.buy_burn_keys(0,&[]);by_treasury[1]=w.terms.treasury;assert_eq!(w.bank.call(&w.program,&by_treasury,&World::buy_burn_body(0,1_000,9_900,expiry,&good(1_000))).unwrap_err(),err(E_FEE_OPERATOR),"nor is the treasury");
 let operator=w.operator;w.bank.get_mut(&operator).signer=false;assert_eq!(w.fees_buy_burn(0,1_000,9_900,expiry,&good(1_000),&[]).unwrap_err(),ProgramError::MissingRequiredSignature,"the operator must sign");w.bank.get_mut(&operator).signer=true;
 assert_eq!(w.bank.call(&w.program,&w.buy_burn_keys(0,&[])[..15],&World::buy_burn_body(0,1_000,9_900,expiry,&good(1_000))).unwrap_err(),err(E_ACCOUNT_COUNT));
 assert_eq!(cpi_count(),cpis,"no refused buyback reached Jupiter");
 set_fill(9_899);assert_eq!(w.fees_buy_burn(0,1_000,9_900,expiry,&good(1_000),&[]).unwrap_err(),err(E_FEE_ARITHMETIC),"a fill below the minimum fails after the route");
 assert!(cpi_count()>cpis,"the route ran");
 assert_eq!((w.fee_state(),w.balance(&w.fee_wsol_custody()),w.parent_supply(0)),before,"and the runtime rolled the slice back");
 set_fill(9_900);w.fees_buy_burn(0,1_000,9_900,expiry,&good(1_000),&[w.fee_wsol_custody(),w.parent_custody(0),Pubkey::new_unique()]).unwrap();
 assert_eq!(w.fee_state().burned_a,9_900,"the custody accounts themselves may be listed again for the swap steps");
 assert_eq!(w.balance(&w.fee_wsol_custody()),before.1-1_000);
 let floor=w.reference_floor(0,500_000_000);assert_eq!(floor,4_888_307_067);
 set_fill(0);assert_eq!(w.fees_buy_burn(0,500_000_000,floor,expiry,&route_v2(500_000_000,floor+floor/50,100),&[]).unwrap_err(),err(E_FEE_ARITHMETIC),"a slice at the cap with no fill is rolled back");
 assert_eq!(w.fee_state().spent_a,1_000);
}
#[test]fn buy_and_burn_min_out_must_clear_the_floor_derived_from_the_reference_pool(){
 let(mut w,_)=World::live_with(family_terms,NOW);w.fee_setup();w.fees_init().unwrap();
 set_pool_harvest(&w,0,33_600_000_000);w.fees_collect(9).unwrap();w.fees_distribute().unwrap();
 let now=w.campaign().state.launch_time;set_now(now);let expiry=now+60;
 let cpis=cpi_count();let before=w.fee_state();
 // The audit's capture: an operator naming quoted = min = 1 and routing through a pool of his own.
 assert_eq!(w.fees_buy_burn(0,500_000_000,1,expiry,&route_v2(500_000_000,1,0),&[]).unwrap_err(),err(E_FEE_PRICE_FLOOR),"quoted = min = 1 no longer passes");
 assert_eq!(w.fees_buy_burn(0,500_000_000,1,expiry,&fees::tests::route_v1(500_000_000,1,0,0,1),&[]).unwrap_err(),err(E_FEE_PRICE_FLOOR));
 for(parent,amount)in[(0usize,1_000u64),(0,300_000_000),(0,500_000_000),(1,1_000),(1,500_000_000)]{
  let floor=w.reference_floor(parent,amount);assert!(floor>1);
  assert_eq!(w.fees_buy_burn(parent as u8,amount,floor-1,expiry,&route_v2(amount,floor+floor/50,100),&[]).unwrap_err(),err(E_FEE_PRICE_FLOOR),"parent {parent}, {amount} lamports: one unit below the floor");
  set_fill(floor);w.fees_buy_burn(parent as u8,amount,floor,expiry,&route_v2(amount,floor+floor/50,100),&[]).unwrap();
  set_fill(floor+1);w.fees_buy_burn(parent as u8,amount,floor+1,expiry,&route_v2(amount,floor+floor/50,100),&[]).unwrap();
 }
 assert_eq!(w.fee_state().spent_a,2*(1_000+300_000_000+500_000_000));assert_eq!(w.fee_state().spent_b,2*(1_000+500_000_000));
 // The floor moves with the reference pool: a deeper WSOL side means fewer parent units per lamport.
 let(_,_,_,wsol_vault)=w.reference_keys(0);let vault=w.bank.get_mut(&wsol_vault);let reserve=balance(vault);put64(&mut vault.data,64,reserve*2);
 let deeper=buyback_floor(reference_out(1_000,2*REFERENCE_RESERVES[0].0,REFERENCE_RESERVES[0].1,w.reference_rate(0)).unwrap(),FAMILY_SLIPPAGE_BPS);
 assert!(deeper<w.reference_floor(0,1_000));
 assert_eq!(w.fees_buy_burn(0,1_000,deeper-1,expiry,&route_v2(1_000,deeper+100,100),&[]).unwrap_err(),err(E_FEE_PRICE_FLOOR));
 set_fill(deeper);w.fees_buy_burn(0,1_000,deeper,expiry,&route_v2(1_000,deeper+100,100),&[]).unwrap();
 put64(&mut w.bank.get_mut(&wsol_vault).data,64,reserve);
 // Fees the pool holds for its protocol and fund are not reserve: adding them to the vault does not move the floor.
 let(_,pool,parent_vault,_)=w.reference_keys(0);let parent_reserve=balance(w.bank.get(&parent_vault));
 put64(&mut w.bank.get_mut(&parent_vault).data,64,parent_reserve+5_000);put64(&mut w.bank.get_mut(&pool).data,POOL_OFF_PROTOCOL_FEES_0+if w.terms.parent_mint[0]<WSOL{0}else{8},REFERENCE_HELD/2+5_000);
 let floor=w.reference_floor(0,1_000);assert_eq!(w.fees_buy_burn(0,1_000,floor-1,expiry,&route_v2(1_000,floor+100,100),&[]).unwrap_err(),err(E_FEE_PRICE_FLOOR));
 assert!(cpi_count()>cpis);let _=before;
}
#[test]fn buy_and_burn_reads_only_the_derived_reference_accounts_and_refuses_a_parent_without_one(){
 let(mut w,_)=World::live_with(family_terms,NOW);w.fee_setup();w.fees_init().unwrap();
 set_pool_harvest(&w,0,33_600_000_000);w.fees_collect(9).unwrap();w.fees_distribute().unwrap();
 let now=w.campaign().state.launch_time;set_now(now);let expiry=now+60;let floor=w.reference_floor(0,1_000);let body=World::buy_burn_body(0,1_000,floor,expiry,&route_v2(1_000,floor+100,100));
 let cpis=cpi_count();let guard=err(E_FEE_ACCOUNT);
 let(config,pool,parent_vault,wsol_vault)=w.reference_keys(0);
 // A richer pool of the operator's own on another config index, at its own canonical address.
 let other_config=w.bank.add(Acc::new(amm_config_address(&RAYDIUM_CPMM,3),RAYDIUM_CPMM,amm_config_data(3,REFERENCE_TRADE_FEE_RATE,0,0)));
 let mut swapped_config=w.buy_burn_keys(0,&[]);swapped_config[12]=other_config;assert_eq!(w.bank.call(&w.program,&swapped_config,&body).unwrap_err(),guard,"the sealed config index only");
 let mut wrong_pool=w.buy_burn_keys(0,&[]);wrong_pool[13]=w.campaign().state.pool;assert_eq!(w.bank.call(&w.program,&wrong_pool,&body).unwrap_err(),guard,"the campaign's own pool is not the reference");
 // A CPMM-owned config at an address that is not the PDA of the index it claims, with a rich pool of its own derived
 // from it: the program derives the config address from the sealed index instead of trusting the account's contents.
 let claimed=w.bank.add(Acc::new(Pubkey::new_unique(),RAYDIUM_CPMM,amm_config_data(0,REFERENCE_TRADE_FEE_RATE,0,0)));
 let parent_mint=w.terms.parent_mint[0];let(m0,m1)=if parent_mint<WSOL{(parent_mint,WSOL)}else{(WSOL,parent_mint)};
 let rich_pool=Pubkey::find_program_address(&[CPMM_POOL_SEED,claimed.as_ref(),m0.as_ref(),m1.as_ref()],&RAYDIUM_CPMM).0;
 let rich_vault=|mint:&Pubkey|Pubkey::find_program_address(&[CPMM_VAULT_SEED,rich_pool.as_ref(),mint.as_ref()],&RAYDIUM_CPMM).0;
 let(v0,v1)=(rich_vault(&m0),rich_vault(&m1));
 w.bank.add(Acc::new(rich_pool,RAYDIUM_CPMM,pool_state_data(&claimed,&Pubkey::new_unique(),&v0,&v1,&Pubkey::new_unique(),&m0,&m1,(&TOKEN_PROGRAM,&TOKEN_PROGRAM),&Pubkey::new_unique(),1)));
 w.bank.add(Acc::token(rich_vault(&parent_mint),TOKEN_PROGRAM,token_data(&parent_mint,&w.cpmm_authority(),1)));
 w.bank.add(Acc::token(rich_vault(&WSOL),TOKEN_PROGRAM,token_data(&WSOL,&w.cpmm_authority(),1_000_000*SOL)));
 let mut claimed_index=w.buy_burn_keys(0,&[]);claimed_index[12]=claimed;claimed_index[13]=rich_pool;claimed_index[14]=rich_vault(&parent_mint);claimed_index[15]=rich_vault(&WSOL);
 assert_eq!(w.bank.call(&w.program,&claimed_index,&body).unwrap_err(),guard,"a config claiming the sealed index at another address is refused");
 let(_,pool_b,parent_vault_b,wsol_vault_b)=w.reference_keys(1);
 let mut other_parent=w.buy_burn_keys(0,&[]);other_parent[13]=pool_b;other_parent[14]=parent_vault_b;other_parent[15]=wsol_vault_b;assert_eq!(w.bank.call(&w.program,&other_parent,&body).unwrap_err(),guard,"parent B's reference pool does not quote parent A");
 let fake_vault=w.bank.add(Acc::token(Pubkey::new_unique(),TOKEN_PROGRAM,token_data(&WSOL,&w.cpmm_authority(),1)));
 let mut swapped_vault=w.buy_burn_keys(0,&[]);swapped_vault[15]=fake_vault;assert_eq!(w.bank.call(&w.program,&swapped_vault,&body).unwrap_err(),guard,"vaults are derived from the pool, never taken from the caller");
 let mut vaults_reversed=w.buy_burn_keys(0,&[]);vaults_reversed.swap(14,15);assert_eq!(w.bank.call(&w.program,&vaults_reversed,&body).unwrap_err(),guard);
 let good_config=w.bank.get(&config).data.clone();
 w.bank.get_mut(&config).data=amm_config_data(1,REFERENCE_TRADE_FEE_RATE,0,0);assert_eq!(w.fees_buy_burn(0,1_000,floor,expiry,&route_v2(1_000,floor+100,100),&[]).unwrap_err(),guard,"the config must carry its own index");
 w.bank.get_mut(&config).data=good_config;w.bank.get_mut(&config).owner=Pubkey::new_unique();assert_eq!(w.fees_buy_burn(0,1_000,floor,expiry,&route_v2(1_000,floor+100,100),&[]).unwrap_err(),guard);
 w.bank.get_mut(&config).owner=RAYDIUM_CPMM;
 let good_pool=w.bank.get(&pool).data.clone();
 w.bank.get_mut(&pool).data[POOL_OFF_ENABLE_CREATOR_FEE]=1;assert_eq!(w.fees_buy_burn(0,1_000,floor,expiry,&route_v2(1_000,floor+100,100),&[]).unwrap_err(),err(E_FEE_REFERENCE),"a pool charging a creator fee is not a reference");
 w.bank.get_mut(&pool).data=good_pool;
 let wsol_reserve=balance(w.bank.get(&wsol_vault));put64(&mut w.bank.get_mut(&wsol_vault).data,64,0);
 assert_eq!(w.fees_buy_burn(0,1_000,1,expiry,&route_v2(1_000,100,100),&[]).unwrap_err(),err(E_FEE_REFERENCE),"an empty reserve cannot quote, and never yields a floor of one");
 put64(&mut w.bank.get_mut(&wsol_vault).data,64,wsol_reserve);
 let parent_reserve=balance(w.bank.get(&parent_vault));put64(&mut w.bank.get_mut(&parent_vault).data,64,REFERENCE_HELD-1);
 assert_eq!(w.fees_buy_burn(0,1_000,1,expiry,&route_v2(1_000,100,100),&[]).unwrap_err(),err(E_FEE_REFERENCE),"a vault below what the pool holds in fees cannot quote");
 put64(&mut w.bank.get_mut(&parent_vault).data,64,parent_reserve);
 assert_eq!(cpi_count(),cpis,"no refused buyback reached Jupiter");
 set_fill(floor);w.fees_buy_burn(0,1_000,floor,expiry,&route_v2(1_000,floor+100,100),&[]).unwrap();
 // A parent whose terms seal no reference pool: refused before the route, its budget stays in custody.
 let mut none=World::build(family_terms,NOW);none.terms.parent_reference_config[1]=0;none.seal().unwrap();set_now(none.terms.opens_at);
 let owner=none.wallet(200*SOL);none.commit(&owner,60*SOL,0).unwrap();set_now(none.terms.deadline);none.settle(&owner).unwrap();none.launch().unwrap();
 none.fee_setup();none.fees_init().unwrap();set_pool_harvest(&none,0,33_600_000_000);none.fees_collect(9).unwrap();none.fees_distribute().unwrap();
 let now=none.campaign().state.launch_time;set_now(now);let cpis=cpi_count();
 assert_eq!(none.fees_buy_burn(1,1_000,1_000_000,now+60,&route_v2(1_000,1_020_000,100),&[]).unwrap_err(),err(E_FEE_REFERENCE));
 assert_eq!(cpi_count(),cpis);assert_eq!(none.fee_state().pending(1).unwrap(),5_000_000_000,"the budget waits");
 let floor=none.reference_floor(0,1_000);set_fill(floor);none.fees_buy_burn(0,1_000,floor,now+60,&route_v2(1_000,floor+100,100),&[]).unwrap();
}
#[test]fn buy_and_burn_refuses_wsol_as_a_parent_before_any_cpi(){
 // Create refuses WSOL parents (E_MODE_PARENTS); a campaign sealed by hand with one proves tag 25 keeps its own guard.
 let mut w=World::build(family_terms,NOW);w.terms.parent_mint[1]=WSOL;w.terms.parent_program[1]=TOKEN_PROGRAM;w.terms.parent_reference_config[1]=0;
 assert_eq!(validate_terms(&w.terms,&w.creator,NOW).unwrap_err(),err(E_MODE_PARENTS));
 w.seal_by_hand();set_now(w.terms.opens_at);let owner=w.wallet(200*SOL);w.commit(&owner,60*SOL,0).unwrap();set_now(w.terms.deadline);w.settle(&owner).unwrap();
 w.bank.add_once(Acc::new(WSOL,TOKEN_PROGRAM,mint_data(u64::MAX/4,9,None,None)));w.launch().unwrap();
 w.fee_setup();w.fees_init().unwrap();set_pool_harvest(&w,0,33_600_000_000);w.fees_collect(9).unwrap();w.fees_distribute().unwrap();
 let now=w.campaign().state.launch_time;set_now(now);let cpis=cpi_count();
 assert_eq!(w.fees_buy_burn(1,1_000,1,now+60,&route_v2(1_000,100,100),&[]).unwrap_err(),err(E_MODE_PARENTS),"refused as a parent, before the reference read and the route");
 assert_eq!(cpi_count(),cpis);assert_eq!(w.fee_state().spent_b,0);
}

// --- Accounting version and receipt accounted flag (funding-first serialization, 28 September 2026) ---
#[test]
fn accounting_version_and_accounted_flag_survive_every_write_and_stay_zero_for_existing_records(){
 let creator=Pubkey::new_unique();let terms=standard_terms(creator,7,1_700_000_000);let(_,bump)=terms.campaign_address(&Pubkey::new_unique());
 // Existing record: version 0, reserved bytes zero, byte-identical after decode + encode, and after a mutation.
 let c=Campaign::fresh(terms,bump);let mut d=vec![0u8;CAMPAIGN_LEN];c.encode(&mut d);
 assert_eq!(d[OFF_ACCOUNTING_VERSION],ACCOUNTING_VERSION_ORIGINAL);assert!(d[OFF_RESERVED..].iter().all(|b|*b==0));
 let decoded=Campaign::decode(&d).unwrap();assert_eq!(decoded.state.accounting_version,ACCOUNTING_VERSION_ORIGINAL);
 let mut again=vec![0u8;CAMPAIGN_LEN];decoded.encode(&mut again);assert_eq!(again,d,"existing records re-encode byte for byte");
 // A record that was written by an older binary with garbage in the reserved tail decodes to the first byte only.
 // Funding-first record: the marker survives decode, mutation and re-encode by any handler path that uses write().
 let mut v2=c;v2.state.accounting_version=ACCOUNTING_VERSION_FUNDING_FIRST;let mut e=vec![0u8;CAMPAIGN_LEN];v2.encode(&mut e);
 assert_eq!(e[OFF_ACCOUNTING_VERSION],ACCOUNTING_VERSION_FUNDING_FIRST);assert!(e[OFF_ACCOUNTING_VERSION+1..].iter().all(|b|*b==0));
 let mut moved=Campaign::decode(&e).unwrap();assert_eq!(moved.state.accounting_version,ACCOUNTING_VERSION_FUNDING_FIRST);
 moved.state.total=5;moved.state.receipt_count=1;let mut f=vec![0u8;CAMPAIGN_LEN];moved.encode(&mut f);
 assert_eq!(f[OFF_ACCOUNTING_VERSION],ACCOUNTING_VERSION_FUNDING_FIRST,"a commit-style write keeps the marker");
 assert_eq!(Campaign::decode(&f).unwrap().state.terms_hash,c.state.terms_hash,"the sealed region and its hash are untouched");
 // Receipt: the accounted flag is a decoded field; existing receipts (byte 115 zero) decode accounted=false and re-encode identically.
 let campaign=Pubkey::new_unique();let owner=Pubkey::new_unique();let(_,rb)=Receipt::address(&Pubkey::new_unique(),&campaign,&owner);
 let r=Receipt::new(campaign,owner,rb);let mut rd=vec![0u8;RECEIPT_LEN];r.encode(&mut rd);assert_eq!(rd[OFF_RECEIPT_ACCOUNTED],0);
 let back=Receipt::decode(&rd).unwrap();assert!(!back.accounted);let mut rd2=vec![0u8;RECEIPT_LEN];back.encode(&mut rd2);assert_eq!(rd2,rd);
 let mut acc=r;acc.accounted=true;acc.committed=9;let mut re=vec![0u8;RECEIPT_LEN];acc.encode(&mut re);assert_eq!(re[OFF_RECEIPT_ACCOUNTED],1);
 let mut later=Receipt::decode(&re).unwrap();assert!(later.accounted);later.refunded=3;let mut re2=vec![0u8;RECEIPT_LEN];later.encode(&mut re2);
 assert_eq!(re2[OFF_RECEIPT_ACCOUNTED],1,"a refund-style write keeps the accounted flag");assert!(re2[OFF_RECEIPT_ACCOUNTED+1..].iter().all(|b|*b==0));
}
