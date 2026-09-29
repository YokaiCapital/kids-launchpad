//! Synthetic terminal account fixtures; the separate validator test creates real
//! campaigns/pools and checks actual CPIs. This stub refuses every unrelated CPI.
use super::*;
use kids_launch_v2::state::*;
use solana_program::{instruction::Instruction, program_stubs::{set_syscall_stubs, SyscallStubs}};
use std::{cell::RefCell, sync::Once};
thread_local! { static CALLS: RefCell<usize> = const { RefCell::new(0) }; static PROGRAM: RefCell<Pubkey> = RefCell::new(Pubkey::default()); }
struct Transfers;
impl SyscallStubs for Transfers {
    fn sol_invoke_signed(&self, ix: &Instruction, accounts: &[AccountInfo], seeds: &[&[&[u8]]]) -> ProgramResult {
        assert_eq!(ix.program_id, system_program::id()); assert_eq!(ix.data.len(), 12);
        assert_eq!(&ix.data[..4], &2u32.to_le_bytes()); assert_eq!(ix.accounts.len(), 2);
        assert_eq!(seeds.len(), 1);
        let source = &accounts[0]; let recipient = &accounts[1];
        assert_eq!(ix.accounts[0].pubkey, *source.key); assert_eq!(ix.accounts[1].pubkey, *recipient.key);
        assert!(ix.accounts[0].is_signer); assert!(!ix.accounts[1].is_signer);
        assert_eq!(PROGRAM.with(|p| Pubkey::create_program_address(seeds[0], &p.borrow())).unwrap(), *source.key);
        let amount = u64::from_le_bytes(ix.data[4..].try_into().unwrap());
        let debit = source.lamports().checked_sub(amount).unwrap();
        let credit = recipient.lamports().checked_add(amount).unwrap();
        **source.try_borrow_mut_lamports()? = debit; **recipient.try_borrow_mut_lamports()? = credit;
        CALLS.with(|c| *c.borrow_mut() += 1); Ok(())
    }
}
fn info(key: Pubkey, owner: Pubkey, lamports: u64, data: Vec<u8>, writable: bool, executable: bool) -> AccountInfo<'static> {
    AccountInfo::new(Box::leak(Box::new(key)), false, writable, Box::leak(Box::new(lamports)),
        Box::leak(data.into_boxed_slice()), Box::leak(Box::new(owner)), executable, 0)
}
fn fixture(phase: u8) -> (Pubkey, Vec<AccountInfo<'static>>) {
    static INIT: Once = Once::new(); INIT.call_once(|| { set_syscall_stubs(Box::new(Transfers)); });
    let program = Pubkey::new_unique(); PROGRAM.with(|p| *p.borrow_mut() = program); CALLS.with(|c| *c.borrow_mut() = 0);
    let mut terms = Terms::decode(&vec![0; CAMPAIGN_LEN]).unwrap();
    terms.layout_version = LAYOUT_VERSION; terms.creator = Pubkey::new_unique(); terms.genesis = [7;32];
    let (key, bump) = terms.campaign_address(&program); let mut campaign = Campaign::fresh(terms, bump);
    campaign.state.phase = phase; let (authority, _) = campaign.launch_authority(&key, &program);
    let mut data = vec![0; CAMPAIGN_LEN]; campaign.encode(&mut data);
    (program, vec![info(key, program, 987654321, data, false, false),
        info(authority, system_program::id(), 123456, vec![], true, false),
        info(campaign.terms.creator, system_program::id(), 500, vec![], true, false),
        info(system_program::id(), Pubkey::new_unique(), 1, vec![], false, true)])
}
fn no_transfer(program: &Pubkey, a: &[AccountInfo], body: &[u8]) {
    let balances: Vec<_> = a.iter().map(|x| x.lamports()).collect();
    assert!(return_setup(program, a, body).is_err());
    assert_eq!(a.iter().map(|x| x.lamports()).collect::<Vec<_>>(), balances);
    assert_eq!(CALLS.with(|c| *c.borrow()), 0);
}
#[test]
fn terminal_only_and_fixed_destination() {
    for phase in [0, 1, 4, 255] { let (p,a)=fixture(phase); no_transfer(&p,&a,&[7;32]); }
    for phase in [PHASE_LIVE, PHASE_REFUND_ONLY] {
        let (p,a)=fixture(phase); let before=a[0].try_borrow_data().unwrap().to_vec();
        return_setup(&p,&a,&[7;32]).unwrap(); assert_eq!(a[1].lamports(),0); assert_eq!(a[2].lamports(),123956);
        assert_eq!(a[0].lamports(),987654321); assert_eq!(&*a[0].try_borrow_data().unwrap(), &before);
        return_setup(&p,&a,&[7;32]).unwrap(); assert_eq!(CALLS.with(|c| *c.borrow()),1);
    }
}
#[test]
fn rejects_foreign_campaign_pda_owner_and_terms_hash() {
    for fault in 0..3 { let (p,mut a)=fixture(PHASE_LIVE);
        match fault { 0=>a[0].owner=Box::leak(Box::new(Pubkey::new_unique())),
            1=>a[0].key=Box::leak(Box::new(Pubkey::new_unique())),
            _=>a[0].try_borrow_mut_data().unwrap()[OFF_CREATOR]^=1 }
        no_transfer(&p,&a,&[7;32]);
    }
}
#[test]
fn refuses_account_substitution_and_privilege_confusion() {
    for fault in 0..10 { let (p,mut a)=fixture(PHASE_LIVE);
        match fault {
            0=>a[1].key=Box::leak(Box::new(Pubkey::new_unique())),
            1=>a[1].owner=Box::leak(Box::new(p)),
            2=>a[1].is_writable=false, 3=>a[1].executable=true,
            4=>a[2].key=Box::leak(Box::new(Pubkey::new_unique())),
            5=>a[2].is_writable=false, 6=>a[2].executable=true,
            7=>a[3].executable=false,
            8=>a[3].key=Box::leak(Box::new(Pubkey::new_unique())),
            _=>*a[1].data.borrow_mut()=Box::leak(vec![0].into_boxed_slice())
        }; no_transfer(&p,&a,&[7;32]);
    }
}
#[test]
fn exact_instruction_shape_and_network_binding() {
    let(p,a)=fixture(PHASE_LIVE); no_transfer(&p,&a,&[6;32]); no_transfer(&p,&a,&[7;31]); no_transfer(&p,&a,&[7;33]);
    no_transfer(&p,&a[..3],&[7;32]); let mut extra=a.clone(); extra.push(a[0].clone()); no_transfer(&p,&extra,&[7;32]);
}
#[test]
fn pilot_blocks_foreign_creation_before_delegation() {
    let(p,a)=fixture(PHASE_LIVE);
    assert_eq!(process_instruction(&p,&a,&[0]),Err(ProgramError::Custom(E_PILOT_CREATOR)));
    assert_eq!(process_instruction(&p,&[],&[0]),Err(ProgramError::Custom(E_PILOT_CREATOR)));
    assert_eq!(process_instruction(&p,&[],&[]),Err(ProgramError::InvalidInstructionData));
    assert_eq!(process_instruction(&p,&[],&[255]),Err(ProgramError::InvalidInstructionData));
    assert_eq!(CALLS.with(|c| *c.borrow()),0);
}

#[test]
fn version_three_creation_seals_only_the_chosen_standard_economics() {
    use kids_launch_v2::state::SEALED_LEN;
    let mut body = vec![0u8; SEALED_LEN];
    assert!(!v3_economics_sealed(&body), "zeroed body carries no policy");
    body[OFF_SPLIT_POLICY - SEALED_START] = SPLIT_POLICY_STANDARD_V3;
    body[OFF_VESTING_RULE - SEALED_START] = VESTING_RULE_STANDARD_V3;
    assert!(v3_economics_sealed(&body));
    body[OFF_MODE - SEALED_START] = 1;
    assert!(!v3_economics_sealed(&body), "family bodies are not accepted by the version-3 issuer");
    body[OFF_MODE - SEALED_START] = 0;
    body[OFF_SPLIT_POLICY - SEALED_START] = 1;
    assert!(!v3_economics_sealed(&body), "the version-2 standard split is refused");
    body[OFF_SPLIT_POLICY - SEALED_START] = SPLIT_POLICY_STANDARD_V3;
    body[OFF_VESTING_RULE - SEALED_START] = 1;
    assert!(!v3_economics_sealed(&body), "the version-2 vesting rule is refused");
    assert!(!v3_economics_sealed(&body[..4]), "a short body is refused, never read out of bounds");
    // The dispatcher refuses such a creation before any account is touched.
    let key = PILOT_CREATOR; let owner = system_program::id(); let mut lamports = 0u64; let mut data = [0u8; 0];
    let creator = AccountInfo::new(&key, true, false, &mut lamports, &mut data, &owner, false, 0);
    let mut data = vec![kids_launch_v2::TAG_CREATE]; data.extend_from_slice(&body);
    let program = Pubkey::new_unique();
    assert_eq!(process_instruction(&program, &[creator], &data), Err(ProgramError::Custom(E_V3_ECONOMICS)));
}

fn compact_body(opens_at: u64, cid: &[u8]) -> Vec<u8> {
    let mut b = vec![0u8; CREATE_V3_FIXED_LEN];
    b[0..32].copy_from_slice(&[9u8; 32]); b[32..40].copy_from_slice(&77u64.to_le_bytes());
    b[40..72].copy_from_slice(Pubkey::new_from_array([5u8; 32]).as_ref()); b[72..80].copy_from_slice(&opens_at.to_le_bytes());
    b[80..84].copy_from_slice(&7200u32.to_le_bytes()); b[84..88].copy_from_slice(&7200u32.to_le_bytes());
    b[88..96].copy_from_slice(&1_000_000_000u64.to_le_bytes()); b[96..104].copy_from_slice(&5_000_000_000u64.to_le_bytes());
    b[104..106].copy_from_slice(&7u16.to_le_bytes()); b[106..138].copy_from_slice(&[3u8; 32]); b[138] = cid.len() as u8;
    b.extend_from_slice(cid); b
}
#[test]
fn compact_creation_expands_to_the_sealed_standard_terms() {
    let creator = Pubkey::new_unique(); let cid = b"QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco";
    let sealed = expand_create_v3(&compact_body(1_800_000_000, cid), &creator, 1_799_999_990).unwrap();
    let t = Terms::decode(&sealed).unwrap();
    assert_eq!((t.layout_version, t.mode, t.decimals, t.split_policy, t.vesting_rule, t.fee_routing_version, t.creator_fee_enabled), (LAYOUT_VERSION, MODE_STANDARD, 6, SPLIT_POLICY_STANDARD_V3, VESTING_RULE_STANDARD_V3, 1, 0));
    assert_eq!(t.genesis, [9u8; 32]); assert_eq!(t.creator, creator); assert_eq!(t.dev, creator); assert_eq!(t.nonce, 77); assert_eq!(t.treasury, PLATFORM_TREASURY);
    assert_eq!(t.child_mint, Pubkey::new_from_array([5u8; 32])); assert_eq!(t.supply, STANDARD_V3_SUPPLY);
    assert_eq!((t.opens_at, t.deadline, t.launch_deadline), (1_800_000_000, 1_800_007_200, 1_800_014_400));
    assert_eq!((t.soft, t.hard), (1_000_000_000, 5_000_000_000));
    assert_eq!((t.amm_program, t.amm_config, t.amm_trade_fee_rate, t.amm_config_index), (RAYDIUM_CPMM, AMM_CONFIG_TIERS[1].1, 25_000, 7));
    assert_eq!(t.split_bps, SplitBps::for_policy(SPLIT_POLICY_STANDARD_V3).unwrap()); assert_eq!(t.vesting, VestingRule::for_rule(VESTING_RULE_STANDARD_V3).unwrap());
    assert_eq!(t.fee_weights, FeeWeights::for_version_and_mode(1, MODE_STANDARD).unwrap());
    assert_eq!((t.lock_program, t.distribution_program, t.buyback_max_slippage_bps), (RAYDIUM_LOCK, Pubkey::default(), 0));
    assert_eq!(t.parent_mint, [Pubkey::default(); 2]); assert_eq!(t.parent_supply, [0; 2]); assert_eq!(t.parent_reference_config, [0; 2]);
    assert_eq!(t.metadata_hash, [3u8; 32]); assert_eq!(t.metadata_uri_len as usize, 34 + cid.len());
    assert_eq!(&t.metadata_uri[..t.metadata_uri_len as usize], [&b"https://gateway.pinata.cloud/ipfs/"[..], &cid[..]].concat().as_slice());
    assert!(t.metadata_uri[t.metadata_uri_len as usize..].iter().all(|b| *b == 0));
    // Re-encoding the decoded terms gives the same bytes: the expansion is exactly one sealed term set.
    let mut again = [0u8; SEALED_END]; t.encode(&mut again); assert_eq!(again[..], sealed[..]);
    assert!(v3_economics_sealed(&sealed[SEALED_START..]));
    // opens_at 0 means the chain's time at execution; the deadlines follow from it.
    let now_terms = Terms::decode(&expand_create_v3(&compact_body(0, cid), &creator, 1_234_567).unwrap()).unwrap();
    assert_eq!((now_terms.opens_at, now_terms.deadline, now_terms.launch_deadline), (1_234_567, 1_241_767, 1_248_967));
}
#[test]
fn compact_creation_refuses_malformed_bodies_before_any_account() {
    let creator = Pubkey::new_unique(); let cid = b"QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco"; let e = Err(ProgramError::Custom(E_CREATE_V3_BODY));
    let good = compact_body(1_800_000_000, cid); let near = 1_800_000_000 - 10; // the chain's time close to the scheduled opening
    assert!(expand_create_v3(&good, &creator, near).is_ok());
    assert_eq!(expand_create_v3(&good[..CREATE_V3_FIXED_LEN - 1], &creator, 1), e, "short body");
    assert_eq!(expand_create_v3(&[&good[..], b"x"].concat(), &creator, 1), e, "trailing byte");
    let mut bad_len = good.clone(); bad_len[138] = 0; assert_eq!(expand_create_v3(&bad_len, &creator, 1), e, "empty CID");
    let mut long = compact_body(1_800_000_000, &[b'Q'; 65]); long[138] = 65; assert_eq!(expand_create_v3(&long, &creator, 1), e, "CID over 64");
    let mut chars = good.clone(); chars[CREATE_V3_FIXED_LEN] = b'0'; assert_eq!(expand_create_v3(&chars, &creator, 1), e, "non-base58 character");
    let mut tier = good.clone(); tier[104..106].copy_from_slice(&3u16.to_le_bytes()); assert_eq!(expand_create_v3(&tier, &creator, 1), e, "unknown AMM tier");
    let mut funding = good.clone(); funding[80..84].copy_from_slice(&0u32.to_le_bytes()); assert_eq!(expand_create_v3(&funding, &creator, 1), e, "zero funding window");
    let mut huge = good.clone(); huge[72..80].copy_from_slice(&(i64::MAX as u64).to_le_bytes()); assert_eq!(expand_create_v3(&huge, &creator, 1), e, "deadline overflow");
    let mut negative = good.clone(); negative[72..80].copy_from_slice(&u64::MAX.to_le_bytes()); assert_eq!(expand_create_v3(&negative, &creator, 1), e, "opens_at beyond i64");
    assert_eq!(expand_create_v3(&compact_body(0, cid), &creator, 0), e, "the chain time itself must be positive");
    // Bounds sealed by the program: windows of at most 30 days, a scheduled opening at most 30 days ahead.
    let mut wide = good.clone(); wide[84..88].copy_from_slice(&(CREATE_V3_MAX_WINDOW_SECONDS + 1).to_le_bytes()); assert_eq!(expand_create_v3(&wide, &creator, near), e, "launch window over 30 days");
    let mut wide_funding = good.clone(); wide_funding[80..84].copy_from_slice(&u32::MAX.to_le_bytes()); assert_eq!(expand_create_v3(&wide_funding, &creator, near), e, "funding window over 30 days");
    let mut at_max = good.clone(); at_max[80..84].copy_from_slice(&CREATE_V3_MAX_WINDOW_SECONDS.to_le_bytes()); at_max[84..88].copy_from_slice(&CREATE_V3_MAX_WINDOW_SECONDS.to_le_bytes());
    let t = Terms::decode(&expand_create_v3(&at_max, &creator, near).unwrap()).unwrap(); assert_eq!(t.launch_deadline - t.opens_at, 2 * CREATE_V3_MAX_SCHEDULE_SECONDS, "exactly 30-day windows are accepted");
    assert_eq!(expand_create_v3(&good, &creator, 1_800_000_000 - CREATE_V3_MAX_SCHEDULE_SECONDS - 1), e, "scheduled opening more than 30 days ahead");
    assert!(expand_create_v3(&good, &creator, 1_800_000_000 - CREATE_V3_MAX_SCHEDULE_SECONDS).is_ok(), "an opening exactly 30 days ahead is accepted");
    assert!(expand_create_v3(&compact_body(0, cid), &creator, 1).is_ok(), "an opening at the chain's time never trips the schedule bound");
    // The dispatcher applies the pilot rule to the compact tag before reading the body.
    let (p, a) = fixture(PHASE_LIVE);
    let mut data = vec![TAG_CREATE_V3]; data.extend_from_slice(&good);
    assert_eq!(process_instruction(&p, &a, &data), Err(ProgramError::Custom(E_PILOT_CREATOR)));
    assert_eq!(process_instruction(&p, &[], &data), Err(ProgramError::NotEnoughAccountKeys));
    assert_eq!(CALLS.with(|c| *c.borrow()), 0);
}

/// Cross-language vectors: `localnet/protocol-v3/test-vectors.txt` (written by `make-test-vectors.mjs`) holds
/// `creator_hex now body_hex sealed_hex` per line; the program's expansion must produce the same 800 sealed bytes.
#[test]
fn compact_creation_matches_the_shared_vectors() {
    fn hex(s: &str) -> Vec<u8> { (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect() }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../localnet/protocol-v3/test-vectors.txt");
    let text = std::fs::read_to_string(&path).expect("test-vectors.txt");
    let mut checked = 0;
    for line in text.lines().filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let f: Vec<&str> = line.split_whitespace().collect(); assert_eq!(f.len(), 4, "creator now body sealed");
        let creator = Pubkey::new_from_array(hex(f[0]).try_into().unwrap()); let now: i64 = f[1].parse().unwrap();
        let sealed = expand_create_v3(&hex(f[2]), &creator, now).unwrap();
        assert_eq!(sealed[SEALED_START..].to_vec(), hex(f[3]), "vector {}", checked + 1); checked += 1;
    }
    assert!(checked >= 4, "at least four vectors");
}

// --- Funding-first, increment 1: body parsing, version gate, commit limits, extension and reservation codecs ---
mod funding_first_tests {
    use super::*;
    use crate::funding_first::*;
    fn compact_body(cid_len: usize) -> Vec<u8> { let mut b = vec![0u8; CREATE_V3_FIXED_LEN]; b[138] = cid_len as u8; b.extend(std::iter::repeat_n(b'a', cid_len)); b }
    #[test]
    fn open_body_is_split_exactly_and_refused_when_malformed() {
        let create = compact_body(59); let fee = Pubkey::new_unique();
        let mut body = create.clone(); body.extend([9u8; 32]); body.extend(fee.to_bytes());
        let open = parse_open_body(&body).unwrap();
        assert_eq!(open.create, &create[..]); assert_eq!(open.display_hash, [9u8; 32]); assert_eq!(open.fee_nft, fee);
        for bad in [body[..body.len() - 1].to_vec(), { let mut b = body.clone(); b.push(0); b }, { let mut b = body.clone(); b[create.len()..create.len() + 32].fill(0); b },
            { let mut b = body.clone(); b[create.len() + 32..].fill(0); b }, { let mut b = body.clone(); b[138] = 0; b }, vec![0u8; 10]] {
            assert_eq!(parse_open_body(&bad).unwrap_err(), ProgramError::Custom(E_OPEN_BODY));
        }
    }
    fn record(program: &Pubkey, version: u8, receipts: u64) -> AccountInfo<'static> {
        let mut terms = Terms::decode(&vec![0; CAMPAIGN_LEN]).unwrap(); terms.layout_version = LAYOUT_VERSION; terms.creator = Pubkey::new_unique();
        let (key, bump) = terms.campaign_address(program); let mut c = Campaign::fresh(terms, bump);
        c.state.accounting_version = version; c.state.receipt_count = receipts; let mut d = vec![0; CAMPAIGN_LEN]; c.encode(&mut d);
        info(key, *program, 1, d, true, false)
    }
    #[test]
    fn version_gate_sees_only_this_programs_version_two_records() {
        let program = Pubkey::new_unique();
        let v0 = record(&program, 0, 0); let v2 = record(&program, 2, 0);
        let foreign = { let mut a = record(&program, 2, 0); a.owner = Box::leak(Box::new(Pubkey::new_unique())); a };
        let other = info(Pubkey::new_unique(), system_program::id(), 1, vec![], true, false);
        assert!(!touches_funding_first(&program, &[other.clone(), v0.clone()]));
        assert!(touches_funding_first(&program, &[other.clone(), v2.clone()]));
        assert!(!touches_funding_first(&program, &[foreign]));
        for tag in [2u8, 3, 4, 5, 6, 7] { assert!(old_money_tag(tag)); }
        for tag in [0u8, 1, 8, 20, 21, 22, 23, 25, 26, 27, 40, 41] { assert!(!old_money_tag(tag)); }
        // Dispatch: an old money tag with a version-2 record among its accounts is refused before any handler runs.
        let accounts = [v2.clone(), other.clone()];
        assert_eq!(process_instruction(&program, &accounts, &[kids_launch_v2::TAG_FINALIZE]).unwrap_err(), ProgramError::Custom(E_ACCOUNTING_VERSION));
        assert_eq!(process_instruction(&program, &accounts, &[kids_launch_v2::TAG_LAUNCH]).unwrap_err(), ProgramError::Custom(E_ACCOUNTING_VERSION));
    }
    #[test]
    fn commit_limits_apply_only_to_new_receipts_of_version_two_records() {
        let program = Pubkey::new_unique(); let owner = info(Pubkey::new_unique(), system_program::id(), 5, vec![], true, false);
        let fresh = || info(Pubkey::new_unique(), system_program::id(), 0, vec![], true, false);
        let existing = || info(Pubkey::new_unique(), program, 1, vec![7u8; 128], true, false);
        let body = |amount: u64| { let mut b = vec![1u8; 32]; b.extend(amount.to_le_bytes()); b.extend(0u64.to_le_bytes()); b };
        // version 0: never limited
        assert!(commit_limits(&program, &[owner.clone(), record(&program, 0, 70_000), fresh()], &body(1)).is_ok());
        // version 2, new receipt: minimum and cap
        assert_eq!(commit_limits(&program, &[owner.clone(), record(&program, 2, 0), fresh()], &body(MIN_COMMIT_V2 - 1)).unwrap_err(), ProgramError::Custom(E_RECEIPT_LIMIT));
        assert!(commit_limits(&program, &[owner.clone(), record(&program, 2, 0), fresh()], &body(MIN_COMMIT_V2)).is_ok());
        assert_eq!(commit_limits(&program, &[owner.clone(), record(&program, 2, MAX_RECEIPTS_V2), fresh()], &body(MIN_COMMIT_V2)).unwrap_err(), ProgramError::Custom(E_RECEIPT_LIMIT));
        assert!(commit_limits(&program, &[owner.clone(), record(&program, 2, MAX_RECEIPTS_V2 - 1), fresh()], &body(MIN_COMMIT_V2)).is_ok());
        // version 2, top-up of an existing receipt: never limited by the cap or the minimum
        assert!(commit_limits(&program, &[owner.clone(), record(&program, 2, MAX_RECEIPTS_V2), existing()], &body(1)).is_ok());
    }
    #[test]
    fn extension_and_reservation_codecs_round_trip_and_refuse_wrong_magic_or_key() {
        let campaign = Pubkey::new_unique(); let mint = Pubkey::new_unique(); let nft = Pubkey::new_unique();
        let mut d = vec![0u8; EXT_LEN]; d[..8].copy_from_slice(EXT_MAGIC); d[OFF_EXT_CAMPAIGN..OFF_EXT_CAMPAIGN + 32].copy_from_slice(campaign.as_ref());
        d[OFF_EXT_TERMS_HASH..OFF_EXT_TERMS_HASH + 32].copy_from_slice(&[3u8; 32]); d[OFF_EXT_MINT..OFF_EXT_MINT + 32].copy_from_slice(mint.as_ref());
        d[OFF_EXT_FEE_NFT..OFF_EXT_FEE_NFT + 32].copy_from_slice(nft.as_ref()); d[OFF_EXT_DISPLAY_HASH..OFF_EXT_DISPLAY_HASH + 32].copy_from_slice(&[4u8; 32]); d[OFF_EXT_VERSION] = 2;
        let h = decode_ext_header(&d).unwrap();
        assert_eq!(h, ExtHeader { campaign, terms_hash: [3u8; 32], mint, fee_nft: nft, display_hash: [4u8; 32], version: 2, sealed: false });
        d[0] ^= 1; assert!(decode_ext_header(&d).is_err()); assert!(decode_ext_header(&d[..100]).is_err());
        let mut r = vec![0u8; RESERVATION_LEN]; r[..8].copy_from_slice(RESERVATION_MAGIC); r[8..40].copy_from_slice(campaign.as_ref()); r[40..72].copy_from_slice(mint.as_ref());
        assert_eq!(decode_reservation(&r, &mint).unwrap(), campaign); assert!(decode_reservation(&r, &nft).is_err());
        assert_eq!(SOFT_FLOOR_V2, 100 * MAX_RECEIPTS_V2); assert!(COLLATERAL_V2 >= MAX_RECEIPTS_V2);
    }
}
mod funding_first_launch_tests {
    use super::*;
    use crate::funding_first::*;
    fn borsh(s: &str) -> Vec<u8> { let mut v = (s.len() as u32).to_le_bytes().to_vec(); v.extend_from_slice(s.as_bytes()); v }
    #[test]
    fn launch_data_is_exactly_three_bounded_strings_and_hashes_as_committed() {
        let mut data = borsh("Funding First"); data.extend(borsh("FF")); data.extend(borsh("https://gateway.pinata.cloud/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco"));
        let (h, uri) = parse_launch_data(&data).unwrap();
        assert_eq!(h, solana_program::hash::hash(&data).to_bytes()); assert_eq!(uri, b"https://gateway.pinata.cloud/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco");
        for bad in [data[..data.len() - 1].to_vec(), { let mut b = data.clone(); b.push(0); b }, { let mut b = borsh(&"n".repeat(33)); b.extend(borsh("S")); b.extend(borsh("u")); b },
            { let mut b = borsh("n"); b.extend(borsh(&"S".repeat(11))); b.extend(borsh("u")); b }, { let mut b = borsh("n"); b.extend(borsh("S")); b.extend(borsh(&"u".repeat(129))); b },
            { let mut b = borsh(""); b.extend(borsh("S")); b.extend(borsh("u")); b }, vec![]] {
            assert_eq!(parse_launch_data(&bad).unwrap_err(), ProgramError::Custom(E_LAUNCH_V2));
        }
    }
    #[test]
    fn version_two_readiness_and_totals() {
        assert!(ready_v2(0, 10, 10, 100, 200, 100)); assert!(ready_v2(1, 11, 10, 100, 200, 199));
        assert!(!ready_v2(0, 9, 10, 100, 200, 100)); assert!(!ready_v2(0, 10, 10, 100, 200, 99)); assert!(!ready_v2(0, 10, 10, 100, 200, 200));
        assert!(!ready_v2(2, 10, 10, 100, 200, 150)); assert!(!ready_v2(3, 10, 10, 100, 200, 150));
        assert_eq!(totals_of(7, 10, 3).unwrap(), Totals { total: 7, accepted_target: 7, receipts: 3 });
        assert_eq!(totals_of(12, 10, 3).unwrap(), Totals { total: 12, accepted_target: 10, receipts: 3 });
        assert_eq!(totals_of(12, 10, MAX_RECEIPTS_V2 + 1).unwrap_err(), ProgramError::Custom(E_LAUNCH_V2));
        assert_eq!(totals_of(12, 10, MAX_RECEIPTS_V2).unwrap().receipts, 65_535);
        // Liability after valid excess refunds: c = [1.5e9, 1.5e9 + 1], H = A = 2e9, T = 3e9 + 1, accepted [999,999,999; 1e9],
        // S = 1,999,999,999, d = 1: both excess refunds paid before launch sum to T - S = 1,000,000,002 > T - A = 1,000,000,001.
        let (t, a, r) = (3_000_000_001u64, 2_000_000_000u64, 65_535u64);
        assert_eq!(liability_v2(t, a, 0, r).unwrap(), 1_000_000_001 + r);
        assert_eq!(liability_v2(t, a, 1_000_000_001, r).unwrap(), r);
        assert_eq!(liability_v2(t, a, 1_000_000_002, r).unwrap(), r - 1, "the dust came out of the collateral");
        assert_eq!(liability_v2(t, a, t - a + r + 1, r).unwrap_err(), ProgramError::Custom(E_LAUNCH_V2));
        assert_eq!(liability_v2(a, a, 0, r).unwrap(), r, "no excess: only the collateral stays");
        // Q allocation: floor(P * a_i / A); zero for a refunded receipt; A = 0 or a_i > A refused.
        let p = 475_000_000_000_000u64;
        assert_eq!(allocation_q(p, 20_001_000, 20_001_000).unwrap(), p);
        assert_eq!(allocation_q(p, 999_999_999, 2_000_000_000).unwrap(), 237_499_999_762_500);
        assert_eq!(allocation_q(p, 0, 2_000_000_000).unwrap(), 0);
        assert!(allocation_q(p, 1, 0).is_err()); assert!(allocation_q(p, 3, 2).is_err());
    }
}
