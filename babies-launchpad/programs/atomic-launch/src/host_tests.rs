//! Host-side handler tests for the campaign layout, tag 0, tag 6 account parsing, the activation CPI, the claim
//! refusals, the parent claim window (tags 10 and 11) and the fee handlers (tags 23 and 27). A syscall stub serves
//! the clock and rent and logs every CPI. By default it refuses the CPI with `HOST_CPI_UNSUPPORTED`, so a handler
//! that reaches its first CPI has passed every check before it. With `simulate_token_cpis(true)` it applies Token
//! transfers and burns and the CPMM swap to the passed accounts, so the state a handler writes after its CPIs can be
//! read back.
use super::*;
use launch::{activate_distribution,custody_after_activation,distribution_record_matches,launch_account_count,share,vault_allocations,verify_activation,DISTRIBUTION_LEN,LAUNCH_ACCOUNTS,LAUNCH_ACCOUNTS_WITH_DISTRIBUTION,LIQUIDITY_BPS};
use solana_program::{instruction::Instruction,program_stubs::{set_syscall_stubs,SyscallStubs}};
use std::cell::RefCell;
use std::sync::Once;
const HOST_CPI_UNSUPPORTED:u32=0xF00D;
const TOKEN:Pubkey=solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA:Pubkey=solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CPMM:Pubkey=solana_program::pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const WSOL:Pubkey=solana_program::pubkey!("So11111111111111111111111111111111111111112");
/// Raydium's mainnet 2.5 % tier, the one the live campaign's pool uses.
const MAINNET_CONFIG:Pubkey=solana_program::pubkey!("ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi");
const TOKEN_TRANSFER:u8=3;
const TOKEN_BURN:u8=8;
/// One logged CPI: the instruction and the keys the caller signed for through seeds.
struct LoggedCpi{instruction:Instruction,signed_by_seeds:Vec<Pubkey>}
thread_local!{static NOW:RefCell<i64>=RefCell::new(0);static PROGRAM:RefCell<Pubkey>=RefCell::new(Pubkey::default());static CPI_LOG:RefCell<Vec<LoggedCpi>>=RefCell::new(vec![]);static SIMULATE:RefCell<bool>=RefCell::new(false);static SWAP_FILL:RefCell<u64>=RefCell::new(0);}
struct HostStubs;
impl SyscallStubs for HostStubs{
 fn sol_log(&self,_message:&str){}
 fn sol_get_clock_sysvar(&self,var_addr:*mut u8)->u64{let clock=Clock{unix_timestamp:NOW.with(|n|*n.borrow()),..Clock::default()};unsafe{std::ptr::write(var_addr as *mut Clock,clock)};0}
 fn sol_get_rent_sysvar(&self,var_addr:*mut u8)->u64{unsafe{std::ptr::write(var_addr as *mut Rent,Rent::default())};0}
 fn sol_invoke_signed(&self,instruction:&Instruction,infos:&[AccountInfo],signers_seeds:&[&[&[u8]]])->ProgramResult{
  let program=PROGRAM.with(|p|*p.borrow());
  let signed_by_seeds=signers_seeds.iter().filter_map(|seeds|Pubkey::create_program_address(seeds,&program).ok()).collect();
  CPI_LOG.with(|l|l.borrow_mut().push(LoggedCpi{instruction:instruction.clone(),signed_by_seeds}));
  if SIMULATE.with(|s|*s.borrow()){simulate(instruction,infos)}else{Err(err(HOST_CPI_UNSUPPORTED))}
 }
}
/// Applies the token movements of a Token transfer or burn, or of a CPMM `swap_base_input` (the input custody pays the
/// input vault, the output vault pays the output custody `SWAP_FILL` units, or `min_out` when the fill is zero). Any other
/// CPI stays refused.
fn simulate(instruction:&Instruction,infos:&[AccountInfo])->ProgramResult{
 let account=|i:usize|infos.iter().find(|info|*info.key==instruction.accounts[i].pubkey).ok_or(err(HOST_CPI_UNSUPPORTED));
 let adjust=|i:usize,at:usize,delta:i128|->ProgramResult{let info=account(i)?;let mut d=info.try_borrow_mut_data()?;let n=u64::try_from(read64(&d,at)? as i128+delta).map_err(|_|err(HOST_CPI_UNSUPPORTED))?;put64(&mut d,at,n);Ok(())};
 let data=&instruction.data;
 if instruction.program_id==TOKEN&&data.len()==9&&data[0]==TOKEN_TRANSFER{let amount=read64(data,1)? as i128;adjust(0,64,-amount)?;return adjust(1,64,amount)}
 if instruction.program_id==TOKEN&&data.len()==9&&data[0]==TOKEN_BURN{let amount=read64(data,1)? as i128;adjust(0,64,-amount)?;return adjust(1,36,-amount)}
 if instruction.program_id==CPMM&&data.len()==24&&data[..8]==solana_program::hash::hash(b"global:swap_base_input").to_bytes()[..8]{
  let amount=read64(data,8)? as i128;let min_out=read64(data,16)?;let fill=SWAP_FILL.with(|f|*f.borrow());let fill=if fill==0{min_out}else{fill} as i128;
  adjust(4,64,-amount)?;adjust(6,64,amount)?;adjust(7,64,-fill)?;return adjust(5,64,fill)
 }
 Err(err(HOST_CPI_UNSUPPORTED))
}
static INSTALL:Once=Once::new();
pub(super) fn install(program:&Pubkey,now:i64){INSTALL.call_once(||{set_syscall_stubs(Box::new(HostStubs));});PROGRAM.with(|p|*p.borrow_mut()=*program);NOW.with(|n|*n.borrow_mut()=now);CPI_LOG.with(|l|l.borrow_mut().clear());SIMULATE.with(|s|*s.borrow_mut()=false);SWAP_FILL.with(|f|*f.borrow_mut()=0);}
fn set_now(now:i64){NOW.with(|n|*n.borrow_mut()=now);}
fn simulate_token_cpis(on:bool){SIMULATE.with(|s|*s.borrow_mut()=on);}
fn set_swap_fill(fill:u64){SWAP_FILL.with(|f|*f.borrow_mut()=fill);}
fn cpi_count()->usize{CPI_LOG.with(|l|l.borrow().len())}
fn last_cpi()->(Instruction,Vec<Pubkey>){CPI_LOG.with(|l|{let l=l.borrow();let last=l.last().expect("a CPI was logged");(last.instruction.clone(),last.signed_by_seeds.clone())})}
struct Acc{key:Pubkey,lamports:u64,data:Vec<u8>,owner:Pubkey,signer:bool,writable:bool,executable:bool}
impl Acc{
 fn new(key:Pubkey,owner:Pubkey,data:Vec<u8>)->Self{Self{key,lamports:1_000_000_000,data,owner,signer:false,writable:true,executable:false}}
 fn signer(mut self)->Self{self.signer=true;self}
 fn empty(key:Pubkey)->Self{let mut a=Self::new(key,system_program::id(),vec![]);a.lamports=0;a}
 fn program(key:Pubkey,owner:Pubkey)->Self{let mut a=Self::new(key,owner,vec![]);a.executable=true;a.writable=false;a}
}
fn infos<'a>(accounts:&'a mut [Acc])->Vec<AccountInfo<'a>>{accounts.iter_mut().map(|a|AccountInfo::new(&a.key,a.signer,a.writable,&mut a.lamports,&mut a.data,&a.owner,a.executable,0)).collect()}
fn mint_data(supply:u64,authority:Option<&Pubkey>)->Vec<u8>{let mut d=vec![0u8;82];if let Some(k)=authority{d[..4].copy_from_slice(&[1,0,0,0]);d[4..36].copy_from_slice(k.as_ref());}put64(&mut d,36,supply);d[44]=6;d[45]=1;d}
fn token_data(mint:&Pubkey,owner:&Pubkey,amount:u64)->Vec<u8>{let mut d=vec![0u8;165];d[..32].copy_from_slice(mint.as_ref());d[32..64].copy_from_slice(owner.as_ref());put64(&mut d,64,amount);d[108]=1;d}
fn ata_key(owner:&Pubkey,mint:&Pubkey)->Pubkey{Pubkey::find_program_address(&[owner.as_ref(),TOKEN.as_ref(),mint.as_ref()],&ATA).0}
const LAUNCH_NOW:i64=1_760_000_000;
/// A campaign at the launch boundary: funding closed, one settled receipt, parents configured.
struct World{program:Pubkey,campaign_key:Pubkey,campaign:Campaign,authority:Pubkey,distribution_program:Pubkey}
impl World{
 fn new(distribution_program:Option<Pubkey>)->Self{
  let program=Pubkey::new_unique();let creator=Pubkey::new_unique();let nonce=9u64;
  let (campaign_key,bump)=Pubkey::find_program_address(&[b"campaign",creator.as_ref(),&nonce.to_le_bytes()],&program);
  let authority=Pubkey::find_program_address(&[b"launch_authority",campaign_key.as_ref()],&program).0;
  let distribution_program=distribution_program.unwrap_or_default();
  let campaign=Campaign{creator,nonce,soft:1_000_000_000,hard:3_000_000_000,deadline:LAUNCH_NOW-100,launch_deadline:LAUNCH_NOW+100,total:2_000_000_000,refunded:0,phase:1,bump,receipt_count:1,settled_count:1,settled_accepted:2_000_000_000,child_mint:Pubkey::new_unique(),supply:FIXED_SUPPLY,dev:Pubkey::new_unique(),treasury:Pubkey::new_unique(),launch_time:0,pool:Pubkey::default(),fee_nft:Pubkey::default(),distribution_program,distribution_activated:false};
  install(&program,LAUNCH_NOW);
  Self{program,campaign_key,campaign,authority,distribution_program}
 }
 fn campaign_acc(&self,c:&Campaign)->Acc{let mut acc=Acc::new(self.campaign_key,self.program,vec![0u8;CAMPAIGN_LEN]);{let i=infos(std::slice::from_mut(&mut acc));c.write(&i[0]).unwrap();}acc.data[98]=1;acc}
 fn launched(&self)->Campaign{let mut c=self.campaign;c.phase=3;c.launch_time=LAUNCH_NOW;c.pool=Pubkey::new_unique();c.fee_nft=Pubkey::new_unique();c}
 fn parents_key(&self)->Pubkey{Pubkey::find_program_address(&[b"parents",self.campaign_key.as_ref()],&self.program).0}
 fn distribution_key(&self)->Pubkey{Pubkey::find_program_address(&[b"distribution",self.campaign_key.as_ref()],&self.distribution_program).0}
 fn vault_authority(&self,purpose:u8)->Pubkey{Pubkey::find_program_address(&[b"vault",self.campaign_key.as_ref(),&[purpose]],&self.distribution_program).0}
 fn vault_key(&self,purpose:u8)->Pubkey{ata_key(&self.vault_authority(purpose),&self.campaign.child_mint)}
 /// The 40 accounts of a tag 6 call for a campaign with a distribution, as they stand right after the LP lock:
 /// custody holds everything but the liquidity share, the mint has no authorities, the vaults exist and are empty.
 fn launch_accounts(&self,c:&Campaign)->Vec<Acc>{
  let mut a:Vec<Acc>=(0..LAUNCH_ACCOUNTS_WITH_DISTRIBUTION).map(|_|Acc::empty(Pubkey::new_unique())).collect();
  a[0]=self.campaign_acc(c);a[1]=Acc::empty(Pubkey::new_unique()).signer();a[2]=Acc::empty(self.authority);
  a[3]=Acc::new(c.child_mint,TOKEN,mint_data(c.supply,None));
  a[4]=Acc::new(ata_key(&self.authority,&c.child_mint),TOKEN,token_data(&c.child_mint,&self.authority,c.supply-share(c.supply,LIQUIDITY_BPS)));
  a[6]=Acc::empty(Pubkey::new_unique()).signer();
  a[11]=Acc::program(TOKEN,BPF_LOADER_UPGRADEABLE);a[12]=Acc::program(ATA,BPF_LOADER_UPGRADEABLE);a[13]=Acc::program(system_program::id(),Pubkey::default());
  a[29]=Acc::program(self.distribution_program,BPF_LOADER_UPGRADEABLE);
  a[30]=Acc::new(self.parents_key(),self.program,vec![0u8;256]);
  a[31]=Acc::empty(self.distribution_key());
  for purpose in 0..4u8{a[32+purpose as usize]=Acc::empty(self.vault_authority(purpose));a[36+purpose as usize]=Acc::new(self.vault_key(purpose),TOKEN,token_data(&c.child_mint,&self.vault_authority(purpose),0));}
  a
 }
 /// Distribution record as kids-distribution writes it at activation (offsets from its README).
 fn distribution_record(&self,c:&Campaign)->Vec<u8>{
  let mut d=vec![0u8;DISTRIBUTION_LEN];d[..8].copy_from_slice(b"KIDSDST1");d[8..40].copy_from_slice(self.campaign_key.as_ref());d[40..72].copy_from_slice(c.child_mint.as_ref());d[72..104].copy_from_slice(self.program.as_ref());
  put64(&mut d,104,c.supply);put64(&mut d,120,c.launch_time as u64);for (p,n) in vault_allocations(c.supply).iter().enumerate(){put64(&mut d,248+8*p,*n);}d[336]=1;d
 }
}
fn run(w:&World,accounts:&mut [Acc],data:&[u8])->ProgramResult{PROGRAM.with(|p|*p.borrow_mut()=w.program);let infos=infos(accounts);process_instruction(&w.program,&infos,data)}
fn init_body(nonce:u64,supply:u64,deadline:i64)->Vec<u8>{
 let mut b=vec![0u8;144];put64(&mut b,0,nonce);put64(&mut b,8,1_000_000_000);put64(&mut b,16,3_000_000_000);put64(&mut b,24,deadline as u64);put64(&mut b,32,(deadline+3600) as u64);
 b[40..72].copy_from_slice(Pubkey::new_unique().as_ref());put64(&mut b,72,supply);b[80..112].copy_from_slice(Pubkey::new_unique().as_ref());b[112..144].copy_from_slice(Pubkey::new_unique().as_ref());b
}
#[test]fn campaign_layout_records_the_distribution_program_at_312_and_the_activation_flag_at_344(){
 let w=World::new(Some(Pubkey::new_unique()));let mut c=w.launched();c.distribution_activated=true;
 let mut acc=Acc::new(w.campaign_key,w.program,vec![0u8;CAMPAIGN_LEN]);acc.data[98]=1;put64(&mut acc.data,304,77);
 {let i=infos(std::slice::from_mut(&mut acc));c.write(&i[0]).unwrap();}
 assert_eq!(&acc.data[OFF_DISTRIBUTION_PROGRAM..OFF_DISTRIBUTION_PROGRAM+32],w.distribution_program.as_ref());assert_eq!(OFF_DISTRIBUTION_PROGRAM,312);
 assert_eq!(acc.data[OFF_DISTRIBUTION_ACTIVATED],1);assert_eq!(OFF_DISTRIBUTION_ACTIVATED,344);
 assert_eq!(acc.data[98],1);assert_eq!(read64(&acc.data,304).unwrap(),77,"write leaves the parents flag and the dev counter alone");
 assert!(acc.data[345..].iter().all(|b|*b==0),"nothing else is written above 344");
 assert_eq!(&acc.data[272..304],c.fee_nft.as_ref());
 {let i=infos(std::slice::from_mut(&mut acc));assert_eq!(Campaign::read(&i[0],&w.program).unwrap(),c);}
 acc.data[312..344].fill(0);acc.data[344]=0;
 {let i=infos(std::slice::from_mut(&mut acc));let read=Campaign::read(&i[0],&w.program).unwrap();assert_eq!(read.distribution_program,Pubkey::default(),"an all-zero region means no distribution");assert!(!read.distribution_activated);read.refuse_claims_after_activation().unwrap();}
 acc.data[344]=7;
 {let i=infos(std::slice::from_mut(&mut acc));let read=Campaign::read(&i[0],&w.program).unwrap();assert!(read.distribution_activated,"any non-zero byte at 344 counts as activated");assert_eq!(read.refuse_claims_after_activation().unwrap_err(),err(E_DISTRIBUTION_ACTIVATED));}
}
#[test]fn init_campaign_takes_an_optional_distribution_program_and_records_it(){
 let program=Pubkey::new_unique();install(&program,LAUNCH_NOW);let creator=Pubkey::new_unique();
 let body=init_body(1,FIXED_SUPPLY,LAUNCH_NOW+600);
 let (campaign_key,bump)=Pubkey::find_program_address(&[b"campaign",creator.as_ref(),&1u64.to_le_bytes()],&program);
 let base=||vec![Acc::empty(creator).signer(),Acc::empty(campaign_key),Acc::program(system_program::id(),Pubkey::default())];
 let data=[vec![0u8],body.clone()].concat();
 let call=|accounts:&mut Vec<Acc>|{let i=infos(accounts);process_instruction(&program,&i,&data)};
 let distribution=Pubkey::new_unique();
 let mut without=base();assert_eq!(call(&mut without).unwrap_err(),err(HOST_CPI_UNSUPPORTED),"three accounts: every check passed up to campaign creation");
 let mut with=base();with.push(Acc::program(distribution,BPF_LOADER_UPGRADEABLE));assert_eq!(call(&mut with).unwrap_err(),err(HOST_CPI_UNSUPPORTED),"four accounts: an executable upgradeable-loader program is accepted");
 let mut not_executable=base();not_executable.push(Acc::new(distribution,BPF_LOADER_UPGRADEABLE,vec![]));assert_eq!(call(&mut not_executable).unwrap_err(),err(E_DISTRIBUTION_PROGRAM_INVALID));
 let mut wrong_loader=base();wrong_loader.push(Acc::program(distribution,Pubkey::new_unique()));assert_eq!(call(&mut wrong_loader).unwrap_err(),err(E_DISTRIBUTION_PROGRAM_INVALID));
 let mut system_account=base();system_account.push(Acc::empty(distribution));assert_eq!(call(&mut system_account).unwrap_err(),err(E_DISTRIBUTION_PROGRAM_INVALID));
 let mut itself=base();itself.push(Acc::program(program,BPF_LOADER_UPGRADEABLE));assert_eq!(call(&mut itself).unwrap_err(),err(E_DISTRIBUTION_PROGRAM_INVALID),"the launch program cannot be its own distribution");
 let mut five=base();five.push(Acc::program(distribution,BPF_LOADER_UPGRADEABLE));five.push(Acc::empty(Pubkey::new_unique()));assert_eq!(call(&mut five).unwrap_err(),err(E_DISTRIBUTION_PROGRAM_INVALID),"a fifth account is refused");
 let mut extra=vec![Acc::program(distribution,BPF_LOADER_UPGRADEABLE)];
 {let i=infos(&mut extra);assert_eq!(distribution_program_of(&program,Some(&i[0])).unwrap(),distribution);}
 assert_eq!(distribution_program_of(&program,None).unwrap(),Pubkey::default());
 let recorded=campaign_terms(&creator,bump,&body,distribution,LAUNCH_NOW).unwrap();
 assert_eq!(recorded.distribution_program,distribution);assert!(!recorded.distribution_activated);assert_eq!(recorded.supply,FIXED_SUPPLY);assert_eq!(recorded.phase,0);assert_eq!(recorded.deadline,LAUNCH_NOW+600);
 assert_eq!(campaign_terms(&creator,bump,&body,Pubkey::default(),LAUNCH_NOW).unwrap().distribution_program,Pubkey::default());
 assert_eq!(campaign_terms(&creator,bump,&init_body(1,FIXED_SUPPLY-1,LAUNCH_NOW+600),distribution,LAUNCH_NOW).unwrap_err(),err(20));
 assert_eq!(campaign_terms(&creator,bump,&body,distribution,LAUNCH_NOW+600).unwrap_err(),err(1),"deadline must be in the future");
 assert_eq!(campaign_terms(&creator,bump,&body,distribution,LAUNCH_NOW+599).unwrap().deadline,LAUNCH_NOW+600);
}
#[test]fn launch_account_count_is_29_without_a_distribution_and_40_with_one(){
 let plain=World::new(None);assert_eq!(launch_account_count(&plain.campaign),LAUNCH_ACCOUNTS);assert_eq!(LAUNCH_ACCOUNTS,29);
 let vaulted=World::new(Some(Pubkey::new_unique()));assert_eq!(launch_account_count(&vaulted.campaign),LAUNCH_ACCOUNTS_WITH_DISTRIBUTION);assert_eq!(LAUNCH_ACCOUNTS_WITH_DISTRIBUTION,40);
 let accounts=|w:&World,n:usize|{let mut a:Vec<Acc>=(0..n).map(|_|Acc::empty(Pubkey::new_unique())).collect();a[0]=w.campaign_acc(&w.campaign);a};
 for (w,good,bad) in [(&plain,29usize,40usize),(&vaulted,40,29)]{
  let mut right=accounts(w,good);assert_eq!(run(w,&mut right,&[6]).unwrap_err(),err(21),"{good} accounts: parsing passed, the unsigned keeper fails the next check");
  for n in [bad,good-1,good+1,1]{let mut wrong=accounts(w,n);assert_eq!(run(w,&mut wrong,&[6]).unwrap_err(),err(E_LAUNCH_ACCOUNT_COUNT),"{n} accounts");}
  let mut body=accounts(w,good);assert_eq!(run(w,&mut body,&[6,0]).unwrap_err(),err(21),"tag 6 takes no body");
 }
 let mut none:Vec<Acc>=vec![];assert_eq!(run(&plain,&mut none,&[6]).unwrap_err(),ProgramError::NotEnoughAccountKeys);
 assert_eq!(cpi_count(),0);
}
#[test]fn activation_cpi_carries_the_exact_account_list_and_is_signed_by_the_launch_authority(){
 let w=World::new(Some(Pubkey::new_unique()));let c=w.launched();
 let bump=Pubkey::find_program_address(&[b"launch_authority",w.campaign_key.as_ref()],&w.program).1;
 let bump_seed=[bump];let seeds:&[&[u8]]=&[b"launch_authority",w.campaign_key.as_ref(),&bump_seed];
 let activate=|accounts:&mut Vec<Acc>|{let i=infos(accounts);activate_distribution(&w.program,&i,&c,&w.authority,seeds)};
 let mut valid=w.launch_accounts(&c);
 assert_eq!(activate(&mut valid).unwrap_err(),err(HOST_CPI_UNSUPPORTED),"every check before the CPI passed");
 let (instruction,signed)=last_cpi();
 assert_eq!(instruction.program_id,w.distribution_program);
 assert_eq!(instruction.data,[vec![0u8],vec![0u8;32]].concat(),"tag 0 with prior counters all zero");
 assert_eq!(signed,vec![w.authority],"the launch authority signs through its seeds");
 let expected:[(Pubkey,bool,bool);17]=[(w.authority,true,false),(valid[1].key,true,true),(w.campaign_key,false,false),(w.parents_key(),false,false),(c.child_mint,false,true),(valid[4].key,false,true),(w.distribution_key(),false,true),
  (w.vault_authority(0),false,false),(w.vault_authority(1),false,false),(w.vault_authority(2),false,false),(w.vault_authority(3),false,false),
  (w.vault_key(0),false,true),(w.vault_key(1),false,true),(w.vault_key(2),false,true),(w.vault_key(3),false,true),(TOKEN,false,false),(system_program::id(),false,false)];
 assert_eq!(instruction.accounts.len(),17);
 assert!(!instruction.accounts.iter().any(|meta|meta.pubkey==ATA),"activate takes no Associated Token program: the vaults already exist");
 for (index,(key,signer,writable)) in expected.iter().enumerate(){let meta=&instruction.accounts[index];assert_eq!((meta.pubkey,meta.is_signer,meta.is_writable),(*key,*signer,*writable),"activate account {index}");}
 let count=cpi_count();
 let mut wrong_program=w.launch_accounts(&c);wrong_program[29]=Acc::program(Pubkey::new_unique(),BPF_LOADER_UPGRADEABLE);assert_eq!(activate(&mut wrong_program).unwrap_err(),err(E_DISTRIBUTION_PROGRAM_INVALID),"the program must be the recorded one");
 let mut not_executable=w.launch_accounts(&c);not_executable[29].executable=false;assert_eq!(activate(&mut not_executable).unwrap_err(),err(E_DISTRIBUTION_PROGRAM_INVALID));
 let mut wrong_parents=w.launch_accounts(&c);wrong_parents[30].key=Pubkey::new_unique();assert_eq!(activate(&mut wrong_parents).unwrap_err(),err(21));
 let mut foreign_parents=w.launch_accounts(&c);foreign_parents[30].owner=Pubkey::new_unique();assert_eq!(activate(&mut foreign_parents).unwrap_err(),err(21));
 let mut wrong_distribution=w.launch_accounts(&c);wrong_distribution[31].key=Pubkey::new_unique();assert_eq!(activate(&mut wrong_distribution).unwrap_err(),err(21));
 let mut existing_distribution=w.launch_accounts(&c);existing_distribution[31]=Acc::new(w.distribution_key(),w.distribution_program,vec![0u8;DISTRIBUTION_LEN]);assert_eq!(activate(&mut existing_distribution).unwrap_err(),err(21),"an existing record means activation already ran");
 let mut swapped_authorities=w.launch_accounts(&c);swapped_authorities[33]=Acc::empty(w.vault_authority(2));assert_eq!(activate(&mut swapped_authorities).unwrap_err(),err(21));
 let mut wrong_vault=w.launch_accounts(&c);wrong_vault[38]=Acc::empty(ata_key(&w.vault_authority(2),&Pubkey::new_unique()));assert_eq!(activate(&mut wrong_vault).unwrap_err(),err(21),"vault must be the authority's ATA for the child mint");
 let mut custody_as_vault=w.launch_accounts(&c);custody_as_vault[32]=Acc::empty(w.authority);custody_as_vault[36]=Acc::empty(ata_key(&w.authority,&c.child_mint));assert_eq!(activate(&mut custody_as_vault).unwrap_err(),err(21),"custody cannot pose as a vault");
 for purpose in 0..4usize{let mut missing=w.launch_accounts(&c);missing[36+purpose]=Acc::empty(w.vault_key(purpose as u8));assert_eq!(activate(&mut missing).unwrap_err(),err(E_VAULT_NOT_CREATED),"vault {purpose} not created before the launch");}
 let mut foreign_vault=w.launch_accounts(&c);foreign_vault[37].owner=Pubkey::new_unique();assert_eq!(activate(&mut foreign_vault).unwrap_err(),err(21),"a vault under another program is invalid, not missing");
 let mut delegated_vault=w.launch_accounts(&c);delegated_vault[38].data[72]=1;assert_eq!(activate(&mut delegated_vault).unwrap_err(),err(21));
 let mut closable_vault=w.launch_accounts(&c);closable_vault[39].data[129]=1;assert_eq!(activate(&mut closable_vault).unwrap_err(),err(21));
 let mut uninitialised_vault=w.launch_accounts(&c);uninitialised_vault[36].data[108]=0;assert_eq!(activate(&mut uninitialised_vault).unwrap_err(),err(21));
 let mut other_owner=w.launch_accounts(&c);other_owner[36].data=token_data(&c.child_mint,&Pubkey::new_unique(),0);assert_eq!(activate(&mut other_owner).unwrap_err(),err(21));
 assert_eq!(cpi_count(),count,"no refused activation reached the CPI");
}
#[test]fn verification_after_activation_reads_back_custody_vaults_mint_and_record(){
 let w=World::new(Some(Pubkey::new_unique()));let c=w.launched();let allocation=vault_allocations(c.supply);
 let authorities:[Pubkey;4]=std::array::from_fn(|p|w.vault_authority(p as u8));
 let activated=|w:&World|{
  let mut a=w.launch_accounts(&c);
  a[4].data=token_data(&c.child_mint,&w.authority,custody_after_activation(c.supply).unwrap());
  for purpose in 0..4u8{a[36+purpose as usize]=Acc::new(w.vault_key(purpose),TOKEN,token_data(&c.child_mint,&authorities[purpose as usize],allocation[purpose as usize]));}
  a[31]=Acc::new(w.distribution_key(),w.distribution_program,w.distribution_record(&c));a
 };
 let verify=|accounts:&mut Vec<Acc>|{let i=infos(accounts);verify_activation(&w.program,&i,&c,&w.authority,&authorities)};
 let mut good=activated(&w);verify(&mut good).unwrap();
 assert_eq!(read64(&good[4].data,64).unwrap(),0,"the fixed supply leaves no dust in custody");
 let mut custody_left=activated(&w);custody_left[4].data=token_data(&c.child_mint,&w.authority,1);assert_eq!(verify(&mut custody_left).unwrap_err(),err(E_DISTRIBUTION_FUNDING_MISMATCH));
 let mut short_vault=activated(&w);put64(&mut short_vault[37].data,64,allocation[1]-1);assert_eq!(verify(&mut short_vault).unwrap_err(),err(E_DISTRIBUTION_FUNDING_MISMATCH));
 let mut over_vault=activated(&w);put64(&mut over_vault[39].data,64,allocation[3]+1);assert_eq!(verify(&mut over_vault).unwrap_err(),err(E_DISTRIBUTION_FUNDING_MISMATCH));
 let mut delegated_vault=activated(&w);delegated_vault[36].data[72]=1;assert_eq!(verify(&mut delegated_vault).unwrap_err(),err(21));
 let mut lower_supply=activated(&w);put64(&mut lower_supply[3].data,36,c.supply-1);assert_eq!(verify(&mut lower_supply).unwrap_err(),err(21),"the mint supply must still be the original");
 let mut mint_authority=activated(&w);mint_authority[3].data=mint_data(c.supply,Some(&w.authority));assert_eq!(verify(&mut mint_authority).unwrap_err(),err(21));
 let mut freeze_authority=activated(&w);freeze_authority[3].data[46..50].copy_from_slice(&[1,0,0,0]);assert_eq!(verify(&mut freeze_authority).unwrap_err(),err(E_DISTRIBUTION_FUNDING_MISMATCH));
 let mut foreign_record=activated(&w);foreign_record[31].owner=Pubkey::new_unique();assert_eq!(verify(&mut foreign_record).unwrap_err(),err(E_DISTRIBUTION_FUNDING_MISMATCH));
 let record=w.distribution_record(&c);distribution_record_matches(&record,&w.campaign_key,&c,&w.program,&allocation).unwrap();
 for (at,label) in [(0usize,"magic"),(8,"campaign"),(40,"mint"),(72,"launch program"),(104,"supply"),(248,"allocation 0"),(256,"allocation 1"),(264,"allocation 2"),(272,"allocation 3")]{
  let mut mutated=record.clone();mutated[at]^=1;assert_eq!(distribution_record_matches(&mutated,&w.campaign_key,&c,&w.program,&allocation).unwrap_err(),err(E_DISTRIBUTION_FUNDING_MISMATCH),"{label}");
 }
 let mut inactive=record.clone();inactive[336]=0;assert_eq!(distribution_record_matches(&inactive,&w.campaign_key,&c,&w.program,&allocation).unwrap_err(),err(E_DISTRIBUTION_FUNDING_MISMATCH),"flag");
 assert_eq!(distribution_record_matches(&record[..500],&w.campaign_key,&c,&w.program,&allocation).unwrap_err(),err(E_DISTRIBUTION_FUNDING_MISMATCH),"length");
 let mut other_campaign=record.clone();other_campaign[8..40].copy_from_slice(Pubkey::new_unique().as_ref());assert!(distribution_record_matches(&other_campaign,&w.campaign_key,&c,&w.program,&allocation).is_err());
}
#[test]fn custody_claims_are_refused_once_the_distribution_is_activated(){
 let w=World::new(Some(Pubkey::new_unique()));let mut c=w.launched();c.distribution_activated=true;
 let mut open=w.launched();open.distribution_activated=false;
 let participant=|c:&Campaign|{let mut a:Vec<Acc>=(0..7).map(|_|Acc::empty(Pubkey::new_unique())).collect();a[0]=w.campaign_acc(c);a};
 let dev=|c:&Campaign|{let mut a:Vec<Acc>=(0..6).map(|_|Acc::empty(Pubkey::new_unique())).collect();a[0]=w.campaign_acc(c);a};
 let parent=|c:&Campaign|{let mut a:Vec<Acc>=(0..11).map(|_|Acc::empty(Pubkey::new_unique())).collect();a[0]=Acc::empty(Pubkey::new_unique()).signer();a[1]=w.campaign_acc(c);a};
 let parent_body=[vec![10u8,0],vec![0u8;17]].concat();
 assert_eq!(run(&w,&mut participant(&c),&[7]).unwrap_err(),err(E_DISTRIBUTION_ACTIVATED));
 assert_eq!(run(&w,&mut dev(&c),&[8]).unwrap_err(),err(E_DISTRIBUTION_ACTIVATED));
 assert_eq!(run(&w,&mut parent(&c),&parent_body).unwrap_err(),err(E_DISTRIBUTION_ACTIVATED));
 assert_eq!(cpi_count(),0,"nothing moved");
 assert_ne!(run(&w,&mut participant(&open),&[7]).unwrap_err(),err(E_DISTRIBUTION_ACTIVATED),"without the flag the custody claim proceeds to its own checks");
 assert_ne!(run(&w,&mut dev(&open),&[8]).unwrap_err(),err(E_DISTRIBUTION_ACTIVATED));
 assert_ne!(run(&w,&mut parent(&open),&parent_body).unwrap_err(),err(E_DISTRIBUTION_ACTIVATED));
 let mut vaulted_but_unlaunched=w.campaign;vaulted_but_unlaunched.distribution_activated=false;
 assert_ne!(run(&w,&mut dev(&vaulted_but_unlaunched),&[8]).unwrap_err(),err(E_DISTRIBUTION_ACTIVATED),"a recorded program alone does not refuse; only activation does");
 let mut configure:Vec<Acc>=(0..6).map(|_|Acc::empty(Pubkey::new_unique())).collect();configure[1]=w.campaign_acc(&c);
 assert_ne!(run(&w,&mut configure,&[vec![9u8],vec![0u8;88]].concat()).unwrap_err(),err(E_DISTRIBUTION_ACTIVATED),"tag 9 is unchanged");
}
#[test]fn vault_allocations_and_liquidity_sum_to_the_fixed_supply_with_zero_dust(){
 let allocation=vault_allocations(FIXED_SUPPLY);
 assert_eq!(allocation,[435_000_000_000_000,50_000_000_000_000,50_000_000_000_000,30_000_000_000_000]);
 assert_eq!(share(FIXED_SUPPLY,LIQUIDITY_BPS),435_000_000_000_000);
 assert_eq!(allocation.iter().sum::<u64>()+share(FIXED_SUPPLY,LIQUIDITY_BPS),FIXED_SUPPLY);
 assert_eq!(custody_after_activation(FIXED_SUPPLY).unwrap(),0);
 for supply in [10_000u64,10_001,19_999,123_456_789,u64::MAX]{
  let a=vault_allocations(supply);let total=a.iter().sum::<u64>()+share(supply,LIQUIDITY_BPS);
  assert_eq!(total+custody_after_activation(supply).unwrap(),supply,"supply {supply}");assert!(custody_after_activation(supply).unwrap()<10_000);
 }
 assert_eq!(custody_after_activation(7).unwrap(),7,"a supply below one share unit stays in custody in full");
}
const PARENT_SNAPSHOT_SUPPLY:u64=1_000_000;
/// KIDSPAR1 for the campaign with both parents at a 1,000,000 snapshot supply fully eligible, so a claimant holding the
/// whole snapshot is allocated the whole reserve. `claimed` and `burned` land at 208/216 and 224/232.
fn parents_data(w:&World,claimed:[u64;2],burned:[u64;2])->Vec<u8>{
 let mut d=vec![0u8;256];d[..8].copy_from_slice(b"KIDSPAR1");d[8..40].copy_from_slice(w.campaign_key.as_ref());
 d[40..72].copy_from_slice(&[0xA1;32]);d[72..104].copy_from_slice(&[0xB2;32]);
 for (at,n) in [(168,PARENT_SNAPSHOT_SUPPLY),(176,PARENT_SNAPSHOT_SUPPLY),(184,7),(192,PARENT_SNAPSHOT_SUPPLY),(200,PARENT_SNAPSHOT_SUPPLY),(208,claimed[0]),(216,claimed[1]),(224,burned[0]),(232,burned[1])]{put64(&mut d,at,n);}d
}
fn parent_reserve(c:&Campaign)->u64{c.supply/10000*500}
fn program_account(key:Pubkey)->Acc{Acc::program(key,BPF_LOADER_UPGRADEABLE)}
/// A tag 10 call whose proof (depth 0: the root is the leaf) is valid for parent A: 11 accounts and the 18-byte body.
fn parent_claim(w:&World,c:&Campaign)->(Vec<Acc>,Vec<u8>){
 let owner=Pubkey::new_unique();let allocation=parent_reserve(c);
 let mut parents=parents_data(w,[0,0],[0,0]);let root=claims::merkle(&w.campaign_key,0,&owner,PARENT_SNAPSHOT_SUPPLY,allocation,&[]);parents[104..136].copy_from_slice(&root);
 let claim=Pubkey::find_program_address(&[b"parent_claim",w.campaign_key.as_ref(),&[0],owner.as_ref()],&w.program).0;
 let accounts=vec![Acc::empty(Pubkey::new_unique()).signer(),w.campaign_acc(c),Acc::new(w.parents_key(),w.program,parents),Acc::empty(claim),Acc::empty(owner),Acc::empty(w.authority),
  Acc::new(c.child_mint,TOKEN,mint_data(c.supply,None)),Acc::new(ata_key(&w.authority,&c.child_mint),TOKEN,token_data(&c.child_mint,&w.authority,c.supply)),Acc::new(ata_key(&owner,&c.child_mint),TOKEN,token_data(&c.child_mint,&owner,0)),program_account(TOKEN),Acc::program(system_program::id(),Pubkey::default())];
 let mut body=vec![10u8,0];body.extend_from_slice(&PARENT_SNAPSHOT_SUPPLY.to_le_bytes());body.extend_from_slice(&allocation.to_le_bytes());body.push(0);
 (accounts,body)
}
/// Tag 11 accounts: custody holds everything but the liquidity share and what the parents already claimed.
fn burn_accounts(w:&World,c:&Campaign,claimed:[u64;2],burned:[u64;2])->Vec<Acc>{
 let custody=c.supply-share(c.supply,LIQUIDITY_BPS)-claimed[0]-claimed[1]-burned[0]-burned[1];
 vec![w.campaign_acc(c),Acc::new(w.parents_key(),w.program,parents_data(w,claimed,burned)),Acc::empty(w.authority),Acc::new(c.child_mint,TOKEN,mint_data(c.supply-burned[0]-burned[1],None)),Acc::new(ata_key(&w.authority,&c.child_mint),TOKEN,token_data(&c.child_mint,&w.authority,custody)),program_account(TOKEN)]
}
#[test]fn parent_claims_close_thirty_days_after_the_recorded_launch_time(){
 let w=World::new(None);let c=w.launched();let expires=LAUNCH_NOW+2_592_000;
 assert_eq!(PARENT_CLAIM_WINDOW,30*86_400);assert_eq!(c.parent_claims_expire_at().unwrap(),expires);
 assert_eq!(w.campaign.parent_claims_expire_at().unwrap_err(),err(10),"no launch time before the launch");
 let (mut open,body)=parent_claim(&w,&c);set_now(expires-1);
 assert_eq!(run(&w,&mut open,&body).unwrap_err(),err(HOST_CPI_UNSUPPORTED),"one second before the window closes every check passes up to the claim account creation");
 assert_eq!(last_cpi().0.program_id,system_program::id());let count=cpi_count();
 for now in [expires,expires+1,expires+30*86_400]{let (mut closed,body)=parent_claim(&w,&c);set_now(now);assert_eq!(run(&w,&mut closed,&body).unwrap_err(),err(E_PARENT_CLAIM_EXPIRED),"at {now}");}
 let (mut replay,body)=parent_claim(&w,&c);replay[3]=Acc::new(replay[3].key,w.program,vec![0u8;80]);set_now(expires);
 assert_eq!(run(&w,&mut replay,&body).unwrap_err(),err(E_PARENT_CLAIM_EXPIRED),"an existing claim account is refused the same way after the window");
 assert_eq!(cpi_count(),count,"nothing moved after the window");
 let mut participant:Vec<Acc>=(0..7).map(|_|Acc::empty(Pubkey::new_unique())).collect();participant[0]=w.campaign_acc(&c);
 let mut dev:Vec<Acc>=(0..6).map(|_|Acc::empty(Pubkey::new_unique())).collect();dev[0]=w.campaign_acc(&c);
 assert_ne!(run(&w,&mut participant,&[7]).unwrap_err(),err(E_PARENT_CLAIM_EXPIRED),"participant claims have no window");
 assert_ne!(run(&w,&mut dev,&[8]).unwrap_err(),err(E_PARENT_CLAIM_EXPIRED),"dev claims have no window");
}
#[test]fn expired_parent_reserves_burn_exactly_the_unclaimed_remainder_once(){
 let w=World::new(None);let c=w.launched();let expires=LAUNCH_NOW+2_592_000;let reserve=parent_reserve(&c);
 let claimed=[20_000_000_000_000u64,7_000_000_000_000];let remainder=[reserve-claimed[0],reserve-claimed[1]];
 let mut early=burn_accounts(&w,&c,claimed,[0,0]);set_now(expires-1);
 assert_eq!(run(&w,&mut early,&[11]).unwrap_err(),err(E_PARENT_CLAIM_WINDOW_OPEN));assert_eq!(cpi_count(),0);
 set_now(expires);
 let mut refused=burn_accounts(&w,&c,claimed,[0,0]);assert_eq!(run(&w,&mut refused,&[11]).unwrap_err(),err(HOST_CPI_UNSUPPORTED),"the burn CPI is the first CPI");
 assert_eq!(refused[1].data,parents_data(&w,claimed,[0,0]),"a failed burn records nothing");
 let (burn,signed)=last_cpi();assert_eq!(burn.program_id,TOKEN);assert_eq!(burn.data,[vec![TOKEN_BURN],(remainder[0]+remainder[1]).to_le_bytes().to_vec()].concat(),"exactly both remainders");
 assert_eq!(burn.accounts.iter().map(|m|(m.pubkey,m.is_signer,m.is_writable)).collect::<Vec<_>>(),vec![(ata_key(&w.authority,&c.child_mint),false,true),(c.child_mint,false,true),(w.authority,true,false)]);
 assert_eq!(signed,vec![w.authority]);
 simulate_token_cpis(true);let before=parents_data(&w,claimed,[0,0]);
 let mut accounts=burn_accounts(&w,&c,claimed,[0,0]);let custody=read64(&accounts[4].data,64).unwrap();let supply=read64(&accounts[3].data,36).unwrap();
 run(&w,&mut accounts,&[11]).unwrap();let count=cpi_count();
 assert_eq!(read64(&accounts[4].data,64).unwrap(),custody-remainder[0]-remainder[1],"custody lost the two remainders and nothing else");
 assert_eq!(read64(&accounts[3].data,36).unwrap(),supply-remainder[0]-remainder[1]);
 assert_eq!(&accounts[1].data[..224],&before[..224],"nothing below 224 changes");
 assert_eq!(read64(&accounts[1].data,224).unwrap(),remainder[0]);assert_eq!(read64(&accounts[1].data,232).unwrap(),remainder[1]);assert_eq!(read64(&accounts[1].data,240).unwrap(),expires as u64);
 assert!(accounts[1].data[248..].iter().all(|b|*b==0));
 let recorded=accounts[1].data.clone();set_now(expires+86_400);
 run(&w,&mut accounts,&[11]).unwrap();assert_eq!(cpi_count(),count,"a second call burns nothing");assert_eq!(accounts[1].data,recorded,"and keeps the first burn time");
 assert_eq!(read64(&accounts[4].data,64).unwrap(),custody-remainder[0]-remainder[1]);
 let mut resumed=burn_accounts(&w,&c,claimed,[remainder[0],0]);run(&w,&mut resumed,&[11]).unwrap();
 assert_eq!(last_cpi().0.data,[vec![TOKEN_BURN],remainder[1].to_le_bytes().to_vec()].concat(),"a parent already burned is skipped");
 assert_eq!((read64(&resumed[1].data,224).unwrap(),read64(&resumed[1].data,232).unwrap()),(remainder[0],remainder[1]));
 let count=cpi_count();let mut fully_claimed=burn_accounts(&w,&c,[reserve,reserve],[0,0]);run(&w,&mut fully_claimed,&[11]).unwrap();
 assert_eq!(cpi_count(),count,"fully claimed reserves leave nothing to burn");assert_eq!(read64(&fully_claimed[1].data,240).unwrap(),(expires+86_400) as u64);
 let good=||burn_accounts(&w,&c,claimed,[0,0]);
 let mut body=good();assert_eq!(run(&w,&mut body,&[11,0]).unwrap_err(),err(30));
 let mut wrong_parents=good();wrong_parents[1].key=Pubkey::new_unique();assert_eq!(run(&w,&mut wrong_parents,&[11]).unwrap_err(),err(30));
 let mut foreign_parents=good();foreign_parents[1].owner=Pubkey::new_unique();assert_eq!(run(&w,&mut foreign_parents,&[11]).unwrap_err(),err(30));
 let mut readonly_parents=good();readonly_parents[1].writable=false;assert_eq!(run(&w,&mut readonly_parents,&[11]).unwrap_err(),err(30));
 let mut other_campaign=good();other_campaign[1].data[8..40].copy_from_slice(Pubkey::new_unique().as_ref());assert_eq!(run(&w,&mut other_campaign,&[11]).unwrap_err(),err(30));
 let mut wrong_authority=good();wrong_authority[2]=Acc::empty(Pubkey::new_unique());assert_eq!(run(&w,&mut wrong_authority,&[11]).unwrap_err(),err(30));
 let mut wrong_mint=good();wrong_mint[3].key=Pubkey::new_unique();assert_eq!(run(&w,&mut wrong_mint,&[11]).unwrap_err(),err(30));
 let mut other_custody=good();let stranger=Pubkey::new_unique();other_custody[4]=Acc::new(ata_key(&stranger,&c.child_mint),TOKEN,token_data(&c.child_mint,&stranger,c.supply));assert_eq!(run(&w,&mut other_custody,&[11]).unwrap_err(),err(30),"only launch custody burns");
 let mut short_custody=good();put64(&mut short_custody[4].data,64,remainder[0]+remainder[1]-1);assert_eq!(run(&w,&mut short_custody,&[11]).unwrap_err(),err(30));
 let mut not_executable=good();not_executable[5].executable=false;assert_eq!(run(&w,&mut not_executable,&[11]).unwrap_err(),err(30));
 let mut activated=c;activated.distribution_activated=true;let mut vaulted=burn_accounts(&w,&activated,claimed,[0,0]);assert_eq!(run(&w,&mut vaulted,&[11]).unwrap_err(),err(E_DISTRIBUTION_ACTIVATED));
 let mut unlaunched=burn_accounts(&w,&w.campaign,claimed,[0,0]);assert_eq!(run(&w,&mut unlaunched,&[11]).unwrap_err(),err(30));
 assert_eq!(cpi_count(),count,"no refused call reached the burn");
}
#[test]fn retired_fee_tags_22_24_and_25_are_refused_before_any_check(){
 let w=World::new(None);let c=w.launched();
 for (tag,len) in [(22u8,16usize),(24,18),(25,20)]{
  let mut accounts:Vec<Acc>=(0..len).map(|_|Acc::empty(Pubkey::new_unique())).collect();accounts[0]=w.campaign_acc(&c);accounts[1]=Acc::empty(c.creator).signer();
  assert_eq!(run(&w,&mut accounts,&[vec![tag],vec![0u8;25]].concat()).unwrap_err(),ProgramError::InvalidInstructionData,"tag {tag}");
  assert_eq!(run(&w,&mut accounts,&[tag]).unwrap_err(),ProgramError::InvalidInstructionData,"tag {tag} without a body");
 }
 assert_eq!(cpi_count(),0);
}
/// Fee custody and the campaign's own CPMM pool for tags 23 and 27.
struct FeeWorld{authority:Pubkey,state_key:Pubkey,pool:Pubkey,vault_authority:Pubkey,forward:bool}
impl FeeWorld{
 fn new(w:&World,c:&Campaign)->Self{
  let (mint0,mint1)=if WSOL<c.child_mint{(WSOL,c.child_mint)}else{(c.child_mint,WSOL)};
  Self{authority:Pubkey::find_program_address(&[b"fee_authority",w.campaign_key.as_ref()],&w.program).0,state_key:Pubkey::find_program_address(&[b"fees",w.campaign_key.as_ref()],&w.program).0,
   pool:Pubkey::find_program_address(&[b"pool",MAINNET_CONFIG.as_ref(),mint0.as_ref(),mint1.as_ref()],&CPMM).0,vault_authority:Pubkey::find_program_address(&[b"vault_and_lp_mint_auth_seed"],&CPMM).0,forward:mint0==WSOL}
 }
 /// KIDSFEE1: child, total, treasury, dev, parent A, parent B, spent A, spent B, burned A, burned B, burned child at 40..128.
 fn state(&self,w:&World,counters:[u64;11])->Acc{let mut d=vec![0u8;128];d[..8].copy_from_slice(b"KIDSFEE1");d[8..40].copy_from_slice(w.campaign_key.as_ref());for (i,n) in counters.iter().enumerate(){put64(&mut d,40+8*i,*n);}Acc::new(self.state_key,w.program,d)}
 fn counters(acc:&Acc)->[u64;11]{std::array::from_fn(|i|read64(&acc.data,40+8*i).unwrap())}
 fn config()->Acc{let mut d=vec![0u8;236];d[..8].copy_from_slice(&solana_program::hash::hash(b"account:AmmConfig").to_bytes()[..8]);d[10..12].copy_from_slice(&7u16.to_le_bytes());put64(&mut d,12,25000);put64(&mut d,20,120000);put64(&mut d,28,40000);Acc::new(MAINNET_CONFIG,CPMM,d)}
 /// The 16 accounts of a tag 27 call: the pool holds `reserve_sol` lamports of WSOL and `reserve_child` raw coin units.
 fn buyback_accounts(&self,w:&World,c:&Campaign,counters:[u64;11],wsol_custody:u64,reserve_sol:u64,reserve_child:u64)->Vec<Acc>{
  let vault_sol=Pubkey::new_unique();let vault_child=Pubkey::new_unique();let observation=Pubkey::new_unique();
  let (vault0,vault1,mint0,mint1)=if self.forward{(vault_sol,vault_child,WSOL,c.child_mint)}else{(vault_child,vault_sol,c.child_mint,WSOL)};
  let mut pool=vec![0u8;637];pool[..8].copy_from_slice(&solana_program::hash::hash(b"account:PoolState").to_bytes()[..8]);
  for (i,key) in [MAINNET_CONFIG,Pubkey::new_unique(),vault0,vault1,Pubkey::new_unique(),mint0,mint1,TOKEN,TOKEN,observation].iter().enumerate(){pool[8+i*32..40+i*32].copy_from_slice(key.as_ref());}
  vec![w.campaign_acc(c),Acc::empty(c.creator).signer(),self.state(w,counters),Acc::empty(self.authority),
   Acc::new(ata_key(&self.authority,&WSOL),TOKEN,token_data(&WSOL,&self.authority,wsol_custody)),Acc::new(ata_key(&self.authority,&c.child_mint),TOKEN,token_data(&c.child_mint,&self.authority,counters[0])),
   Acc::new(self.pool,CPMM,pool),Self::config(),Acc::empty(self.vault_authority),
   Acc::new(vault_sol,TOKEN,token_data(&WSOL,&self.vault_authority,reserve_sol)),Acc::new(vault_child,TOKEN,token_data(&c.child_mint,&self.vault_authority,reserve_child)),
   Acc::new(WSOL,TOKEN,mint_data(reserve_sol,None)),Acc::new(c.child_mint,TOKEN,mint_data(c.supply,None)),Acc::empty(observation),Acc::program(CPMM,BPF_LOADER_UPGRADEABLE),program_account(TOKEN)]
 }
 /// The floor tag 27 enforces right now: 1 % under the spot quote from the two vault balances.
 fn floor(accounts:&[Acc],amount:u64)->u64{fees::quote_floor(amount,read64(&accounts[9].data,64).unwrap(),read64(&accounts[10].data,64).unwrap(),25000,fees::CHILD_BUYBACK_MAX_SLIPPAGE_BPS).unwrap()}
 fn body(amount:u64,min_out:u64,expiry:i64)->Vec<u8>{let mut b=vec![27u8];b.extend_from_slice(&amount.to_le_bytes());b.extend_from_slice(&min_out.to_le_bytes());b.extend_from_slice(&(expiry as u64).to_le_bytes());b}
}
const SOL:u64=1_000_000_000;
const BUDGET:[u64;11]=[0,1_200_000_000,0,0,200_000_000,1_000_000_000,0,0,0,0,0];
#[test]fn child_buyback_needs_the_campaign_pool_and_a_floor_one_percent_under_spot(){
 let w=World::new(None);let mut c=w.launched();let f=FeeWorld::new(&w,&c);c.pool=f.pool;
 let fixture=||f.buyback_accounts(&w,&c,BUDGET,1_200_000_000,10*SOL,400_000_000_000_000);
 let amount=SOL/2;let floor=FeeWorld::floor(&fixture(),amount);let expiry=LAUNCH_NOW+90;
 let mut low=fixture();assert_eq!(run(&w,&mut low,&FeeWorld::body(amount,floor-1,expiry)).unwrap_err(),err(60),"one unit under the floor is refused");assert_eq!(cpi_count(),0);
 let mut refused=fixture();assert_eq!(run(&w,&mut refused,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(HOST_CPI_UNSUPPORTED),"at the floor the swap is the first CPI");
 let (swap,signed)=last_cpi();assert_eq!(swap.program_id,CPMM);assert_eq!(swap.data,[solana_program::hash::hash(b"global:swap_base_input").to_bytes()[..8].to_vec(),amount.to_le_bytes().to_vec(),floor.to_le_bytes().to_vec()].concat());
 assert_eq!(signed,vec![f.authority]);assert_eq!(swap.accounts[3].pubkey,f.pool);assert_eq!(swap.accounts[4].pubkey,ata_key(&f.authority,&WSOL));assert_eq!(swap.accounts[5].pubkey,ata_key(&f.authority,&c.child_mint));
 assert_eq!(FeeWorld::counters(&refused[2]),BUDGET,"a failed swap books nothing");
 simulate_token_cpis(true);
 let mut accounts=fixture();let supply=read64(&accounts[12].data,36).unwrap();run(&w,&mut accounts,&FeeWorld::body(amount,floor,expiry)).unwrap();
 let (burn,signed)=last_cpi();assert_eq!(burn.program_id,TOKEN);assert_eq!(burn.data,[vec![TOKEN_BURN],floor.to_le_bytes().to_vec()].concat(),"every received unit is burned");
 assert_eq!(burn.accounts.iter().map(|m|m.pubkey).collect::<Vec<_>>(),vec![ata_key(&f.authority,&c.child_mint),c.child_mint,f.authority]);assert_eq!(signed,vec![f.authority]);
 assert_eq!(FeeWorld::counters(&accounts[2]),[0,1_200_000_000,0,0,200_000_000,1_000_000_000,200_000_000,300_000_000,0,0,floor],"A's 0.2 SOL first, then 0.3 SOL of B; burned child grows by the fill");
 assert_eq!(read64(&accounts[4].data,64).unwrap(),700_000_000);assert_eq!(read64(&accounts[5].data,64).unwrap(),0,"nothing bought stays in custody");assert_eq!(read64(&accounts[12].data,36).unwrap(),supply-floor);
 let stricter=floor+1_000_000;let mut strict=fixture();run(&w,&mut strict,&FeeWorld::body(amount,stricter,expiry)).unwrap();assert_eq!(FeeWorld::counters(&strict[2])[10],stricter,"the keeper may ask for more than the floor");
 set_swap_fill(floor-1);let mut short_fill=fixture();assert_eq!(run(&w,&mut short_fill,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(60),"a fill under min_out fails the effect check");assert_eq!(FeeWorld::counters(&short_fill[2]),BUDGET);set_swap_fill(0);
 let count=cpi_count();
 let mut other_pool=c;other_pool.pool=Pubkey::new_unique();let mut wrong_campaign_pool=f.buyback_accounts(&w,&other_pool,BUDGET,1_200_000_000,10*SOL,400_000_000_000_000);assert_eq!(run(&w,&mut wrong_campaign_pool,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(60),"the pool must be the campaign's recorded pool");
 let mut wrong_pool=fixture();wrong_pool[6].key=Pubkey::new_unique();assert_eq!(run(&w,&mut wrong_pool,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(60));
 let mut wrong_config=fixture();wrong_config[7].key=Pubkey::new_unique();assert_eq!(run(&w,&mut wrong_config,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(60));
 let mut wrong_vault=fixture();wrong_vault[9].key=Pubkey::new_unique();assert_eq!(run(&w,&mut wrong_vault,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(60));
 let mut swapped_vaults=fixture();swapped_vaults.swap(9,10);assert_eq!(run(&w,&mut swapped_vaults,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(60));
 let mut foreign_vault=fixture();foreign_vault[10].data=token_data(&c.child_mint,&Pubkey::new_unique(),400_000_000_000_000);assert_eq!(run(&w,&mut foreign_vault,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(72),"a vault not owned by the CPMM authority");
 let mut wrong_mint=fixture();wrong_mint[12]=Acc::new(Pubkey::new_unique(),TOKEN,mint_data(1,None));assert_eq!(run(&w,&mut wrong_mint,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(60));
 let mut wrong_observation=fixture();wrong_observation[13].key=Pubkey::new_unique();assert_eq!(run(&w,&mut wrong_observation,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(60));
 let mut other_custody=fixture();other_custody[5]=Acc::new(ata_key(&Pubkey::new_unique(),&c.child_mint),TOKEN,token_data(&c.child_mint,&f.authority,0));assert_eq!(run(&w,&mut other_custody,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(60));
 let mut over_slice=fixture();assert_eq!(run(&w,&mut over_slice,&FeeWorld::body(SOL/2+1,floor,expiry)).unwrap_err(),err(60),"0.5 SOL is the largest slice");
 let mut over_budget=f.buyback_accounts(&w,&c,[0,300_000_000,0,0,100_000_000,100_000_000,0,0,0,0,0],300_000_000,10*SOL,400_000_000_000_000);assert_eq!(run(&w,&mut over_budget,&FeeWorld::body(200_000_001,1,expiry)).unwrap_err(),err(60),"the two pending budgets together are the cap");
 let mut zero_min=fixture();assert_eq!(run(&w,&mut zero_min,&FeeWorld::body(amount,0,expiry)).unwrap_err(),err(60));
 let mut stale=fixture();assert_eq!(run(&w,&mut stale,&FeeWorld::body(amount,floor,LAUNCH_NOW-1)).unwrap_err(),err(60));
 let mut far=fixture();assert_eq!(run(&w,&mut far,&FeeWorld::body(amount,floor,LAUNCH_NOW+121)).unwrap_err(),err(60));
 let mut unsigned=fixture();unsigned[1].signer=false;assert_eq!(run(&w,&mut unsigned,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(60));
 let mut stranger=fixture();stranger[1]=Acc::empty(Pubkey::new_unique()).signer();assert_eq!(run(&w,&mut stranger,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(60),"only the creator keeper");
 let mut short_body=fixture();assert_eq!(run(&w,&mut short_body,&FeeWorld::body(amount,floor,expiry)[..24]).unwrap_err(),err(60));
 let mut fifteen=fixture();fifteen.pop();assert_eq!(run(&w,&mut fifteen,&FeeWorld::body(amount,floor,expiry)).unwrap_err(),err(60));
 assert_eq!(cpi_count(),count,"no refused call reached a CPI");
}
#[test]fn child_buyback_books_parent_a_first_then_parent_b_and_stops_at_the_combined_budget(){
 let w=World::new(None);let mut c=w.launched();let f=FeeWorld::new(&w,&c);c.pool=f.pool;simulate_token_cpis(true);
 let mut accounts=f.buyback_accounts(&w,&c,BUDGET,1_200_000_000,10*SOL,400_000_000_000_000);let expiry=LAUNCH_NOW+90;
 let mut burned=0u64;
 for (slice,expected_spent) in [(SOL/2,(200_000_000,300_000_000)),(SOL/2,(200_000_000,800_000_000)),(SOL/5,(200_000_000,1_000_000_000))]{
  let floor=FeeWorld::floor(&accounts,slice);run(&w,&mut accounts,&FeeWorld::body(slice,floor,expiry)).unwrap();burned+=floor;
  let counters=FeeWorld::counters(&accounts[2]);assert_eq!((counters[6],counters[7]),expected_spent);assert_eq!(counters[10],burned);
  assert_eq!(&counters[..6],&BUDGET[..6],"allocations and totals never move");assert_eq!((counters[8],counters[9]),(0,0),"no parent is burned");
  assert_eq!(read64(&accounts[4].data,64).unwrap(),1_200_000_000-counters[6]-counters[7],"custody equals what is still owed");
 }
 let count=cpi_count();assert_eq!(run(&w,&mut accounts,&FeeWorld::body(1,1,expiry)).unwrap_err(),err(60),"the budget is spent");assert_eq!(cpi_count(),count);
 assert_eq!(read64(&accounts[4].data,64).unwrap(),0);assert_eq!(read64(&accounts[5].data,64).unwrap(),0);
}
#[test]fn distribute_keeps_its_weights_and_the_fee_state_layout(){
 let w=World::new(None);let c=w.launched();let f=FeeWorld::new(&w,&c);simulate_token_cpis(true);
 let accounts=|total:u64,custody:u64|vec![w.campaign_acc(&c),Acc::empty(c.creator).signer(),f.state(&w,[0,total,0,0,0,0,0,0,0,0,0]),Acc::empty(f.authority),
  Acc::new(ata_key(&f.authority,&WSOL),TOKEN,token_data(&WSOL,&f.authority,custody)),Acc::new(ata_key(&c.treasury,&WSOL),TOKEN,token_data(&WSOL,&c.treasury,0)),Acc::new(ata_key(&c.dev,&WSOL),TOKEN,token_data(&WSOL,&c.dev,0)),program_account(TOKEN)];
 let mut first=accounts(1_680_000_000,1_680_000_000);run(&w,&mut first,&[23]).unwrap();
 assert_eq!(FeeWorld::counters(&first[2]),[0,1_680_000_000,980_000_000,200_000_000,250_000_000,250_000_000,0,0,0,0,0],"98:20:25:25 of 168 at offsets 56, 64, 72, 80");
 assert_eq!(read64(&first[5].data,64).unwrap(),980_000_000);assert_eq!(read64(&first[6].data,64).unwrap(),200_000_000);assert_eq!(read64(&first[4].data,64).unwrap(),500_000_000,"both parent shares stay in custody as the coin buyback budget");
 let count=cpi_count();run(&w,&mut first,&[23]).unwrap();assert_eq!(cpi_count(),count,"nothing new to pay");
 put64(&mut first[2].data,48,3_360_000_000);put64(&mut first[4].data,64,2_180_000_000);run(&w,&mut first,&[23]).unwrap();
 assert_eq!(FeeWorld::counters(&first[2]),[0,3_360_000_000,1_960_000_000,400_000_000,500_000_000,500_000_000,0,0,0,0,0],"cumulative: only the difference is paid");
 assert_eq!(read64(&first[5].data,64).unwrap(),1_960_000_000);assert_eq!(read64(&first[4].data,64).unwrap(),1_000_000_000);
}
