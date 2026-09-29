//! Checks every case of `localnet/protocol-v2/test-vectors.json` (written by `make-test-vectors.mjs` from the
//! JavaScript policy) against the Rust policy and the sealed-terms encoder. A small JSON reader is included so
//! the crate keeps its single dependency; amounts and times are decimal strings, 32-byte fields are hex.
use super::*;
use policy::*;
use state::*;
use std::str::FromStr;

#[derive(Debug,Clone,PartialEq)]
enum Json{Null,Bool(bool),Num(String),Str(String),Arr(Vec<Json>),Obj(Vec<(String,Json)>)}
struct Reader<'a>{bytes:&'a [u8],at:usize}
impl<'a> Reader<'a>{
 fn skip(&mut self){while self.at<self.bytes.len()&&matches!(self.bytes[self.at],b' '|b'\n'|b'\r'|b'\t'){self.at+=1;}}
 fn take(&mut self,expected:u8){self.skip();assert_eq!(self.bytes[self.at],expected,"json: expected {} at {}",expected as char,self.at);self.at+=1;}
 fn value(&mut self)->Json{
  self.skip();
  match self.bytes[self.at]{
   b'{'=>{self.at+=1;let mut fields=vec![];loop{self.skip();if self.bytes[self.at]==b'}'{self.at+=1;break}let key=self.string();self.take(b':');let value=self.value();fields.push((key,value));self.skip();if self.bytes[self.at]==b','{self.at+=1;}}Json::Obj(fields)},
   b'['=>{self.at+=1;let mut items=vec![];loop{self.skip();if self.bytes[self.at]==b']'{self.at+=1;break}items.push(self.value());self.skip();if self.bytes[self.at]==b','{self.at+=1;}}Json::Arr(items)},
   b'"'=>Json::Str(self.string()),
   b't'=>{self.at+=4;Json::Bool(true)},b'f'=>{self.at+=5;Json::Bool(false)},b'n'=>{self.at+=4;Json::Null},
   _=>{let start=self.at;while self.at<self.bytes.len()&&matches!(self.bytes[self.at],b'-'|b'+'|b'.'|b'e'|b'E'|b'0'..=b'9'){self.at+=1;}Json::Num(String::from_utf8(self.bytes[start..self.at].to_vec()).unwrap())}
  }
 }
 fn string(&mut self)->String{
  self.take(b'"');let mut out=vec![];
  loop{let b=self.bytes[self.at];self.at+=1;match b{b'"'=>break,b'\\'=>{let e=self.bytes[self.at];self.at+=1;out.push(match e{b'n'=>b'\n',b't'=>b'\t',b'r'=>b'\r',other=>other});},other=>out.push(other)}}
  String::from_utf8(out).unwrap()
 }
}
impl Json{
 fn get(&self,key:&str)->&Json{match self{Json::Obj(fields)=>&fields.iter().find(|(k,_)|k==key).unwrap_or_else(||panic!("json: no field {key}")).1,_=>panic!("json: {key} on a non-object")}}
 fn arr(&self)->&[Json]{match self{Json::Arr(items)=>items,_=>panic!("json: not an array")}}
 fn text(&self)->&str{match self{Json::Str(s)|Json::Num(s)=>s,_=>panic!("json: not text")}}
 fn u64(&self)->u64{u64::from_str(self.text()).unwrap()}
 fn i64(&self)->i64{i64::from_str(self.text()).unwrap()}
 fn u16(&self)->u16{u16::from_str(self.text()).unwrap()}
 fn u8(&self)->u8{u8::from_str(self.text()).unwrap()}
 fn bool(&self)->bool{match self{Json::Bool(b)=>*b,_=>panic!("json: not a bool")}}
 fn hex(&self)->Vec<u8>{let s=self.text();(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
 fn bytes32(&self)->[u8;32]{self.hex().try_into().expect("32 bytes")}
 fn key(&self)->Pubkey{Pubkey::new_from_array(self.bytes32())}
}
fn vectors()->Json{
 let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../localnet/protocol-v2/test-vectors.json");
 let text=std::fs::read(&path).unwrap_or_else(|e|panic!("read {}: {e}",path.display()));
 let mut reader=Reader{bytes:&text,at:0};let v=reader.value();assert_eq!(v.get("version").u64(),2,"vectors regenerated for the buyback fields (24 September 2026)");v
}
fn identities()->Json{
 let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../deployment/MAINNET-IDENTITIES.json");
 let text=std::fs::read(&path).unwrap_or_else(|e|panic!("read {}: {e}",path.display()));
 Reader{bytes:&text,at:0}.value()
}
#[cfg(not(feature="localnet-treasury"))]
#[test]fn the_pinned_treasury_is_the_mainnet_treasury_wallet_on_record_and_the_javascript_constant(){
 let recorded=identities().get("treasuryWallet").get("address").text().to_string();
 assert_eq!(Pubkey::from_str(&recorded).unwrap(),PLATFORM_TREASURY,"deployment/MAINNET-IDENTITIES.json treasuryWallet.address");
 assert_eq!(vectors().get("platformTreasury").hex(),PLATFORM_TREASURY.to_bytes().to_vec(),"policy.mjs PLATFORM_TREASURY_HEX");
 assert_eq!(key_from_hex("020d5fde31a2acb8ef4fb1e5f1f4034f1907798a66e887aa9255f3bcefca8bac"),PLATFORM_TREASURY.to_bytes());
 assert_eq!(key_from_hex(&"0A".repeat(32)),[10u8;32]);
}
#[test]fn buyback_floor_vectors_match(){
 let v=vectors();let cases=v.get("buybackFloor").arr();assert!(cases.len()>=12);
 for case in cases{
  let name=case.get("name").text();
  let out=reference_out(case.get("amount").u64(),case.get("reserveIn").u64(),case.get("reserveOut").u64(),case.get("tradeFeeRate").u64());
  match case.get("referenceOut"){
   Json::Null=>assert!(out.is_err(),"{name}: no reference"),
   expected=>{let out=out.unwrap();assert_eq!(out,expected.u64(),"{name}: reference out");assert_eq!(buyback_floor(out,case.get("maxSlippageBps").u16()),case.get("floor").u64(),"{name}: floor");}
  }
 }
 assert_eq!(v.get("buybackSlippageCeilingBps").u16(),BUYBACK_SLIPPAGE_CEILING_BPS);
}
#[test]fn settlement_and_refund_vectors_match_and_conserve(){
 let v=vectors();
 for case in v.get("settlement").arr(){
  let name=case.get("name").text();let hard=case.get("hard").u64();let total=case.get("total").u64();
  let commits:Vec<u64>=case.get("commits").arr().iter().map(|c|c.u64()).collect();
  assert_eq!(commits.iter().sum::<u64>(),total,"{name}: total");
  let mut sum=0u64;
  for(i,commit)in commits.iter().enumerate(){
   let a=accepted(*commit,total,hard);assert_eq!(a,case.get("accepted").arr()[i].u64(),"{name}: accepted {i}");
   let r=refundable(*commit,total,hard,false);assert_eq!(r,case.get("refundable").arr()[i].u64(),"{name}: refundable {i}");
   assert_eq!(a+r,*commit,"{name}: conservation {i}");sum+=a;
  }
  assert_eq!(sum,case.get("totalAccepted").u64(),"{name}: total accepted");assert!(sum<=hard.min(total),"{name}: within the cap");
 }
 assert!(v.get("settlement").arr().len()>=10);
 for case in v.get("refund").arr(){assert_eq!(refundable(case.get("commit").u64(),case.get("total").u64(),case.get("hard").u64(),case.get("failed").bool()),case.get("refundable").u64());}
}
#[test]fn split_participant_and_parent_vectors_match(){
 let v=vectors();
 for case in v.get("split").arr(){
  let s=split(case.get("supply").u64(),SplitBps::for_policy(case.get("policy").u8()).unwrap()).unwrap();
  assert_eq!((s.participants,s.liquidity,s.parent_a,s.parent_b,s.dev,s.dust_to_liquidity),(case.get("participants").u64(),case.get("liquidity").u64(),case.get("parentA").u64(),case.get("parentB").u64(),case.get("dev").u64(),case.get("dustToLiquidity").u64()),"supply {}",case.get("supply").text());
  assert_eq!(s.total().unwrap(),case.get("supply").u64());
 }
 assert_eq!(v.get("split").arr().len(),33);
 assert!(v.get("split").arr().iter().any(|c|c.get("policy").u8()==SPLIT_POLICY_STANDARD_V3),"version-3 standard split vectors present");
 for case in v.get("participantTokens").arr(){assert_eq!(participant_tokens(case.get("reserve").u64(),case.get("accepted").u64(),case.get("totalAccepted").u64()).unwrap(),case.get("tokens").u64());}
 for case in v.get("parentEligibility").arr(){assert_eq!(parent_threshold(case.get("parentSupply").u64()),case.get("threshold").u64());}
 for case in v.get("parentAllocation").arr(){assert_eq!(parent_allocation(case.get("reserve").u64(),case.get("balance").u64(),case.get("eligible").u64()).unwrap(),case.get("allocation").u64());}
}
#[test]fn calendar_and_vesting_vectors_match(){
 let v=vectors();
 for case in v.get("calendarMonths").arr(){assert_eq!(calendar_months_after(case.get("start").i64(),case.get("months").u8()).unwrap(),case.get("end").i64(),"start {}",case.get("start").text());}
 for case in v.get("vesting").arr(){
  let start=case.get("start").i64();let now=case.get("now").i64();
  assert_eq!(calendar_months_after(start,3).unwrap(),case.get("end").i64());
  let rule=VestingRule::for_rule(case.get("rule").u8()).expect("vesting rule id");
  assert_eq!(dev_entitled(case.get("supply").u64(),rule,start,now).unwrap(),case.get("entitled").u64(),"supply {} start {start} now {now}",case.get("supply").text());
 }
 assert!(v.get("vesting").arr().len()>=80);
 assert!(v.get("vesting").arr().iter().any(|c|c.get("rule").u8()==VESTING_RULE_STANDARD_V3),"version-3 vesting vectors present");
}
#[test]fn fee_routing_and_lifecycle_vectors_match(){
 let v=vectors();
 for case in v.get("feeRouting").arr(){
  let e=fee_entitlements(case.get("collected").u64(),FeeWeights::for_version_and_mode(case.get("version").u8(),case.get("mode").u8()).unwrap()).unwrap();
  assert_eq!((e.treasury,e.dev,e.parent_a,e.parent_b,e.dust),(case.get("treasury").u64(),case.get("dev").u64(),case.get("parentA").u64(),case.get("parentB").u64(),case.get("dust").u64()));
 }
 for case in v.get("lifecycle").arr(){
  let phase=case.get("phase").u8();let now=case.get("now").i64();
  let r=Readiness{phase,soft:case.get("soft").u64(),deadline:case.get("deadline").i64(),launch_deadline:case.get("launchDeadline").i64(),total:case.get("total").u64(),receipt_count:case.get("receiptCount").u64(),settled_count:case.get("settledCount").u64(),settled_accepted:case.get("settledAccepted").u64()};
  assert_eq!(funding_open(phase,case.get("opensAt").i64(),r.deadline,now),case.get("fundingOpen").bool(),"funding open at {now}");
  assert_eq!(launch_failed(phase,r.total,r.soft,r.launch_deadline,now),case.get("failed").bool(),"failed at {now}");
  assert_eq!(launch_ready(r,now),case.get("ready").bool(),"ready at {now}");
 }
}
fn terms_from(j:&Json)->Terms{
 let uri=j.get("metadataUri").text().as_bytes();let mut metadata_uri=[0u8;METADATA_URI_MAX];metadata_uri[..uri.len()].copy_from_slice(uri);
 let pair_keys=|name:&str|->[Pubkey;2]{let a=j.get(name).arr();[a[0].key(),a[1].key()]};
 let pair_u64=|name:&str|->[u64;2]{let a=j.get(name).arr();[a[0].u64(),a[1].u64()]};
 let roots=j.get("parentRoot").arr();
 Terms{layout_version:j.get("layoutVersion").u16(),mode:j.get("mode").u8(),decimals:j.get("decimals").u8(),split_policy:j.get("splitPolicy").u8(),vesting_rule:j.get("vestingRule").u8(),fee_routing_version:j.get("feeRoutingVersion").u8(),creator_fee_enabled:j.get("creatorFeeEnabled").u8(),
  genesis:j.get("genesis").bytes32(),creator:j.get("creator").key(),nonce:j.get("nonce").u64(),dev:j.get("dev").key(),treasury:j.get("treasury").key(),child_mint:j.get("childMint").key(),supply:j.get("supply").u64(),
  opens_at:j.get("opensAt").i64(),deadline:j.get("deadline").i64(),launch_deadline:j.get("launchDeadline").i64(),soft:j.get("soft").u64(),hard:j.get("hard").u64(),
  amm_program:j.get("ammProgram").key(),amm_config:j.get("ammConfig").key(),amm_trade_fee_rate:j.get("ammTradeFeeRate").u64(),amm_config_index:j.get("ammConfigIndex").u16(),
  fee_weights:FeeWeights{treasury:j.get("feeWeights").get("treasury").u16(),dev:j.get("feeWeights").get("dev").u16(),parent_a:j.get("feeWeights").get("parentA").u16(),parent_b:j.get("feeWeights").get("parentB").u16()},buyback_max_slippage_bps:j.get("buybackMaxSlippageBps").u16(),
  split_bps:SplitBps{participants:j.get("splitBps").get("participants").u16(),liquidity:j.get("splitBps").get("liquidity").u16(),parent_a:j.get("splitBps").get("parentA").u16(),parent_b:j.get("splitBps").get("parentB").u16(),dev:j.get("splitBps").get("dev").u16()},
  vesting:VestingRule{instant_bps:j.get("vesting").get("instantBps").u16(),linear_bps:j.get("vesting").get("linearBps").u16(),months:j.get("vesting").get("months").u8()},
  lock_program:j.get("lockProgram").key(),distribution_program:j.get("distributionProgram").key(),
  parent_mint:pair_keys("parentMint"),parent_program:pair_keys("parentProgram"),parent_slot:pair_u64("parentSlot"),parent_root:[roots[0].bytes32(),roots[1].bytes32()],parent_supply:pair_u64("parentSupply"),parent_eligible:pair_u64("parentEligible"),parent_expiry_seconds:j.get("parentExpirySeconds").u64(),
  metadata_hash:j.get("metadataHash").bytes32(),metadata_uri_len:uri.len() as u8,metadata_uri,
  parent_reference_config:{let a=j.get("parentReferenceConfig").arr();[a[0].u8(),a[1].u8()]}}
}
#[test]fn sealed_terms_encode_and_hash_identically_in_rust_and_javascript(){
 let v=vectors();let cases=v.get("termsHash").arr();assert_eq!(cases.len(),3);
 for case in cases{
  let name=case.get("name").text();let terms=terms_from(case.get("terms"));
  let mut d=vec![0u8;SEALED_END];terms.encode(&mut d);
  assert_eq!(d[SEALED_START..SEALED_END].to_vec(),case.get("sealedHex").hex(),"{name}: sealed bytes");
  assert_eq!(terms.hash().to_vec(),case.get("hash").hex(),"{name}: hash");
  assert_eq!(Terms::decode(&d).unwrap(),terms,"{name}: round trip through the JavaScript encoding");
  let mut from_js=vec![0u8;SEALED_START];from_js.extend(case.get("sealedHex").hex());assert_eq!(Terms::decode(&from_js).unwrap(),terms,"{name}: decode the JavaScript bytes");
 }
 let standard=terms_from(cases[0].get("terms"));assert_eq!(standard.mode,MODE_STANDARD);assert_eq!(standard.split().unwrap().parent_a,0);
 let family=terms_from(cases[1].get("terms"));assert_eq!(family.mode,MODE_FAMILY);assert_eq!(family.split().unwrap().parent_a,50_000_000_000_000);assert_eq!(family.metadata_uri().len(),128);
 assert_eq!(family.buyback_max_slippage_bps,150);assert_eq!((family.reference_config_index(0),family.reference_config_index(1)),(Some(0),Some(7)));
 assert_eq!(standard.buyback_max_slippage_bps,0);assert_eq!(standard.reference_config_index(0),None);
 let extremes=terms_from(cases[2].get("terms"));assert_eq!(extremes.supply,u64::MAX);assert_eq!(extremes.launch_deadline,i64::MAX);assert_eq!(extremes.nonce,u64::MAX);
 assert_eq!(extremes.buyback_max_slippage_bps,u16::MAX);assert_eq!(extremes.reference_config_index(1),Some(254),"255 is index 254");
}
