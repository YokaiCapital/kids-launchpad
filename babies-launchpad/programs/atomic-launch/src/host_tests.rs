//! Host-side handler tests for the campaign layout, tag 0, tag 6 account parsing, the activation CPI and the
//! claim refusals. A syscall stub serves the clock and rent, logs every CPI and refuses it with
//! `HOST_CPI_UNSUPPORTED`, so a handler that reaches its first CPI has passed every check before it.
use super::*;
use launch::{activate_distribution,custody_after_activation,distribution_record_matches,launch_account_count,share,vault_allocations,verify_activation,DISTRIBUTION_LEN,LAUNCH_ACCOUNTS,LAUNCH_ACCOUNTS_WITH_DISTRIBUTION,LIQUIDITY_BPS};
use solana_program::{instruction::Instruction,program_stubs::{set_syscall_stubs,SyscallStubs}};
use std::cell::RefCell;
use std::sync::Once;
const HOST_CPI_UNSUPPORTED:u32=0xF00D;
const TOKEN:Pubkey=solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA:Pubkey=solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// One logged CPI: the instruction and the keys the caller signed for through seeds.
struct LoggedCpi{instruction:Instruction,signed_by_seeds:Vec<Pubkey>}
thread_local!{static NOW:RefCell<i64>=RefCell::new(0);static PROGRAM:RefCell<Pubkey>=RefCell::new(Pubkey::default());static CPI_LOG:RefCell<Vec<LoggedCpi>>=RefCell::new(vec![]);}
struct HostStubs;
impl SyscallStubs for HostStubs{
 fn sol_log(&self,_message:&str){}
 fn sol_get_clock_sysvar(&self,var_addr:*mut u8)->u64{let clock=Clock{unix_timestamp:NOW.with(|n|*n.borrow()),..Clock::default()};unsafe{std::ptr::write(var_addr as *mut Clock,clock)};0}
 fn sol_get_rent_sysvar(&self,var_addr:*mut u8)->u64{unsafe{std::ptr::write(var_addr as *mut Rent,Rent::default())};0}
 fn sol_invoke_signed(&self,instruction:&Instruction,_infos:&[AccountInfo],signers_seeds:&[&[&[u8]]])->ProgramResult{
  let program=PROGRAM.with(|p|*p.borrow());
  let signed_by_seeds=signers_seeds.iter().filter_map(|seeds|Pubkey::create_program_address(seeds,&program).ok()).collect();
  CPI_LOG.with(|l|l.borrow_mut().push(LoggedCpi{instruction:instruction.clone(),signed_by_seeds}));
  Err(err(HOST_CPI_UNSUPPORTED))
 }
}
static INSTALL:Once=Once::new();
fn install(program:&Pubkey,now:i64){INSTALL.call_once(||{set_syscall_stubs(Box::new(HostStubs));});PROGRAM.with(|p|*p.borrow_mut()=*program);NOW.with(|n|*n.borrow_mut()=now);CPI_LOG.with(|l|l.borrow_mut().clear());}
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
