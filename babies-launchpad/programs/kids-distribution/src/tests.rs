//! Host-side handler tests. A syscall stub serves the clock and rent, emulates the Token program's Transfer and
//! Burn on the passed account data (checking the vault authority is signed with the right seeds) and refuses
//! every other CPI with `HOST_CPI_UNSUPPORTED`. Account creation (System, Associated Token) therefore stops a
//! host test at the point where every validation before it has passed; those paths are covered on localnet.
use super::*;
use claims::ClaimReceipt;
use solana_program::program_stubs::{set_syscall_stubs,SyscallStubs};
use std::cell::RefCell;
use std::sync::Once;
pub const HOST_CPI_UNSUPPORTED:u32=0xF00D;
thread_local!{static NOW:RefCell<i64>=RefCell::new(0);static PROGRAM:RefCell<Pubkey>=RefCell::new(Pubkey::default());static CPI_LOG:RefCell<Vec<(Pubkey,Vec<u8>)>>=RefCell::new(vec![]);}
struct HostStubs;
impl SyscallStubs for HostStubs{
 fn sol_log(&self,_message:&str){}
 fn sol_get_clock_sysvar(&self,var_addr:*mut u8)->u64{let clock=Clock{unix_timestamp:NOW.with(|n|*n.borrow()),..Clock::default()};unsafe{std::ptr::write(var_addr as *mut Clock,clock)};0}
 fn sol_get_rent_sysvar(&self,var_addr:*mut u8)->u64{unsafe{std::ptr::write(var_addr as *mut Rent,Rent::default())};0}
 fn sol_invoke_signed(&self,instruction:&Instruction,infos:&[AccountInfo],signers_seeds:&[&[&[u8]]])->ProgramResult{
  CPI_LOG.with(|l|l.borrow_mut().push((instruction.program_id,instruction.data.clone())));
  if instruction.program_id!=TOKEN{return Err(err(HOST_CPI_UNSUPPORTED))}
  let find=|k:&Pubkey|infos.iter().find(|i|i.key==k).expect("CPI account passed").clone();
  let program=PROGRAM.with(|p|*p.borrow());
  let authority=instruction.accounts[2].pubkey;
  let signed=find(&authority).is_signer||signers_seeds.iter().any(|seeds|Pubkey::create_program_address(seeds,&program)==Ok(authority));
  assert!(signed,"token CPI authority {authority} is not signed");
  let amount=read64(&instruction.data,1).unwrap();
  let source=find(&instruction.accounts[0].pubkey);
  match instruction.data[0]{
   3=>{let destination=find(&instruction.accounts[1].pubkey);
    {let mut s=source.try_borrow_mut_data().unwrap();assert_eq!(read_key(&s,32).unwrap(),authority);let b=read64(&s,64).unwrap();assert!(b>=amount,"token transfer overdraw");put64(&mut s,64,b-amount);}
    let mut d=destination.try_borrow_mut_data().unwrap();let b=read64(&d,64).unwrap();put64(&mut d,64,b+amount);Ok(())},
   8=>{let mint=find(&instruction.accounts[1].pubkey);
    {let mut s=source.try_borrow_mut_data().unwrap();assert_eq!(read_key(&s,32).unwrap(),authority);assert_eq!(read_key(&s,0).unwrap(),*mint.key);let b=read64(&s,64).unwrap();assert!(b>=amount,"token burn overdraw");put64(&mut s,64,b-amount);}
    let mut m=mint.try_borrow_mut_data().unwrap();let b=read64(&m,36).unwrap();put64(&mut m,36,b-amount);Ok(())},
   _=>Err(err(HOST_CPI_UNSUPPORTED)),
  }
 }
}
static INSTALL:Once=Once::new();
fn install(program:&Pubkey,now:i64){INSTALL.call_once(||{set_syscall_stubs(Box::new(HostStubs));});PROGRAM.with(|p|*p.borrow_mut()=*program);NOW.with(|n|*n.borrow_mut()=now);CPI_LOG.with(|l|l.borrow_mut().clear());}
fn set_now(now:i64){NOW.with(|n|*n.borrow_mut()=now);}
fn cpi_count()->usize{CPI_LOG.with(|l|l.borrow().len())}
struct Acc{key:Pubkey,lamports:u64,data:Vec<u8>,owner:Pubkey,signer:bool,writable:bool,executable:bool}
impl Acc{
 fn new(key:Pubkey,owner:Pubkey,data:Vec<u8>)->Self{Self{key,lamports:1_000_000_000,data,owner,signer:false,writable:true,executable:false}}
 fn signer(mut self)->Self{self.signer=true;self}
 fn program(key:Pubkey)->Self{let mut a=Self::new(key,Pubkey::default(),vec![]);a.executable=true;a.writable=false;a}
 fn empty(key:Pubkey)->Self{Self::new(key,system_program::id(),vec![])}
}
fn infos<'a>(accounts:&'a mut [Acc])->Vec<AccountInfo<'a>>{accounts.iter_mut().map(|a|AccountInfo::new(&a.key,a.signer,a.writable,&mut a.lamports,&mut a.data,&a.owner,a.executable,0)).collect()}
fn mint_data(supply:u64)->Vec<u8>{let mut d=vec![0u8;82];put64(&mut d,36,supply);d[44]=CHILD_DECIMALS;d[45]=1;d}
fn token_data(mint:&Pubkey,owner:&Pubkey,amount:u64)->Vec<u8>{let mut d=vec![0u8;165];d[..32].copy_from_slice(mint.as_ref());d[32..64].copy_from_slice(owner.as_ref());put64(&mut d,64,amount);d[108]=1;d}
fn ata_key(owner:&Pubkey,mint:&Pubkey)->Pubkey{Pubkey::find_program_address(&[owner.as_ref(),TOKEN.as_ref(),mint.as_ref()],&ATA).0}
const SUPPLY:u64=1_000_000_000_000_000;
const LAUNCH:i64=1_760_000_000;
/// One launched campaign with its distribution: everything a claim, burn or sweep test needs.
#[derive(Clone)]
struct World{program:Pubkey,launch_program:Pubkey,creator:Pubkey,nonce:u64,campaign:Pubkey,campaign_bump:u8,mint:Pubkey,dev:Pubkey,settled_accepted:u64,parents_key:Pubkey,parents_roots:[[u8;32];2],parents_claimed:[u64;2],eligible:[u64;2],parent_supply:[u64;2],distribution:Distribution}
impl World{
 fn new()->Self{
  let program=Pubkey::new_unique();let launch_program=Pubkey::new_unique();let creator=Pubkey::new_unique();let nonce=7u64;
  let (campaign,campaign_bump)=Pubkey::find_program_address(&[b"campaign",creator.as_ref(),&nonce.to_le_bytes()],&launch_program);
  let mint=Pubkey::new_unique();let dev=Pubkey::new_unique();let parents_key=Pubkey::find_program_address(&[b"parents",campaign.as_ref()],&launch_program).0;
  let bump=Pubkey::find_program_address(&[b"distribution",campaign.as_ref()],&program).1;
  let mut bumps=[bump,0,0,0,0];for p in 0..4u8{bumps[1+p as usize]=vault_authority(&program,&campaign,p).1;}
  let parent_supply=[1_000_000_000_000u64,500_000_000_000];let eligible=[400_000_000_000u64,200_000_000_000];
  let distribution=Distribution{campaign,mint,launch_program,supply:SUPPLY,settled_accepted:12_000_000_000,launch_time:LAUNCH,parent_expiry:LAUNCH+PARENT_EXPIRY_SECONDS,dev_start:LAUNCH,dev_end:three_month_end(LAUNCH).unwrap(),roots:[[1;32],[2;32]],parent_supply,eligible,allocation:allocations(SUPPLY),claimed:[0;4],burned:[0;2],dev_prior:0,flags:FLAG_ACTIVATED,bumps,dev};
  install(&program,LAUNCH);
  Self{program,launch_program,creator,nonce,campaign,campaign_bump,mint,dev,settled_accepted:12_000_000_000,parents_key,parents_roots:[[1;32],[2;32]],parents_claimed:[0;2],eligible,parent_supply,distribution}
 }
 fn distribution_key(&self)->Pubkey{Pubkey::find_program_address(&[b"distribution",self.campaign.as_ref()],&self.program).0}
 fn distribution_acc(&self)->Acc{let mut d=vec![0u8;DISTRIBUTION_LEN];self.distribution.encode(&mut d);Acc::new(self.distribution_key(),self.program,d)}
 fn campaign_acc(&self,phase:u8,dev_claimed:u64)->Acc{
  let mut d=vec![0u8;LAUNCH_CAMPAIGN_LEN];d[..8].copy_from_slice(LAUNCH_CAMPAIGN_MAGIC);d[8..40].copy_from_slice(self.creator.as_ref());put64(&mut d,40,self.nonce);d[96]=phase;d[97]=self.campaign_bump;
  put64(&mut d,120,self.settled_accepted);d[128..160].copy_from_slice(self.mint.as_ref());put64(&mut d,160,SUPPLY);d[168..200].copy_from_slice(self.dev.as_ref());put64(&mut d,232,LAUNCH as u64);put64(&mut d,304,dev_claimed);
  Acc::new(self.campaign,self.launch_program,d)
 }
 fn parents_acc(&self)->Acc{
  let mut d=vec![0u8;LAUNCH_PARENTS_LEN];d[..8].copy_from_slice(LAUNCH_PARENTS_MAGIC);d[8..40].copy_from_slice(self.campaign.as_ref());
  for i in 0..2{d[104+32*i..136+32*i].copy_from_slice(&self.parents_roots[i]);put64(&mut d,168+8*i,self.parent_supply[i]);put64(&mut d,192+8*i,self.eligible[i]);put64(&mut d,208+8*i,self.parents_claimed[i]);}
  Acc::new(self.parents_key,self.launch_program,d)
 }
 fn receipt_acc(&self,owner:&Pubkey,accepted:u64,settled:bool,claimed:bool)->Acc{
  let (key,bump)=Pubkey::find_program_address(&[b"commitment",self.campaign.as_ref(),owner.as_ref()],&self.launch_program);
  let mut d=vec![0u8;LAUNCH_RECEIPT_LEN];d[..8].copy_from_slice(LAUNCH_RECEIPT_MAGIC);d[8..40].copy_from_slice(self.campaign.as_ref());d[40..72].copy_from_slice(owner.as_ref());d[96]=bump;d[97]=settled as u8;d[98]=claimed as u8;put64(&mut d,104,accepted);
  Acc::new(key,self.launch_program,d)
 }
 fn mint_acc(&self,supply:u64)->Acc{Acc::new(self.mint,TOKEN,mint_data(supply))}
 fn authority_acc(&self,purpose:u8)->Acc{Acc::empty(vault_authority(&self.program,&self.campaign,purpose).0)}
 fn vault_acc(&self,purpose:u8,amount:u64)->Acc{let authority=vault_authority(&self.program,&self.campaign,purpose).0;Acc::new(ata_key(&authority,&self.mint),TOKEN,token_data(&self.mint,&authority,amount))}
 fn holder_ata_acc(&self,owner:&Pubkey,amount:u64)->Acc{Acc::new(ata_key(owner,&self.mint),TOKEN,token_data(&self.mint,owner,amount))}
 fn claim_key(&self,purpose:u8,owner:&Pubkey)->Pubkey{Pubkey::find_program_address(&ClaimReceipt::seeds(&self.campaign,&[purpose],owner),&self.program).0}
 fn claim_acc(&self,purpose:u8,owner:&Pubkey,amount:u64)->Acc{
  let (key,bump)=Pubkey::find_program_address(&ClaimReceipt::seeds(&self.campaign,&[purpose],owner),&self.program);
  let mut d=vec![0u8;CLAIM_LEN];ClaimReceipt{campaign:self.campaign,owner:*owner,purpose,bump,amount}.encode(&mut d);Acc::new(key,self.program,d)
 }
}
fn run(world:&World,accounts:&mut [Acc],data:&[u8])->ProgramResult{PROGRAM.with(|p|*p.borrow_mut()=world.program);let infos=infos(accounts);process_instruction(&world.program,&infos,data)}
fn balance(acc:&Acc)->u64{read64(&acc.data,64).unwrap()}
fn parent_body(index:u8,balance:u64,allocation:u64,proof:&[u8])->Vec<u8>{let mut b=vec![TAG_CLAIM_PARENT,index];b.extend_from_slice(&balance.to_le_bytes());b.extend_from_slice(&allocation.to_le_bytes());b.push((proof.len()/32) as u8);b.extend_from_slice(proof);b}
#[test]fn distribution_layout_round_trips_and_offsets_match_the_design(){
 let w=World::new();let mut d=vec![0u8;DISTRIBUTION_LEN];
 let mut original=w.distribution;original.claimed=[1,2,3,4];original.burned=[5,6];original.dev_prior=4;original.flags=FLAG_ACTIVATED|burned_flag(1);
 original.encode(&mut d);
 assert_eq!(&d[..8],b"KIDSDST1");assert_eq!(&d[8..40],w.campaign.as_ref());assert_eq!(&d[40..72],w.mint.as_ref());assert_eq!(&d[72..104],w.launch_program.as_ref());
 assert_eq!(read64(&d,104).unwrap(),SUPPLY);assert_eq!(read64(&d,112).unwrap(),12_000_000_000);assert_eq!(read64(&d,120).unwrap() as i64,LAUNCH);assert_eq!(read64(&d,128).unwrap() as i64,LAUNCH+2_592_000);
 assert_eq!(read64(&d,136).unwrap() as i64,LAUNCH);assert_eq!(read64(&d,144).unwrap() as i64,three_month_end(LAUNCH).unwrap());
 assert_eq!(d[152..184],[1;32]);assert_eq!(d[184..216],[2;32]);assert_eq!(read64(&d,216).unwrap(),w.parent_supply[0]);assert_eq!(read64(&d,224).unwrap(),w.parent_supply[1]);
 assert_eq!(read64(&d,232).unwrap(),w.eligible[0]);assert_eq!(read64(&d,240).unwrap(),w.eligible[1]);
 for p in 0..4{assert_eq!(read64(&d,248+8*p).unwrap(),allocations(SUPPLY)[p]);assert_eq!(read64(&d,280+8*p).unwrap(),original.claimed[p]);}
 assert_eq!(read64(&d,312).unwrap(),5);assert_eq!(read64(&d,320).unwrap(),6);assert_eq!(read64(&d,328).unwrap(),4);assert_eq!(d[336],FLAG_ACTIVATED|burned_flag(1));assert_eq!(d[337..342],original.bumps);assert_eq!(&d[344..376],w.dev.as_ref());
 assert_eq!(Distribution::decode(&d).unwrap(),original);
 let mut acc=Acc::new(w.distribution_key(),w.program,d.clone());{let i=infos(std::slice::from_mut(&mut acc));assert_eq!(Distribution::read(&i[0],&w.program).unwrap(),original);}
 let mut wrong_owner=Acc::new(w.distribution_key(),Pubkey::new_unique(),d.clone());{let i=infos(std::slice::from_mut(&mut wrong_owner));assert_eq!(Distribution::read(&i[0],&w.program).unwrap_err(),ProgramError::IncorrectProgramId);}
 let mut wrong_key=Acc::new(Pubkey::new_unique(),w.program,d.clone());{let i=infos(std::slice::from_mut(&mut wrong_key));assert_eq!(Distribution::read(&i[0],&w.program).unwrap_err(),ProgramError::InvalidSeeds);}
 let mut inactive=d.clone();inactive[OFF_FLAGS]=0;let mut acc=Acc::new(w.distribution_key(),w.program,inactive);{let i=infos(std::slice::from_mut(&mut acc));assert_eq!(Distribution::read(&i[0],&w.program).unwrap_err(),err(E_NOT_ACTIVATED));}
 let mut claim=vec![0u8;CLAIM_LEN];let r=ClaimReceipt{campaign:w.campaign,owner:w.dev,purpose:2,bump:9,amount:77};r.encode(&mut claim);assert_eq!(&claim[..8],b"KIDSDCL1");assert_eq!(claim[72],2);assert_eq!(claim[74],1);assert_eq!(ClaimReceipt::decode(&claim).unwrap(),r);
}
#[test]fn every_tag_parses_its_exact_body_and_every_other_tag_is_refused(){
 let bad=ProgramError::InvalidInstructionData;
 assert_eq!(parse(&[]).unwrap_err(),bad);
 let mut activate=vec![0u8];for p in 1..=4u64{activate.extend_from_slice(&(p*10).to_le_bytes());}
 assert_eq!(parse(&activate).unwrap(),InstructionData::Activate{prior:[10,20,30,40]});
 assert_eq!(parse(&activate[..32]).unwrap_err(),bad);assert_eq!(parse(&[activate.clone(),vec![0]].concat()).unwrap_err(),bad);
 assert_eq!(parse(&[1]).unwrap(),InstructionData::ClaimParticipant);assert_eq!(parse(&[1,0]).unwrap_err(),bad);
 let proof=[7u8;64];let body=parent_body(1,5,50,&proof);
 assert_eq!(parse(&body).unwrap(),InstructionData::ClaimParent{index:1,balance:5,allocation:50,proof:&proof});
 assert_eq!(parse(&parent_body(0,5,50,&[])).unwrap(),InstructionData::ClaimParent{index:0,balance:5,allocation:50,proof:&[]});
 assert_eq!(parse(&parent_body(2,5,50,&[])).unwrap_err(),bad,"parent index 2");
 let mut short=body.clone();short.pop();assert_eq!(parse(&short).unwrap_err(),bad);
 let mut long=body.clone();long.push(0);assert_eq!(parse(&long).unwrap_err(),bad);
 let mut miscount=body.clone();miscount[18]=1;assert_eq!(parse(&miscount).unwrap_err(),bad,"count does not match length");
 assert_eq!(parse(&parent_body(0,1,1,&[0u8;32*33])).unwrap_err(),bad,"proof deeper than 32");
 assert_eq!(parse(&[2]).unwrap_err(),bad);assert_eq!(parse(&[2;18]).unwrap_err(),bad);
 assert_eq!(parse(&[3]).unwrap(),InstructionData::ClaimDev);assert_eq!(parse(&[3,0]).unwrap_err(),bad);
 assert_eq!(parse(&[4,0]).unwrap(),InstructionData::BurnExpired{index:0});assert_eq!(parse(&[4,1]).unwrap(),InstructionData::BurnExpired{index:1});
 assert_eq!(parse(&[4,2]).unwrap_err(),bad);assert_eq!(parse(&[4]).unwrap_err(),bad);assert_eq!(parse(&[4,0,0]).unwrap_err(),bad);
 for purpose in 0..4u8{assert_eq!(parse(&[5,purpose]).unwrap(),InstructionData::SweepDonationToBurn{purpose});}
 assert_eq!(parse(&[5,4]).unwrap_err(),bad);assert_eq!(parse(&[5]).unwrap_err(),bad);assert_eq!(parse(&[5,0,0]).unwrap_err(),bad);
 for tag in 6..=255u8{for body in [vec![],vec![0u8],vec![0u8;8],vec![0u8;32],vec![0u8;88]]{assert_eq!(parse(&[vec![tag],body].concat()).unwrap_err(),bad,"tag {tag}");}}
}
#[test]fn no_administrative_tag_exists_in_the_dispatcher(){
 let w=World::new();let mut accounts=vec![w.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(1),w.vault_acc(1,10),Acc::program(TOKEN)];
 for tag in 6..=255u8{for len in [0usize,1,8,32,88,256]{let data=[vec![tag],vec![0u8;len]].concat();assert_eq!(run(&w,&mut accounts,&data).unwrap_err(),ProgramError::InvalidInstructionData,"tag {tag} len {len}");}}
 assert_eq!(cpi_count(),0,"no CPI ran");assert_eq!(balance(&accounts[3]),10);assert_eq!(Distribution::decode(&accounts[0].data).unwrap(),w.distribution);
}
#[test]fn claim_dev_pays_the_vested_amount_and_a_repeat_pays_nothing(){
 let w=World::new();let allocation=allocations(SUPPLY);let end=three_month_end(LAUNCH).unwrap();
 let mut accounts=vec![Acc::empty(w.dev).signer(),w.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(3),w.vault_acc(3,allocation[3]),w.holder_ata_acc(&w.dev,0),Acc::program(TOKEN)];
 set_now(LAUNCH-1);assert_eq!(run(&w,&mut accounts,&[TAG_CLAIM_DEV]).unwrap_err(),err(E_NOT_YET_CLAIMABLE));
 set_now(LAUNCH);run(&w,&mut accounts,&[TAG_CLAIM_DEV]).unwrap();
 assert_eq!(balance(&accounts[5]),SUPPLY/100,"instant 1 %");assert_eq!(balance(&accounts[4]),allocation[3]-SUPPLY/100);
 let count=cpi_count();run(&w,&mut accounts,&[TAG_CLAIM_DEV]).unwrap();assert_eq!(cpi_count(),count,"same second: no transfer");assert_eq!(balance(&accounts[5]),SUPPLY/100);
 set_now(LAUNCH+(end-LAUNCH)/2);run(&w,&mut accounts,&[TAG_CLAIM_DEV]).unwrap();assert_eq!(balance(&accounts[5]),SUPPLY/50,"mid: 2 %");
 set_now(end+86400*400);run(&w,&mut accounts,&[TAG_CLAIM_DEV]).unwrap();assert_eq!(balance(&accounts[5]),allocation[3],"after end: all 3 %");assert_eq!(balance(&accounts[4]),0);
 let d=Distribution::decode(&accounts[1].data).unwrap();assert_eq!(d.claimed[3],allocation[3]);assert_eq!(d.claimed[..3],[0,0,0]);assert_eq!(d.allocation,allocation,"terms untouched");
 run(&w,&mut accounts,&[TAG_CLAIM_DEV]).unwrap();assert_eq!(balance(&accounts[5]),allocation[3]);
 let mut impostor=vec![Acc::empty(Pubkey::new_unique()).signer(),w.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(3),w.vault_acc(3,allocation[3]),w.holder_ata_acc(&w.dev,0),Acc::program(TOKEN)];
 assert_eq!(run(&w,&mut impostor,&[TAG_CLAIM_DEV]).unwrap_err(),err(E_UNAUTHORIZED));
 let mut unsigned=vec![Acc::empty(w.dev),w.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(3),w.vault_acc(3,allocation[3]),w.holder_ata_acc(&w.dev,0),Acc::program(TOKEN)];
 assert_eq!(run(&w,&mut unsigned,&[TAG_CLAIM_DEV]).unwrap_err(),ProgramError::MissingRequiredSignature);
 let mut wrong_vault=vec![Acc::empty(w.dev).signer(),w.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(2),w.vault_acc(2,allocation[2]),w.holder_ata_acc(&w.dev,0),Acc::program(TOKEN)];
 assert_eq!(run(&w,&mut wrong_vault,&[TAG_CLAIM_DEV]).unwrap_err(),err(E_INVALID_ACCOUNT),"parent vault substituted for the dev vault");
 let mut wrong_mint=vec![Acc::empty(w.dev).signer(),w.distribution_acc(),Acc::new(Pubkey::new_unique(),TOKEN,mint_data(SUPPLY)),w.authority_acc(3),w.vault_acc(3,allocation[3]),w.holder_ata_acc(&w.dev,0),Acc::program(TOKEN)];
 assert_eq!(run(&w,&mut wrong_mint,&[TAG_CLAIM_DEV]).unwrap_err(),err(E_INVALID_MINT));
 let mut migrated=World::new();migrated.distribution.claimed[3]=SUPPLY/100;migrated.distribution.dev_prior=SUPPLY/100;
 let mut accounts=vec![Acc::empty(migrated.dev).signer(),migrated.distribution_acc(),migrated.mint_acc(SUPPLY),migrated.authority_acc(3),migrated.vault_acc(3,allocation[3]-SUPPLY/100),migrated.holder_ata_acc(&migrated.dev,0),Acc::program(TOKEN)];
 set_now(LAUNCH);run(&migrated,&mut accounts,&[TAG_CLAIM_DEV]).unwrap();assert_eq!(balance(&accounts[5]),0,"prior claims under the launch program are honoured");
 set_now(end);run(&migrated,&mut accounts,&[TAG_CLAIM_DEV]).unwrap();assert_eq!(balance(&accounts[5]),allocation[3]-SUPPLY/100);assert_eq!(balance(&accounts[4]),0);
}
#[test]fn burned_supply_does_not_change_the_dev_entitlement(){
 let w=World::new();let allocation=allocations(SUPPLY);
 let mut accounts=vec![Acc::empty(w.dev).signer(),w.distribution_acc(),w.mint_acc(SUPPLY-123_456_789),w.authority_acc(3),w.vault_acc(3,allocation[3]),w.holder_ata_acc(&w.dev,0),Acc::program(TOKEN)];
 set_now(LAUNCH);run(&w,&mut accounts,&[TAG_CLAIM_DEV]).unwrap();assert_eq!(balance(&accounts[5]),SUPPLY/100);
 let mut inflated=vec![Acc::empty(w.dev).signer(),w.distribution_acc(),w.mint_acc(SUPPLY+1),w.authority_acc(3),w.vault_acc(3,allocation[3]),w.holder_ata_acc(&w.dev,0),Acc::program(TOKEN)];
 assert_eq!(run(&w,&mut inflated,&[TAG_CLAIM_DEV]).unwrap_err(),err(E_INVALID_MINT),"supply above the original is refused");
}
#[test]fn burn_expired_refuses_before_expiry_burns_once_at_expiry_and_parents_are_independent(){
 let w=World::new();let allocation=allocations(SUPPLY);let expiry=LAUNCH+PARENT_EXPIRY_SECONDS;
 let mut accounts=vec![w.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(1),w.vault_acc(1,allocation[1]-1000),Acc::program(TOKEN)];
 set_now(LAUNCH);assert_eq!(run(&w,&mut accounts,&[TAG_BURN_EXPIRED,0]).unwrap_err(),err(E_NOT_EXPIRED));
 set_now(expiry-1);assert_eq!(run(&w,&mut accounts,&[TAG_BURN_EXPIRED,0]).unwrap_err(),err(E_NOT_EXPIRED));
 assert_eq!(cpi_count(),0);assert_eq!(balance(&accounts[3]),allocation[1]-1000);
 set_now(expiry);run(&w,&mut accounts,&[TAG_BURN_EXPIRED,0]).unwrap();
 assert_eq!(balance(&accounts[3]),0);assert_eq!(read64(&accounts[1].data,36).unwrap(),SUPPLY-(allocation[1]-1000),"mint supply fell by exactly the burn");
 assert_eq!(accounts[1].data[..4],[0;4]);assert_eq!(accounts[1].data[46..50],[0;4],"mint and freeze authority stay absent");
 let d=Distribution::decode(&accounts[0].data).unwrap();assert_eq!(d.burned,[allocation[1]-1000,0]);assert!(d.is_burned(0)&&!d.is_burned(1));assert_eq!(d.flags,FLAG_ACTIVATED|burned_flag(0));
 let count=cpi_count();
 assert_eq!(run(&w,&mut accounts,&[TAG_BURN_EXPIRED,0]).unwrap_err(),err(E_ALREADY_BURNED));
 set_now(expiry+86400*365);assert_eq!(run(&w,&mut accounts,&[TAG_BURN_EXPIRED,0]).unwrap_err(),err(E_ALREADY_BURNED));
 assert_eq!(cpi_count(),count,"a repeated burn touches nothing");assert_eq!(Distribution::decode(&accounts[0].data).unwrap(),d);
 assert_eq!(run(&w,&mut accounts,&[TAG_BURN_EXPIRED,1]).unwrap_err(),err(E_INVALID_ACCOUNT),"parent B burn with parent A's vault");
 let mut b=vec![Acc::new(w.distribution_key(),w.program,accounts[0].data.clone()),Acc::new(w.mint,TOKEN,accounts[1].data.clone()),w.authority_acc(2),w.vault_acc(2,allocation[2]),Acc::program(TOKEN)];
 set_now(expiry);run(&w,&mut b,&[TAG_BURN_EXPIRED,1]).unwrap();
 let d=Distribution::decode(&b[0].data).unwrap();assert_eq!(d.burned,[allocation[1]-1000,allocation[2]]);assert!(d.is_burned(0)&&d.is_burned(1));assert_eq!(balance(&b[3]),0);
 assert_eq!(d.allocation,allocation);assert_eq!(d.claimed,[0;4]);assert_eq!(d.parent_expiry,expiry,"terms untouched by burns");
 let mut empty=vec![w.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(1),w.vault_acc(1,0),Acc::program(TOKEN)];
 run(&w,&mut empty,&[TAG_BURN_EXPIRED,0]).unwrap();let d=Distribution::decode(&empty[0].data).unwrap();assert_eq!(d.burned[0],0);assert!(d.is_burned(0),"a fully claimed vault still closes");
 let mut wrong_mint=vec![w.distribution_acc(),Acc::new(Pubkey::new_unique(),TOKEN,mint_data(SUPPLY)),w.authority_acc(1),w.vault_acc(1,5),Acc::program(TOKEN)];
 assert_eq!(run(&w,&mut wrong_mint,&[TAG_BURN_EXPIRED,0]).unwrap_err(),err(E_INVALID_MINT));
 let mut wrong_program=vec![w.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(1),w.vault_acc(1,5),Acc::program(Pubkey::new_unique())];
 assert_eq!(run(&w,&mut wrong_program,&[TAG_BURN_EXPIRED,0]).unwrap_err(),err(E_INVALID_ACCOUNT));
 let mut other_campaign=World::new();other_campaign.program=w.program;
 let mut foreign=vec![other_campaign.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(1),w.vault_acc(1,5),Acc::program(TOKEN)];
 assert!(run(&w,&mut foreign,&[TAG_BURN_EXPIRED,0]).is_err(),"another campaign's distribution cannot burn this vault");
}
#[test]fn parent_claim_window_proof_threshold_and_replay(){
 let w=World::new();let allocation=allocations(SUPPLY);let expiry=LAUNCH+PARENT_EXPIRY_SECONDS;
 let owner=Pubkey::new_unique();let balance_a=threshold(w.parent_supply[0])+5;let entitled=proportional(allocation[1],balance_a,w.eligible[0]).unwrap();
 let sibling=[9u8;32];let leaf=merkle_leaf(&w.campaign,0,&owner,balance_a,entitled);let root=merkle_pair(&leaf,&sibling);
 let mut w=w;w.distribution.roots[0]=root;
 let good=parent_body(0,balance_a,entitled,&sibling);
 let fresh=|w:&World|vec![Acc::empty(owner).signer(),w.distribution_acc(),Acc::empty(w.claim_key(1,&owner)),w.mint_acc(SUPPLY),w.authority_acc(1),w.vault_acc(1,allocation[1]),w.holder_ata_acc(&owner,0),Acc::program(TOKEN),Acc::program(system_program::id())];
 let mut accounts=fresh(&w);
 set_now(LAUNCH-1);assert_eq!(run(&w,&mut accounts,&good).unwrap_err(),err(E_NOT_YET_CLAIMABLE));
 set_now(expiry);assert_eq!(run(&w,&mut accounts,&good).unwrap_err(),err(E_EXPIRED));
 set_now(expiry+1);assert_eq!(run(&w,&mut accounts,&good).unwrap_err(),err(E_EXPIRED));
 assert_eq!(cpi_count(),0);
 for now in [LAUNCH,expiry-1]{set_now(now);assert_eq!(run(&w,&mut accounts,&good).unwrap_err(),err(HOST_CPI_UNSUPPORTED),"valid at {now}: every check passed up to receipt creation");}
 set_now(LAUNCH+1);
 assert_eq!(run(&w,&mut accounts,&parent_body(0,balance_a,entitled,&[8u8;32])).unwrap_err(),err(E_PROOF_MISMATCH));
 assert_eq!(run(&w,&mut accounts,&parent_body(0,balance_a,entitled+1,&sibling)).unwrap_err(),err(E_ALLOCATION_MISMATCH));
 assert_eq!(run(&w,&mut accounts,&parent_body(0,balance_a+1,entitled,&sibling)).unwrap_err(),err(E_ALLOCATION_MISMATCH),"balance changed: allocation no longer matches");
 assert_eq!(run(&w,&mut accounts,&parent_body(0,threshold(w.parent_supply[0])-1,0,&sibling)).unwrap_err(),err(E_BELOW_THRESHOLD));
 assert_eq!(run(&w,&mut accounts,&parent_body(1,balance_a,entitled,&sibling)).unwrap_err(),err(E_ALLOCATION_MISMATCH),"parent B claim: parent B's eligible total gives another allocation");
 let entitled_b=proportional(allocation[2],balance_a,w.eligible[1]).unwrap();
 assert_eq!(run(&w,&mut accounts,&parent_body(1,balance_a,entitled_b,&sibling)).unwrap_err(),err(E_PROOF_MISMATCH),"parent B claim: the leaf binds the parent index");
 let mut impostor=fresh(&w);impostor[0]=Acc::empty(Pubkey::new_unique()).signer();
 assert_eq!(run(&w,&mut impostor,&good).unwrap_err(),err(E_PROOF_MISMATCH),"the leaf binds the owner");
 let mut burned=w.clone();burned.distribution.flags=FLAG_ACTIVATED|burned_flag(0);let mut accounts_b=fresh(&burned);
 assert_eq!(run(&burned,&mut accounts_b,&good).unwrap_err(),err(E_EXPIRED),"burned parent refuses even inside the window");
 burned.distribution.flags=FLAG_ACTIVATED|burned_flag(1);let mut accounts_c=fresh(&burned);
 assert_eq!(run(&burned,&mut accounts_c,&good).unwrap_err(),err(HOST_CPI_UNSUPPORTED),"parent B burned leaves parent A claimable");
 let mut overdrawn=w.clone();overdrawn.distribution.claimed[1]=allocation[1]-entitled+1;
 let mut accounts_d=fresh(&overdrawn);assert_eq!(run(&overdrawn,&mut accounts_d,&good).unwrap_err(),err(E_OVERDRAW));
 let mut replay=fresh(&w);replay[2]=w.claim_acc(1,&owner,entitled);let count=cpi_count();
 run(&w,&mut replay,&good).unwrap();assert_eq!(cpi_count(),count,"an existing receipt is a no-op");assert_eq!(balance(&replay[5]),allocation[1]);
 let mut foreign_receipt=fresh(&w);foreign_receipt[2]=Acc::new(w.claim_key(1,&owner),w.program,vec![0u8;CLAIM_LEN]);
 assert_eq!(run(&w,&mut foreign_receipt,&good).unwrap_err(),err(E_INVALID_ACCOUNT));
 let mut cross=World::new();cross.distribution.roots[0]=root;
 let mut accounts_e=fresh(&cross);assert_eq!(run(&cross,&mut accounts_e,&good).unwrap_err(),err(E_PROOF_MISMATCH),"a proof for another campaign fails there");
 let mut unsigned=fresh(&w);unsigned[0]=Acc::empty(owner);assert_eq!(run(&w,&mut unsigned,&good).unwrap_err(),ProgramError::MissingRequiredSignature);
}
#[test]fn participant_claim_reads_the_launch_receipt_and_pays_pro_rata(){
 let w=World::new();let allocation=allocations(SUPPLY);let owner=Pubkey::new_unique();let accepted=3_000_000_000u64;
 let expected=proportional(allocation[0],accepted,w.settled_accepted).unwrap();assert_eq!(expected,allocation[0]/4);
 let fresh=|receipt:Acc|vec![Acc::empty(owner).signer(),w.distribution_acc(),receipt,Acc::empty(w.claim_key(0,&owner)),w.mint_acc(SUPPLY),w.authority_acc(0),w.vault_acc(0,allocation[0]),w.holder_ata_acc(&owner,0),Acc::program(TOKEN),Acc::program(system_program::id())];
 set_now(LAUNCH);
 let mut accounts=fresh(w.receipt_acc(&owner,accepted,true,false));
 assert_eq!(run(&w,&mut accounts,&[TAG_CLAIM_PARTICIPANT]).unwrap_err(),err(HOST_CPI_UNSUPPORTED),"valid: every check passed up to receipt creation");
 let mut unsettled=fresh(w.receipt_acc(&owner,accepted,false,false));assert_eq!(run(&w,&mut unsettled,&[TAG_CLAIM_PARTICIPANT]).unwrap_err(),err(E_NOT_SETTLED));
 let mut paid_before=fresh(w.receipt_acc(&owner,accepted,true,true));assert_eq!(run(&w,&mut paid_before,&[TAG_CLAIM_PARTICIPANT]).unwrap_err(),err(E_ALREADY_CLAIMED),"paid under the launch program");
 let mut other=fresh(w.receipt_acc(&Pubkey::new_unique(),accepted,true,false));assert_eq!(run(&w,&mut other,&[TAG_CLAIM_PARTICIPANT]).unwrap_err(),err(E_UNAUTHORIZED),"someone else's receipt");
 let mut foreign=fresh(w.receipt_acc(&owner,accepted,true,false));foreign[2].owner=Pubkey::new_unique();assert_eq!(run(&w,&mut foreign,&[TAG_CLAIM_PARTICIPANT]).unwrap_err(),ProgramError::IncorrectProgramId,"receipt not owned by the launch program");
 let mut replay=fresh(w.receipt_acc(&owner,accepted,true,false));replay[3]=w.claim_acc(0,&owner,expected);let count=cpi_count();
 run(&w,&mut replay,&[TAG_CLAIM_PARTICIPANT]).unwrap();assert_eq!(cpi_count(),count,"an existing receipt is a no-op");assert_eq!(balance(&replay[6]),allocation[0]);
 let mut overdrawn=World::new();overdrawn.distribution.claimed[0]=allocation[0]-expected+1;
 let mut accounts=vec![Acc::empty(owner).signer(),overdrawn.distribution_acc(),overdrawn.receipt_acc(&owner,accepted,true,false),Acc::empty(overdrawn.claim_key(0,&owner)),overdrawn.mint_acc(SUPPLY),overdrawn.authority_acc(0),overdrawn.vault_acc(0,allocation[0]),overdrawn.holder_ata_acc(&owner,0),Acc::program(TOKEN),Acc::program(system_program::id())];
 assert_eq!(run(&overdrawn,&mut accounts,&[TAG_CLAIM_PARTICIPANT]).unwrap_err(),err(E_OVERDRAW));
 let sum:u64=[1u64,2,3,5_999_999_994,6_000_000_000].iter().map(|a|proportional(allocation[0],*a,w.settled_accepted).unwrap()).sum();assert!(sum<=allocation[0],"pro rata never exceeds the vault");
}
#[test]fn sweep_burns_only_what_exceeds_the_amount_still_owed(){
 let w=World::new();let allocation=allocations(SUPPLY);set_now(LAUNCH+10);
 let mut exact=vec![w.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(0),w.vault_acc(0,allocation[0]),Acc::program(TOKEN)];
 run(&w,&mut exact,&[TAG_SWEEP_DONATION_TO_BURN,0]).unwrap();assert_eq!(cpi_count(),0);assert_eq!(balance(&exact[3]),allocation[0]);
 let mut donated=vec![w.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(0),w.vault_acc(0,allocation[0]+777),Acc::program(TOKEN)];
 run(&w,&mut donated,&[TAG_SWEEP_DONATION_TO_BURN,0]).unwrap();assert_eq!(balance(&donated[3]),allocation[0]);assert_eq!(read64(&donated[1].data,36).unwrap(),SUPPLY-777);
 assert_eq!(Distribution::decode(&donated[0].data).unwrap(),w.distribution,"a sweep changes no counter");
 let mut partly=World::new();partly.distribution.claimed[3]=1_000;
 let mut dev=vec![partly.distribution_acc(),partly.mint_acc(SUPPLY),partly.authority_acc(3),partly.vault_acc(3,allocation[3]),Acc::program(TOKEN)];
 run(&partly,&mut dev,&[TAG_SWEEP_DONATION_TO_BURN,3]).unwrap();assert_eq!(balance(&dev[3]),allocation[3]-1_000,"claimed tokens still in the vault count as excess");
 let mut burned=w.clone();burned.distribution.flags=FLAG_ACTIVATED|burned_flag(1);
 let mut late=vec![burned.distribution_acc(),burned.mint_acc(SUPPLY),burned.authority_acc(2),burned.vault_acc(2,55),Acc::program(TOKEN)];
 run(&burned,&mut late,&[TAG_SWEEP_DONATION_TO_BURN,2]).unwrap();assert_eq!(balance(&late[3]),0,"after the expiry burn nothing is owed from that vault");
 let mut short=vec![w.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(1),w.vault_acc(1,allocation[1]-1),Acc::program(TOKEN)];
 run(&w,&mut short,&[TAG_SWEEP_DONATION_TO_BURN,1]).unwrap();assert_eq!(balance(&short[3]),allocation[1]-1,"a short vault is left alone");
 let mut wrong_vault=vec![w.distribution_acc(),w.mint_acc(SUPPLY),w.authority_acc(1),w.vault_acc(2,allocation[2]+1),Acc::program(TOKEN)];
 assert_eq!(run(&w,&mut wrong_vault,&[TAG_SWEEP_DONATION_TO_BURN,1]).unwrap_err(),err(E_INVALID_TOKEN_ACCOUNT));
}
fn activation_accounts(w:&World,signer:Pubkey,campaign:Acc,parents:Acc,mint:Acc,source_amount:u64)->Vec<Acc>{
 let mut accounts=vec![Acc::empty(signer).signer(),Acc::empty(Pubkey::new_unique()).signer(),campaign,parents,mint,Acc::new(Pubkey::new_unique(),TOKEN,token_data(&w.mint,&signer,source_amount)),Acc::empty(w.distribution_key())];
 for p in 0..4u8{accounts.push(w.authority_acc(p));}for p in 0..4u8{accounts.push(w.vault_acc(p,0));}
 accounts.push(Acc::program(TOKEN));accounts.push(Acc::program(ATA));accounts.push(Acc::program(system_program::id()));accounts
}
fn activate_body(prior:[u64;4])->Vec<u8>{let mut b=vec![TAG_ACTIVATE];for p in prior{b.extend_from_slice(&p.to_le_bytes());}b}
#[test]fn activate_checks_campaign_parents_signer_mint_and_prior_counters_before_creating_anything(){
 let w=World::new();let launch_authority=Pubkey::find_program_address(&[b"launch_authority",w.campaign.as_ref()],&w.launch_program).0;
 let custody=SUPPLY-share(SUPPLY,LIQUIDITY_BPS);
 let mut valid=activation_accounts(&w,launch_authority,w.campaign_acc(3,0),w.parents_acc(),w.mint_acc(SUPPLY),custody);
 assert_eq!(run(&w,&mut valid,&activate_body([0;4])).unwrap_err(),err(HOST_CPI_UNSUPPORTED),"launch authority: every check passed up to vault creation");
 assert!(valid[6].data.is_empty(),"nothing written when creation is refused");
 let mut by_creator=activation_accounts(&w,w.creator,w.campaign_acc(3,0),w.parents_acc(),w.mint_acc(SUPPLY),custody);
 assert_eq!(run(&w,&mut by_creator,&activate_body([0;4])).unwrap_err(),err(HOST_CPI_UNSUPPORTED),"creator may activate");
 let mut stranger=activation_accounts(&w,Pubkey::new_unique(),w.campaign_acc(3,0),w.parents_acc(),w.mint_acc(SUPPLY),custody);
 assert_eq!(run(&w,&mut stranger,&activate_body([0;4])).unwrap_err(),err(E_UNAUTHORIZED));
 for phase in [0u8,1,2]{let mut early=activation_accounts(&w,launch_authority,w.campaign_acc(phase,0),w.parents_acc(),w.mint_acc(SUPPLY),custody);assert_eq!(run(&w,&mut early,&activate_body([0;4])).unwrap_err(),err(E_CAMPAIGN_NOT_LAUNCHED),"phase {phase}");}
 let mut foreign_parents=activation_accounts(&w,launch_authority,w.campaign_acc(3,0),w.parents_acc(),w.mint_acc(SUPPLY),custody);foreign_parents[3].owner=Pubkey::new_unique();
 assert_eq!(run(&w,&mut foreign_parents,&activate_body([0;4])).unwrap_err(),ProgramError::IncorrectProgramId);
 let mut wrong_mint=activation_accounts(&w,launch_authority,w.campaign_acc(3,0),w.parents_acc(),Acc::new(Pubkey::new_unique(),TOKEN,mint_data(SUPPLY)),custody);
 assert_eq!(run(&w,&mut wrong_mint,&activate_body([0;4])).unwrap_err(),err(E_INVALID_MINT));
 let mut with_authority=activation_accounts(&w,launch_authority,w.campaign_acc(3,0),w.parents_acc(),w.mint_acc(SUPPLY),custody);with_authority[4].data[0]=1;
 assert_eq!(run(&w,&mut with_authority,&activate_body([0;4])).unwrap_err(),err(E_INVALID_MINT),"mint authority still present");
 let mut wrong_prior=activation_accounts(&w,launch_authority,w.campaign_acc(3,0),w.parents_acc(),w.mint_acc(SUPPLY),custody);
 assert_eq!(run(&w,&mut wrong_prior,&activate_body([0,0,0,1])).unwrap_err(),err(E_PRIOR_COUNTER_MISMATCH),"dev prior must match the campaign counter");
 let mut migrated=activation_accounts(&w,launch_authority,w.campaign_acc(3,SUPPLY/100),w.parents_acc(),w.mint_acc(SUPPLY),custody);
 assert_eq!(run(&w,&mut migrated,&activate_body([0,0,0,SUPPLY/100])).unwrap_err(),err(HOST_CPI_UNSUPPORTED),"matching dev prior accepted");
 assert_eq!(run(&w,&mut migrated,&activate_body([0,0,0,0])).unwrap_err(),err(E_PRIOR_COUNTER_MISMATCH));
 let mut too_much=activation_accounts(&w,launch_authority,w.campaign_acc(3,0),w.parents_acc(),w.mint_acc(SUPPLY),custody);
 assert_eq!(run(&w,&mut too_much,&activate_body([allocations(SUPPLY)[0]+1,0,0,0])).unwrap_err(),err(E_PRIOR_COUNTER_MISMATCH),"prior above the allocation");
 let mut unsigned=activation_accounts(&w,launch_authority,w.campaign_acc(3,0),w.parents_acc(),w.mint_acc(SUPPLY),custody);unsigned[0].signer=false;
 assert_eq!(run(&w,&mut unsigned,&activate_body([0;4])).unwrap_err(),ProgramError::MissingRequiredSignature);
 let mut wrong_distribution=activation_accounts(&w,launch_authority,w.campaign_acc(3,0),w.parents_acc(),w.mint_acc(SUPPLY),custody);wrong_distribution[6]=Acc::empty(Pubkey::new_unique());
 assert_eq!(run(&w,&mut wrong_distribution,&activate_body([0;4])).unwrap_err(),err(E_INVALID_ACCOUNT));
 let mut wrong_vault=activation_accounts(&w,launch_authority,w.campaign_acc(3,0),w.parents_acc(),w.mint_acc(SUPPLY),custody);wrong_vault[11]=Acc::new(Pubkey::new_unique(),TOKEN,vec![0u8;165]);
 assert_eq!(run(&w,&mut wrong_vault,&activate_body([0;4])).unwrap_err(),err(E_INVALID_TOKEN_ACCOUNT),"vault must be the authority's associated token account");
 let mut wrong_authority=activation_accounts(&w,launch_authority,w.campaign_acc(3,0),w.parents_acc(),w.mint_acc(SUPPLY),custody);wrong_authority[8]=w.authority_acc(2);
 assert_eq!(run(&w,&mut wrong_authority,&activate_body([0;4])).unwrap_err(),err(E_INVALID_ACCOUNT));
}
#[test]fn token_account_and_mint_validation_reject_every_substitution(){
 let mint=Pubkey::new_unique();let owner=Pubkey::new_unique();let key=Pubkey::new_unique();
 for mutation in 0..7{let mut data=token_data(&mint,&owner,42);let mut program=TOKEN;
  match mutation{1=>data[72]=1,2=>data[108]=2,3=>data[129]=1,4=>data[32]^=1,5=>data[0]^=1,6=>program=Pubkey::new_unique(),_=>{}}
  let mut acc=Acc::new(key,program,data);let i=infos(std::slice::from_mut(&mut acc));
  let result=token(&i[0],&mint,&owner);if mutation==0{assert_eq!(result.unwrap(),42)}else{assert_eq!(result.unwrap_err(),err(E_INVALID_TOKEN_ACCOUNT),"mutation {mutation}")}
 }
 for mutation in 0..7{let mut data=mint_data(1000);let mut program=TOKEN;let mut key=mint;
  match mutation{1=>data[0]=1,2=>data[46]=1,3=>data[44]=9,4=>put64(&mut data,36,1001),5=>program=Pubkey::new_unique(),6=>key=Pubkey::new_unique(),_=>{}}
  let mut acc=Acc::new(key,program,data);let i=infos(std::slice::from_mut(&mut acc));
  let result=child_mint(&i[0],&mint,1000);if mutation==0{assert_eq!(result.unwrap(),1000)}else{assert_eq!(result.unwrap_err(),err(E_INVALID_MINT),"mutation {mutation}")}
 }
 let mut acc=Acc::new(mint,TOKEN,mint_data(999));let i=infos(std::slice::from_mut(&mut acc));assert_eq!(child_mint(&i[0],&mint,1000).unwrap(),999,"a lower supply after holder burns is fine");
}
