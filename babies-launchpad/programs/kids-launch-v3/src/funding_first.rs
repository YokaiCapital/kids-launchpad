//! Funding-first accounting (accounting version 2), increment 1: the funding-only opening (tag 41) and the version gate
//! that keeps every existing handler byte-for-byte for version-0 records while refusing the old money tags on a
//! version-2 record. No token exists during funding: the reserved mint and fee-NFT keypairs sign the opening (proof of
//! control), the program records them in the extension PDA and reserves both addresses with program-derived accounts,
//! and the creator's rounding collateral is moved into the campaign. Launch, claims, refunds, close, accounting and the
//! collateral return (tags 42..47) are later increments; until they exist a version-2 campaign only accepts commits.
use solana_program::{account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, program::{invoke, invoke_signed},
    program_error::ProgramError, pubkey::Pubkey, rent::Rent, sysvar::Sysvar, system_instruction, system_program};
use kids_launch_v2::{state::{Campaign, CAMPAIGN_LEN, CAMPAIGN_MAGIC, SEALED_START, SEALED_END, OFF_ACCOUNTING_VERSION, OFF_CHILD_MINT, OFF_SOFT,
    OFF_TERMS_HASH, OFF_RECEIPT_COUNT, ACCOUNTING_VERSION_FUNDING_FIRST, LAUNCH_AUTHORITY_SEED, OFF_PHASE, OFF_TOTAL, OFF_REFUNDED,
    OFF_CREATOR, OFF_NONCE, OFF_HARD, OFF_DEADLINE, OFF_LAUNCH_DEADLINE, CAMPAIGN_SEED}, handlers, launch, read64, read_key,
    TAG_COMMIT, TAG_FINALIZE, TAG_REFUND, TAG_SETTLE, TAG_ASSERT_READY, TAG_LAUNCH, TAG_CLAIM_PARTICIPANT, E_NOT_READY, E_BEFORE_DEADLINE,
    E_REFUND_DESTINATION, E_OVERFLOW, E_NOT_LAUNCHED, E_CLAIM_INVALID, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, METADATA_PROGRAM,
    state::Receipt, policy::{PHASE_FUNDING, PHASE_CLOSED, PHASE_REFUND_ONLY, PHASE_LIVE, accepted, refundable, launch_failed, terms_hash}};
use solana_program::{instruction::{AccountMeta, Instruction}, hash::hashv};
use crate::{expand_create_v3, CREATE_V3_FIXED_LEN, PILOT_CREATOR, E_PILOT_CREATOR};

pub const TAG_OPEN_FUNDING: u8 = 41;
/// Tag 42: seal the totals and launch (mint, supply, metadata, pool, permanent lock) in one instruction.
pub const TAG_LAUNCH_V2: u8 = 42;
pub const TAG_CLAIM_V2: u8 = 43;
pub const TAG_REFUND_V2: u8 = 44;
pub const TAG_CLOSE_V2: u8 = 45;
pub const TAG_ACCOUNT_V2: u8 = 46;
pub const TAG_RETURN_COLLATERAL_V2: u8 = 47;
/// Accounting or collateral state refused: already accounted, accounting incomplete, already returned, wrong creator.
pub const E_ACCOUNTING_V2: u32 = 109;
/// Malformed launch data, display hash mismatch, extension or reservation mismatch, receipt count above the version-2 cap.
pub const E_LAUNCH_V2: u32 = 108;
pub const STANDARD_V3_DECIMALS_V2: u8 = 6;
pub const MINT_LEN: usize = 82;
pub const LAUNCH_V2_EXTRA_ACCOUNTS: usize = 4;
pub const DISPLAY_NAME_MAX: usize = 32;
pub const DISPLAY_SYMBOL_MAX: usize = 10;
pub const DISPLAY_URI_MAX: usize = 128;
/// The tag is not available for the record's accounting version (old money tags on a version-2 record, new tags on
/// a version-0 record).
pub const E_ACCOUNTING_VERSION: u32 = 105;
/// Malformed opening body, wrong signer, unsafe pre-funded address, or a reservation that already exists.
pub const E_OPEN_BODY: u32 = 106;
/// Version 2 receipt limits: a new receipt needs at least `MIN_COMMIT_V2` lamports and free room under `MAX_RECEIPTS_V2`.
pub const E_RECEIPT_LIMIT: u32 = 107;
pub const MAX_RECEIPTS_V2: u64 = 65_535;
pub const MIN_COMMIT_V2: u64 = 1_000_000;
/// Lower bound of the soft cap for version 2 (100 × MAX_RECEIPTS_V2): with `hard ≥ soft + ceil(soft/100)` it makes
/// `T ≥ soft` exactly today's launchability (every accepted amount floors at most one lamport, N ≤ 65,535).
pub const SOFT_FLOOR_V2: u64 = 6_553_500;
/// Rounding collateral moved into the campaign at opening: strictly above the largest possible dust (`d < N ≤ 65,535`).
pub const COLLATERAL_V2: u64 = 65_535;
pub const EXT_SEED: &[u8] = b"ext";
pub const MINT_RESERVATION_SEED: &[u8] = b"mint";
pub const NFT_RESERVATION_SEED: &[u8] = b"nft";
pub const EXT_LEN: usize = 256;
pub const RESERVATION_LEN: usize = 72;
pub const EXT_MAGIC: &[u8; 8] = b"KIDSEXT2";
pub const RESERVATION_MAGIC: &[u8; 8] = b"KIDSRSV2";
/// Extension layout: 0 magic, 8 campaign, 40 terms_hash, 72 mint, 104 fee_nft, 136 display_hash, 168 accounting
/// version, 169 sealed flag, 172 sealed receipts u32, 176 sealed total u64, 184 accepted target u64, 192 accounted
/// count u32, 196 claims paid u32, 200 accounted accepted u64, 208 collateral returned u64, 216..256 zero.
pub const OFF_EXT_CAMPAIGN: usize = 8;
pub const OFF_EXT_TERMS_HASH: usize = 40;
pub const OFF_EXT_MINT: usize = 72;
pub const OFF_EXT_FEE_NFT: usize = 104;
pub const OFF_EXT_DISPLAY_HASH: usize = 136;
pub const OFF_EXT_VERSION: usize = 168;
pub const OFF_EXT_SEALED: usize = 169;
pub const OFF_EXT_SEALED_RECEIPTS: usize = 172;
pub const OFF_EXT_SEALED_TOTAL: usize = 176;
pub const OFF_EXT_ACCEPTED_TARGET: usize = 184;
pub const OFF_EXT_ACCOUNTED_COUNT: usize = 192;
pub const OFF_EXT_CLAIMS_PAID: usize = 196;
pub const OFF_EXT_ACCOUNTED_ACCEPTED: usize = 200;
pub const OFF_EXT_COLLATERAL_RETURNED: usize = 208;
/// Opening body after the tag: the compact creation body of tag 40 (139 bytes + CID), then the display hash (32) and
/// the fee-NFT mint address (32). The reserved child mint is the one inside the compact body.
pub const OPEN_TAIL_LEN: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenBody<'a> { pub create: &'a [u8], pub display_hash: [u8; 32], pub fee_nft: Pubkey }

/// Splits the opening body without touching any account. Refuses a body whose creation part is not exactly the
/// compact creation shape (`expand_create_v3` validates the rest).
pub fn parse_open_body(body: &[u8]) -> Result<OpenBody<'_>, ProgramError> {
    let e = || ProgramError::Custom(E_OPEN_BODY);
    if body.len() < CREATE_V3_FIXED_LEN + OPEN_TAIL_LEN { return Err(e()); }
    let cid_len = body[138] as usize;
    let create_len = CREATE_V3_FIXED_LEN + cid_len;
    if cid_len == 0 || body.len() != create_len + OPEN_TAIL_LEN { return Err(e()); }
    let display_hash: [u8; 32] = body[create_len..create_len + 32].try_into().unwrap();
    if display_hash == [0u8; 32] { return Err(e()); }
    let fee_nft = Pubkey::new_from_array(body[create_len + 32..create_len + 64].try_into().unwrap());
    if fee_nft == Pubkey::default() { return Err(e()); }
    Ok(OpenBody { create: &body[..create_len], display_hash, fee_nft })
}

/// True when any account of the instruction is a campaign record of this program that carries accounting version 2.
/// Old money tags are refused on such a record; the check reads only the magic and the version byte, so it costs
/// nothing for version-0 records and never depends on the tag's account order.
pub fn touches_funding_first(program: &Pubkey, accounts: &[AccountInfo]) -> bool {
    accounts.iter().any(|a| {
        if a.owner != program { return false; }
        match a.try_borrow_data() {
            Ok(d) => d.len() == CAMPAIGN_LEN && &d[..8] == CAMPAIGN_MAGIC && d[OFF_ACCOUNTING_VERSION] == ACCOUNTING_VERSION_FUNDING_FIRST,
            Err(_) => false,
        }
    })
}

/// Tags whose money semantics are replaced in version 2 (finalize, refund, settle, assert-ready, launch, participant
/// claim). Everything else (commit with the limits below, developer vesting, the fee cycle, setup return) stays.
pub const fn old_money_tag(tag: u8) -> bool {
    matches!(tag, TAG_FINALIZE | TAG_REFUND | TAG_SETTLE | TAG_ASSERT_READY | TAG_LAUNCH | TAG_CLAIM_PARTICIPANT)
}

/// The version-2 limits of a commit, evaluated before the version-2 handler runs: a NEW receipt (system-owned, empty
/// account at index 2) needs `amount ≥ MIN_COMMIT_V2` and `receipt_count < MAX_RECEIPTS_V2`; a top-up of an existing
/// receipt is never limited here. Returns Ok(()) untouched for version-0 records.
pub fn commit_limits(program: &Pubkey, accounts: &[AccountInfo], body: &[u8]) -> ProgramResult {
    if accounts.len() < 3 || body.len() < 40 { return Ok(()); }
    let campaign = &accounts[1];
    if campaign.owner != program { return Ok(()); }
    let d = campaign.try_borrow_data()?;
    if d.len() != CAMPAIGN_LEN || &d[..8] != CAMPAIGN_MAGIC || d[OFF_ACCOUNTING_VERSION] != ACCOUNTING_VERSION_FUNDING_FIRST { return Ok(()); }
    let receipt = &accounts[2];
    let fresh = receipt.owner == &system_program::id() && receipt.data_is_empty();
    if !fresh { return Ok(()); }
    let amount = read64(body, 32)?;
    let count = read64(&d, OFF_RECEIPT_COUNT)?;
    if amount < MIN_COMMIT_V2 || count >= MAX_RECEIPTS_V2 { return Err(ProgramError::Custom(E_RECEIPT_LIMIT)); }
    Ok(())
}

fn create_program_account<'a>(payer: &AccountInfo<'a>, target: &AccountInfo<'a>, system: &AccountInfo<'a>, program: &Pubkey,
    len: usize, seeds: &[&[u8]]) -> ProgramResult {
    // A merely funded, system-owned, empty address is completed instead of refused (the address is public before the
    // account exists); anything owned by another program or holding data is refused.
    if target.owner != &system_program::id() || !target.data_is_empty() { return Err(ProgramError::Custom(E_OPEN_BODY)); }
    let rent = Rent::get()?.minimum_balance(len);
    if target.lamports() == 0 {
        invoke_signed(&system_instruction::create_account(payer.key, target.key, rent, len as u64, program),
            &[payer.clone(), target.clone(), system.clone()], &[seeds])
    } else {
        let short = rent.saturating_sub(target.lamports());
        if short > 0 {
            invoke(&system_instruction::transfer(payer.key, target.key, short), &[payer.clone(), target.clone(), system.clone()])?;
        }
        invoke_signed(&system_instruction::allocate(target.key, len as u64), &[target.clone(), system.clone()], &[seeds])?;
        invoke_signed(&system_instruction::assign(target.key, program), &[target.clone(), system.clone()], &[seeds])
    }
}

fn write_reservation(account: &AccountInfo, campaign: &Pubkey, key: &Pubkey) -> ProgramResult {
    let mut d = account.try_borrow_mut_data()?;
    if d.len() != RESERVATION_LEN { return Err(ProgramError::InvalidAccountData); }
    d[..8].copy_from_slice(RESERVATION_MAGIC); d[8..40].copy_from_slice(campaign.as_ref()); d[40..72].copy_from_slice(key.as_ref());
    Ok(())
}

/// Tag 41. Accounts (exactly nine): 0 creator (signer, writable, pays everything), 1 campaign PDA (writable),
/// 2 extension PDA `["ext", campaign]` (writable), 3 mint reservation `["mint", child_mint]` (writable), 4 fee-NFT
/// reservation `["nft", fee_nft]` (writable), 5 reserved child mint (signer), 6 reserved fee-NFT mint (signer),
/// 7 System program, 8 AMM config of the sealed tier. Body: see `OPEN_TAIL_LEN`. The work is split into small frames:
/// the SBF stack is 4 KiB and the sealed terms alone are 808 bytes.
pub fn open_funding(program: &Pubkey, accounts: &[AccountInfo], body: &[u8]) -> ProgramResult {
    let e = || ProgramError::Custom(E_OPEN_BODY);
    if accounts.len() != 9 { return Err(ProgramError::NotEnoughAccountKeys); }
    let creator = &accounts[0]; let campaign = &accounts[1]; let mint = &accounts[5]; let fee_nft = &accounts[6]; let system = &accounts[7];
    if *creator.key != PILOT_CREATOR { return Err(ProgramError::Custom(E_PILOT_CREATOR)); }
    if !creator.is_signer || !mint.is_signer || !fee_nft.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    if *system.key != system_program::id() || !system.executable { return Err(e()); }
    let open = parse_open_body(body)?;
    if open.fee_nft != *fee_nft.key || *fee_nft.key == *mint.key { return Err(e()); }
    // The token does not exist during funding: both reserved addresses must be plain system addresses (empty or merely
    // funded), never a mint or any other program's account.
    for a in [mint, fee_nft] {
        if a.owner != &system_program::id() || !a.data_is_empty() || a.executable { return Err(e()); }
    }
    let terms_hash = create_record(program, accounts, open.create)?;
    reserve_and_extend(program, accounts, &open, &terms_hash)?;
    // Rounding collateral, kept by the campaign until the exact-once accounting proves the surplus (later increment).
    invoke(&system_instruction::transfer(creator.key, campaign.key, COLLATERAL_V2), &[creator.clone(), campaign.clone(), system.clone()])
}

/// Expands the compact body, checks the funding-first bounds on the sealed bytes, runs the version-2 create (every sealed
/// field, the AMM config and the campaign address validated exactly as for tag 40) and marks the record with the
/// accounting version in the same instruction. Returns the sealed terms hash.
#[inline(never)]
fn create_record(program: &Pubkey, accounts: &[AccountInfo], create: &[u8]) -> Result<[u8; 32], ProgramError> {
    let e = || ProgramError::Custom(E_OPEN_BODY);
    let creator = &accounts[0]; let campaign = &accounts[1]; let mint = &accounts[5]; let system = &accounts[7]; let amm = &accounts[8];
    let now = Clock::get()?.unix_timestamp;
    let sealed = expand_create_v3(create, creator.key, now)?;
    if &sealed[OFF_CHILD_MINT..OFF_CHILD_MINT + 32] != mint.key.as_ref() || read64(&sealed, OFF_SOFT)? < SOFT_FLOOR_V2 { return Err(e()); }
    handlers::create(program, &[creator.clone(), campaign.clone(), system.clone(), amm.clone()], &sealed[SEALED_START..SEALED_END])?;
    let mut d = campaign.try_borrow_mut_data()?;
    if d.len() != CAMPAIGN_LEN || &d[..8] != CAMPAIGN_MAGIC { return Err(ProgramError::InvalidAccountData); }
    d[OFF_ACCOUNTING_VERSION] = ACCOUNTING_VERSION_FUNDING_FIRST;
    Ok(d[OFF_TERMS_HASH..OFF_TERMS_HASH + 32].try_into().unwrap())
}

/// Reservations (first writer wins; the writer proved control of both keys by signing) and the extension header.
#[inline(never)]
fn reserve_and_extend(program: &Pubkey, accounts: &[AccountInfo], open: &OpenBody, terms_hash: &[u8; 32]) -> ProgramResult {
    let creator = &accounts[0]; let campaign = &accounts[1]; let ext = &accounts[2]; let mint_res = &accounts[3];
    let nft_res = &accounts[4]; let mint = &accounts[5]; let fee_nft = &accounts[6]; let system = &accounts[7];
    let (mint_res_key, mint_bump) = Pubkey::find_program_address(&[MINT_RESERVATION_SEED, mint.key.as_ref()], program);
    let (nft_res_key, nft_bump) = Pubkey::find_program_address(&[NFT_RESERVATION_SEED, fee_nft.key.as_ref()], program);
    let (ext_key, ext_bump) = Pubkey::find_program_address(&[EXT_SEED, campaign.key.as_ref()], program);
    if *mint_res.key != mint_res_key || *nft_res.key != nft_res_key || *ext.key != ext_key { return Err(ProgramError::InvalidSeeds); }
    create_program_account(creator, mint_res, system, program, RESERVATION_LEN, &[MINT_RESERVATION_SEED, mint.key.as_ref(), &[mint_bump]])?;
    write_reservation(mint_res, campaign.key, mint.key)?;
    create_program_account(creator, nft_res, system, program, RESERVATION_LEN, &[NFT_RESERVATION_SEED, fee_nft.key.as_ref(), &[nft_bump]])?;
    write_reservation(nft_res, campaign.key, fee_nft.key)?;
    create_program_account(creator, ext, system, program, EXT_LEN, &[EXT_SEED, campaign.key.as_ref(), &[ext_bump]])?;
    let mut d = ext.try_borrow_mut_data()?;
    if d.len() != EXT_LEN { return Err(ProgramError::InvalidAccountData); }
    d.fill(0);
    d[..8].copy_from_slice(EXT_MAGIC);
    d[OFF_EXT_CAMPAIGN..OFF_EXT_CAMPAIGN + 32].copy_from_slice(campaign.key.as_ref());
    d[OFF_EXT_TERMS_HASH..OFF_EXT_TERMS_HASH + 32].copy_from_slice(terms_hash);
    d[OFF_EXT_MINT..OFF_EXT_MINT + 32].copy_from_slice(mint.key.as_ref());
    d[OFF_EXT_FEE_NFT..OFF_EXT_FEE_NFT + 32].copy_from_slice(fee_nft.key.as_ref());
    d[OFF_EXT_DISPLAY_HASH..OFF_EXT_DISPLAY_HASH + 32].copy_from_slice(&open.display_hash);
    d[OFF_EXT_VERSION] = ACCOUNTING_VERSION_FUNDING_FIRST;
    Ok(())
}

/// Decoded extension header, for readers and later handlers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExtHeader { pub campaign: Pubkey, pub terms_hash: [u8; 32], pub mint: Pubkey, pub fee_nft: Pubkey, pub display_hash: [u8; 32], pub version: u8, pub sealed: bool }
pub fn decode_ext_header(d: &[u8]) -> Result<ExtHeader, ProgramError> {
    if d.len() != EXT_LEN || &d[..8] != EXT_MAGIC { return Err(ProgramError::InvalidAccountData); }
    let key = |at: usize| Pubkey::new_from_array(d[at..at + 32].try_into().unwrap());
    let bytes = |at: usize| -> [u8; 32] { d[at..at + 32].try_into().unwrap() };
    Ok(ExtHeader { campaign: key(OFF_EXT_CAMPAIGN), terms_hash: bytes(OFF_EXT_TERMS_HASH), mint: key(OFF_EXT_MINT), fee_nft: key(OFF_EXT_FEE_NFT),
        display_hash: bytes(OFF_EXT_DISPLAY_HASH), version: d[OFF_EXT_VERSION], sealed: d[OFF_EXT_SEALED] != 0 })
}

/// Reads a reservation and returns the campaign it belongs to.
pub fn decode_reservation(d: &[u8], key: &Pubkey) -> Result<Pubkey, ProgramError> {
    if d.len() != RESERVATION_LEN || &d[..8] != RESERVATION_MAGIC || &d[40..72] != key.as_ref() { return Err(ProgramError::InvalidAccountData); }
    Ok(Pubkey::new_from_array(d[8..40].try_into().unwrap()))
}

#[allow(dead_code)]
pub const fn is_commit(tag: u8) -> bool { tag == TAG_COMMIT }

/// Tag 42 data after the tag: borsh `name`, `symbol`, `uri` (u32 little-endian length + UTF-8 bytes each), nothing
/// else. The bytes are hashed as they are and must equal the extension's display hash; the same bytes feed the
/// Metaplex metadata instruction, so what is displayed is exactly what was committed at opening.
pub fn parse_launch_data(data: &[u8]) -> Result<([u8; 32], &[u8]), ProgramError> {
    let e = || ProgramError::Custom(E_LAUNCH_V2);
    let mut at = 0usize; let mut uri: &[u8] = &[];
    for max in [DISPLAY_NAME_MAX, DISPLAY_SYMBOL_MAX, DISPLAY_URI_MAX] {
        if data.len() < at + 4 { return Err(e()); }
        let len = u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
        if len == 0 || len > max || data.len() < at + 4 + len { return Err(e()); }
        if core::str::from_utf8(&data[at + 4..at + 4 + len]).is_err() { return Err(e()); }
        uri = &data[at + 4..at + 4 + len];
        at += 4 + len;
    }
    if at != data.len() { return Err(e()); }
    Ok((hashv(&[data]).to_bytes(), uri))
}

/// What the campaign must keep after `A` leaves for the pool: the unpaid excess and the rounding collateral. Excess
/// refunds paid before the launch may exceed `T - A` by the dust `d < R` (each receipt refunds `c_i - a_i`, and the sum
/// of accepted amounts is `A - d`), so the subtraction runs on `T - A + R`; a result below zero is an inconsistency.
pub fn liability_v2(total: u64, accepted_target: u64, refunded: u64, collateral: u64) -> Result<u64, ProgramError> {
    total.checked_sub(accepted_target).and_then(|n| n.checked_add(collateral)).and_then(|n| n.checked_sub(refunded)).ok_or(ProgramError::Custom(E_LAUNCH_V2))
}

/// Version-2 readiness: inside the launch window, not yet live, funded to the soft cap. No per-receipt condition.
pub fn ready_v2(phase: u8, total: u64, soft: u64, deadline: i64, launch_deadline: i64, now: i64) -> bool {
    now >= deadline && now < launch_deadline && matches!(phase, PHASE_FUNDING | PHASE_CLOSED) && total >= soft
}

/// The sealed totals of a version-2 campaign: `T`, `A = min(T, hard)`, `N`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Totals { pub total: u64, pub accepted_target: u64, pub receipts: u32 }
pub fn totals_of(total: u64, hard: u64, receipt_count: u64) -> Result<Totals, ProgramError> {
    if receipt_count > MAX_RECEIPTS_V2 { return Err(ProgramError::Custom(E_LAUNCH_V2)); }
    Ok(Totals { total, accepted_target: total.min(hard), receipts: receipt_count as u32 })
}

/// Seals the totals into the extension if they are not sealed yet; a sealed extension must agree with the record.
#[inline(never)]
fn seal_totals(ext: &AccountInfo, c: &Campaign) -> Result<Totals, ProgramError> {
    let e = || ProgramError::Custom(E_LAUNCH_V2);
    let mut d = ext.try_borrow_mut_data()?;
    if d.len() != EXT_LEN || &d[..8] != EXT_MAGIC { return Err(ProgramError::InvalidAccountData); }
    let fresh = totals_of(c.state.total, c.terms.hard, c.state.receipt_count)?;
    if d[OFF_EXT_SEALED] != 0 {
        let sealed = Totals { total: read64(&d, OFF_EXT_SEALED_TOTAL)?, accepted_target: read64(&d, OFF_EXT_ACCEPTED_TARGET)?,
            receipts: u32::from_le_bytes(d[OFF_EXT_SEALED_RECEIPTS..OFF_EXT_SEALED_RECEIPTS + 4].try_into().unwrap()) };
        if sealed != fresh { return Err(e()); }
        return Ok(sealed);
    }
    d[OFF_EXT_SEALED] = 1;
    d[OFF_EXT_SEALED_RECEIPTS..OFF_EXT_SEALED_RECEIPTS + 4].copy_from_slice(&fresh.receipts.to_le_bytes());
    d[OFF_EXT_SEALED_TOTAL..OFF_EXT_SEALED_TOTAL + 8].copy_from_slice(&fresh.total.to_le_bytes());
    d[OFF_EXT_ACCEPTED_TARGET..OFF_EXT_ACCEPTED_TARGET + 8].copy_from_slice(&fresh.accepted_target.to_le_bytes());
    Ok(fresh)
}

/// Creates the child mint (signer), initialises it with the launch authority as mint authority and no freeze
/// authority, creates the custody ATA, mints the whole supply into it and creates the metadata from the launch data.
/// A pre-funded, system-owned, empty mint address is completed with allocate + assign; anything else is refused.
#[inline(never)]
fn mint_leg<'a>(a: &[AccountInfo<'a>], authority_seeds: &[&[u8]], supply: u64, data: &[u8]) -> ProgramResult {
    let e = || ProgramError::Custom(E_LAUNCH_V2);
    let keeper = &a[1]; let authority = &a[2]; let mint = &a[3]; let custody = &a[4]; let token = &a[11]; let ata = &a[12];
    let system = &a[13]; let rent_sysvar = &a[14]; let metadata_program = &a[27]; let metadata = &a[30];
    if !mint.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    if mint.owner != &system_program::id() || !mint.data_is_empty() || mint.executable { return Err(e()); }
    let rent = Rent::get()?.minimum_balance(MINT_LEN);
    if mint.lamports() == 0 {
        invoke(&system_instruction::create_account(keeper.key, mint.key, rent, MINT_LEN as u64, &TOKEN_PROGRAM), &[keeper.clone(), mint.clone(), system.clone()])?;
    } else {
        let short = rent.saturating_sub(mint.lamports());
        if short > 0 { invoke(&system_instruction::transfer(keeper.key, mint.key, short), &[keeper.clone(), mint.clone(), system.clone()])?; }
        invoke(&system_instruction::allocate(mint.key, MINT_LEN as u64), &[mint.clone(), system.clone()])?;
        invoke(&system_instruction::assign(mint.key, &TOKEN_PROGRAM), &[mint.clone(), system.clone()])?;
    }
    // Token InitializeMint2: decimals, mint authority, no freeze authority.
    let mut init = vec![20u8, STANDARD_V3_DECIMALS_V2]; init.extend_from_slice(authority.key.as_ref()); init.push(0);
    invoke(&Instruction { program_id: TOKEN_PROGRAM, accounts: vec![AccountMeta::new(*mint.key, false)], data: init }, &[mint.clone(), token.clone()])?;
    // Associated token account of the launch authority for the child mint (idempotent create).
    invoke(&Instruction { program_id: ASSOCIATED_TOKEN_PROGRAM, accounts: vec![AccountMeta::new(*keeper.key, true), AccountMeta::new(*custody.key, false),
        AccountMeta::new_readonly(*authority.key, false), AccountMeta::new_readonly(*mint.key, false), AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new_readonly(TOKEN_PROGRAM, false)], data: vec![1] },
        &[keeper.clone(), custody.clone(), authority.clone(), mint.clone(), system.clone(), token.clone(), ata.clone()])?;
    // The WSOL custody of the launch authority (the pool's SOL side is wrapped there by the launch body), idempotent.
    let wsol = &a[28]; let wsol_custody = &a[5];
    invoke(&Instruction { program_id: ASSOCIATED_TOKEN_PROGRAM, accounts: vec![AccountMeta::new(*keeper.key, true), AccountMeta::new(*wsol_custody.key, false),
        AccountMeta::new_readonly(*authority.key, false), AccountMeta::new_readonly(*wsol.key, false), AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new_readonly(TOKEN_PROGRAM, false)], data: vec![1] },
        &[keeper.clone(), wsol_custody.clone(), authority.clone(), wsol.clone(), system.clone(), token.clone(), ata.clone()])?;
    // MintTo the whole supply, signed by the launch authority PDA.
    let mut mint_to = vec![7u8]; mint_to.extend_from_slice(&supply.to_le_bytes());
    invoke_signed(&Instruction { program_id: TOKEN_PROGRAM, accounts: vec![AccountMeta::new(*mint.key, false), AccountMeta::new(*custody.key, false),
        AccountMeta::new_readonly(*authority.key, true)], data: mint_to }, &[mint.clone(), custody.clone(), authority.clone(), token.clone()], &[authority_seeds])?;
    // Metaplex CreateMetadataAccountV3 from the committed display bytes: immutable, no creators, collection or uses.
    let mut meta = vec![33u8]; meta.extend_from_slice(data); meta.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0]);
    invoke_signed(&Instruction { program_id: METADATA_PROGRAM, accounts: vec![AccountMeta::new(*metadata.key, false), AccountMeta::new_readonly(*mint.key, false),
        AccountMeta::new_readonly(*authority.key, true), AccountMeta::new(*keeper.key, true), AccountMeta::new_readonly(*authority.key, true),
        AccountMeta::new_readonly(system_program::id(), false), AccountMeta::new_readonly(solana_program::sysvar::rent::id(), false)], data: meta },
        &[metadata.clone(), mint.clone(), authority.clone(), keeper.clone(), system.clone(), rent_sysvar.clone(), metadata_program.clone()], &[authority_seeds])?;
    Ok(())
}

/// Tag 42. Accounts: the 29 tag-6 accounts (the child mint at 3 must sign), then 29 extension PDA, 30 child metadata
/// PDA, 31 mint reservation, 32 fee-NFT reservation. Data: see `parse_launch_data`.
pub fn launch_funding_first(program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let e = || ProgramError::Custom(E_LAUNCH_V2);
    if a.len() != launch::LAUNCH_ACCOUNTS + LAUNCH_V2_EXTRA_ACCOUNTS { return Err(ProgramError::NotEnoughAccountKeys); }
    let (display_hash, uri) = parse_launch_data(data)?;
    let mut c = Campaign::read(&a[0], program)?;
    // The displayed URI is the sealed one: the display commitment and the sealed terms cannot name different documents.
    if uri != &c.terms.metadata_uri[..c.terms.metadata_uri_len as usize] { return Err(e()); }
    if c.state.accounting_version != ACCOUNTING_VERSION_FUNDING_FIRST { return Err(ProgramError::Custom(E_ACCOUNTING_VERSION)); }
    let now = Clock::get()?.unix_timestamp;
    if !ready_v2(c.state.phase, c.state.total, c.terms.soft, c.terms.deadline, c.terms.launch_deadline, now) { return Err(ProgramError::Custom(E_NOT_READY)); }
    let ext = &a[29]; let metadata = &a[30]; let mint_res = &a[31]; let nft_res = &a[32];
    if ext.owner != program || mint_res.owner != program || nft_res.owner != program { return Err(e()); }
    if *ext.key != Pubkey::find_program_address(&[EXT_SEED, a[0].key.as_ref()], program).0 { return Err(ProgramError::InvalidSeeds); }
    let header = decode_ext_header(&ext.try_borrow_data()?)?;
    if header.campaign != *a[0].key || header.terms_hash != c.state.terms_hash || header.mint != c.terms.child_mint || header.mint != *a[3].key
        || header.fee_nft != *a[6].key || header.display_hash != display_hash || header.version != ACCOUNTING_VERSION_FUNDING_FIRST { return Err(e()); }
    if decode_reservation(&mint_res.try_borrow_data()?, a[3].key)? != *a[0].key || decode_reservation(&nft_res.try_borrow_data()?, a[6].key)? != *a[0].key { return Err(e()); }
    if *metadata.key != Pubkey::find_program_address(&[b"metadata", METADATA_PROGRAM.as_ref(), a[3].key.as_ref()], &METADATA_PROGRAM).0 { return Err(ProgramError::InvalidSeeds); }
    let totals = seal_totals(ext, &c)?;
    let (authority, bump) = c.launch_authority(a[0].key, program);
    if *a[2].key != authority { return Err(ProgramError::InvalidSeeds); }
    let bump_seed = [bump]; let seeds: &[&[u8]] = &[LAUNCH_AUTHORITY_SEED, a[0].key.as_ref(), &bump_seed];
    mint_leg(a, seeds, c.terms.supply, data)?;
    // What must stay in the campaign after `A` leaves: the unpaid excess (T - A - refunded) and the rounding collateral.
    let liability = liability_v2(totals.total, totals.accepted_target, c.state.refunded, COLLATERAL_V2)?;
    launch::launch_body(program, a, &mut c, now, totals.accepted_target, liability)
}

/// Q allocation of one receipt: `floor(P × a_i / A)` in u128; zero for a fully refunded receipt; A must be sealed.
pub fn allocation_q(reserve: u64, accepted_lamports: u64, accepted_target: u64) -> Result<u64, ProgramError> {
    if accepted_target == 0 || accepted_lamports > accepted_target { return Err(ProgramError::Custom(E_ACCOUNTING_V2)); }
    Ok((reserve as u128 * accepted_lamports as u128 / accepted_target as u128) as u64)
}

/// The few campaign fields the bookkeeping tags need, read by offset so that no handler carries the 1,024-byte record on
/// the 4 KiB SBF stack. Verifies what `Campaign::read` verifies: owner, magic, layout, the stored terms hash over the
/// sealed bytes, and the derived address; plus the accounting version.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lite { pub phase: u8, pub total: u64, pub refunded: u64, pub receipt_count: u64, pub creator: Pubkey, pub soft: u64, pub hard: u64, pub deadline: i64, pub launch_deadline: i64, pub terms_hash: [u8; 32] }
#[inline(never)]
fn read_lite(program: &Pubkey, account: &AccountInfo) -> Result<Lite, ProgramError> {
    if account.owner != program { return Err(ProgramError::IncorrectProgramId); }
    let d = account.try_borrow_data()?;
    if d.len() != CAMPAIGN_LEN || &d[..8] != CAMPAIGN_MAGIC { return Err(ProgramError::InvalidAccountData); }
    if d[OFF_ACCOUNTING_VERSION] != ACCOUNTING_VERSION_FUNDING_FIRST { return Err(ProgramError::Custom(E_ACCOUNTING_VERSION)); }
    let stored: [u8; 32] = d[OFF_TERMS_HASH..OFF_TERMS_HASH + 32].try_into().unwrap();
    if stored != terms_hash(&d[SEALED_START..SEALED_END]) { return Err(ProgramError::InvalidAccountData); }
    let creator = read_key(&d, OFF_CREATOR)?; let nonce = read64(&d, OFF_NONCE)?;
    let (expected, _) = Pubkey::find_program_address(&[CAMPAIGN_SEED, creator.as_ref(), &nonce.to_le_bytes()], program);
    if expected != *account.key { return Err(ProgramError::InvalidSeeds); }
    Ok(Lite { phase: d[OFF_PHASE], total: read64(&d, OFF_TOTAL)?, refunded: read64(&d, OFF_REFUNDED)?, receipt_count: read64(&d, OFF_RECEIPT_COUNT)?, creator,
        soft: read64(&d, OFF_SOFT)?, hard: read64(&d, OFF_HARD)?, deadline: read64(&d, OFF_DEADLINE)? as i64, launch_deadline: read64(&d, OFF_LAUNCH_DEADLINE)? as i64, terms_hash: stored })
}
fn write_phase(account: &AccountInfo, phase: u8) -> ProgramResult { account.try_borrow_mut_data()?[OFF_PHASE] = phase; Ok(()) }
fn write_refunded(account: &AccountInfo, refunded: u64) -> ProgramResult { let mut d = account.try_borrow_mut_data()?; d[OFF_REFUNDED..OFF_REFUNDED + 8].copy_from_slice(&refunded.to_le_bytes()); Ok(()) }
fn ext_of_lite(program: &Pubkey, campaign: &AccountInfo, ext: &AccountInfo, terms_hash: &[u8; 32]) -> Result<ExtHeader, ProgramError> {
    if ext.owner != program || *ext.key != Pubkey::find_program_address(&[EXT_SEED, campaign.key.as_ref()], program).0 { return Err(ProgramError::InvalidSeeds); }
    let h = decode_ext_header(&ext.try_borrow_data()?)?;
    if h.campaign != *campaign.key || h.terms_hash != *terms_hash || h.version != ACCOUNTING_VERSION_FUNDING_FIRST { return Err(ProgramError::Custom(E_ACCOUNTING_V2)); }
    Ok(h)
}
fn ext_of(program: &Pubkey, campaign: &AccountInfo, ext: &AccountInfo, c: &Campaign) -> Result<ExtHeader, ProgramError> { ext_of_lite(program, campaign, ext, &c.state.terms_hash) }
fn ext_u64(ext: &AccountInfo, at: usize) -> Result<u64, ProgramError> { read64(&ext.try_borrow_data()?, at) }
fn ext_u32(ext: &AccountInfo, at: usize) -> Result<u32, ProgramError> { let d = ext.try_borrow_data()?; Ok(u32::from_le_bytes(d[at..at + 4].try_into().unwrap())) }
fn ext_put_u64(ext: &AccountInfo, at: usize, v: u64) -> ProgramResult { let mut d = ext.try_borrow_mut_data()?; d[at..at + 8].copy_from_slice(&v.to_le_bytes()); Ok(()) }
fn ext_put_u32(ext: &AccountInfo, at: usize, v: u32) -> ProgramResult { let mut d = ext.try_borrow_mut_data()?; d[at..at + 4].copy_from_slice(&v.to_le_bytes()); Ok(()) }
fn now() -> Result<i64, ProgramError> { Ok(Clock::get()?.unix_timestamp) }
fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64, floor: u64) -> ProgramResult {
    let remaining = from.lamports().checked_sub(amount).ok_or(ProgramError::InsufficientFunds)?;
    if remaining < floor { return Err(ProgramError::InsufficientFunds); }
    let credit = to.lamports().checked_add(amount).ok_or(ProgramError::Custom(E_OVERFLOW))?;
    **from.try_borrow_mut_lamports()? = remaining; **to.try_borrow_mut_lamports()? = credit; Ok(())
}
/// Seals `T`, `A = min(T, hard)`, `N` into the extension if unsealed; a sealed extension must agree with these values.
#[inline(never)]
fn seal_totals_lite(ext: &AccountInfo, total: u64, hard: u64, receipt_count: u64) -> Result<Totals, ProgramError> {
    let e = || ProgramError::Custom(E_LAUNCH_V2);
    let mut d = ext.try_borrow_mut_data()?;
    if d.len() != EXT_LEN || &d[..8] != EXT_MAGIC { return Err(ProgramError::InvalidAccountData); }
    let fresh = totals_of(total, hard, receipt_count)?;
    if d[OFF_EXT_SEALED] != 0 {
        let sealed = Totals { total: read64(&d, OFF_EXT_SEALED_TOTAL)?, accepted_target: read64(&d, OFF_EXT_ACCEPTED_TARGET)?,
            receipts: u32::from_le_bytes(d[OFF_EXT_SEALED_RECEIPTS..OFF_EXT_SEALED_RECEIPTS + 4].try_into().unwrap()) };
        if sealed != fresh { return Err(e()); }
        return Ok(sealed);
    }
    d[OFF_EXT_SEALED] = 1;
    d[OFF_EXT_SEALED_RECEIPTS..OFF_EXT_SEALED_RECEIPTS + 4].copy_from_slice(&fresh.receipts.to_le_bytes());
    d[OFF_EXT_SEALED_TOTAL..OFF_EXT_SEALED_TOTAL + 8].copy_from_slice(&fresh.total.to_le_bytes());
    d[OFF_EXT_ACCEPTED_TARGET..OFF_EXT_ACCEPTED_TARGET + 8].copy_from_slice(&fresh.accepted_target.to_le_bytes());
    Ok(fresh)
}

/// Tag 45, no body. Accounts: 0 campaign, 1 extension. Permissionless. After the deadline: below the soft cap → refund
/// only; launch deadline passed without a launch → refund only; otherwise the totals are sealed and the phase is closed.
/// A live campaign is left alone.
pub fn close_v2(program: &Pubkey, a: &[AccountInfo], body: &[u8]) -> ProgramResult {
    if !body.is_empty() { return Err(ProgramError::InvalidInstructionData); }
    if a.len() != 2 { return Err(ProgramError::NotEnoughAccountKeys); }
    let c = read_lite(program, &a[0])?; ext_of_lite(program, &a[0], &a[1], &c.terms_hash)?;
    let now = now()?;
    if now < c.deadline { return Err(ProgramError::Custom(E_BEFORE_DEADLINE)); }
    if c.phase == PHASE_LIVE { return Ok(()); }
    if launch_failed(c.phase, c.total, c.soft, c.launch_deadline, now) { write_phase(&a[0], PHASE_REFUND_ONLY) }
    else { seal_totals_lite(&a[1], c.total, c.hard, c.receipt_count)?; write_phase(&a[0], PHASE_CLOSED) }
}

/// Tag 44, no body. Accounts: 0 campaign, 1 receipt, 2 destination (the receipt owner), 3 extension. Permissionless.
/// Pays the entitlement (full commitment when failed, the excess over the accepted amount otherwise) less what was
/// already paid, exactly like tag 3; the rent stays. Moves the phase like tag 3 (0 → 1 or 2).
pub fn refund_v2(program: &Pubkey, a: &[AccountInfo], body: &[u8]) -> ProgramResult {
    if !body.is_empty() { return Err(ProgramError::InvalidInstructionData); }
    if a.len() != 4 { return Err(ProgramError::NotEnoughAccountKeys); }
    let campaign = &a[0]; let receipt = &a[1]; let destination = &a[2];
    let c = read_lite(program, campaign)?; ext_of_lite(program, campaign, &a[3], &c.terms_hash)?;
    let mut r = Receipt::read(receipt, program, campaign.key)?;
    if r.owner != *destination.key || destination.key == campaign.key || destination.key == receipt.key { return Err(ProgramError::Custom(E_REFUND_DESTINATION)); }
    let now = now()?;
    if now < c.deadline { return Err(ProgramError::Custom(E_BEFORE_DEADLINE)); }
    let failed = launch_failed(c.phase, c.total, c.soft, c.launch_deadline, now);
    if failed { write_phase(campaign, PHASE_REFUND_ONLY)?; } else if c.phase == PHASE_FUNDING { seal_totals_lite(&a[3], c.total, c.hard, c.receipt_count)?; write_phase(campaign, PHASE_CLOSED)?; }
    let entitled = refundable(r.committed, c.total, c.hard, failed);
    let amount = entitled.checked_sub(r.refunded).ok_or(ProgramError::Custom(E_OVERFLOW))?;
    if amount == 0 { return Ok(()); }
    move_lamports(campaign, destination, amount, Rent::get()?.minimum_balance(CAMPAIGN_LEN))?;
    write_refunded(campaign, c.refunded.checked_add(amount).ok_or(ProgramError::Custom(E_OVERFLOW))?)?;
    r.refunded = entitled; r.write(receipt)
}

/// Tag 46, no body. Accounts: 0 campaign, 1 receipt, 2 extension. Permissionless, exact-once per receipt, independent
/// of payouts: adds the receipt's accepted amount to the accounted total once the totals are sealed (phase 1 or 3).
pub fn account_v2(program: &Pubkey, a: &[AccountInfo], body: &[u8]) -> ProgramResult {
    if !body.is_empty() { return Err(ProgramError::InvalidInstructionData); }
    if a.len() != 3 { return Err(ProgramError::NotEnoughAccountKeys); }
    let c = read_lite(program, &a[0])?; let h = ext_of_lite(program, &a[0], &a[2], &c.terms_hash)?;
    if !h.sealed || !matches!(c.phase, PHASE_CLOSED | PHASE_LIVE) { return Err(ProgramError::Custom(E_ACCOUNTING_V2)); }
    let mut r = Receipt::read(&a[1], program, a[0].key)?;
    if r.accounted { return Err(ProgramError::Custom(E_ACCOUNTING_V2)); }
    let sealed_total = ext_u64(&a[2], OFF_EXT_SEALED_TOTAL)?;
    let a_i = accepted(r.committed, sealed_total, c.hard);
    let count = ext_u32(&a[2], OFF_EXT_ACCOUNTED_COUNT)?.checked_add(1).ok_or(ProgramError::Custom(E_OVERFLOW))?;
    let sum = ext_u64(&a[2], OFF_EXT_ACCOUNTED_ACCEPTED)?.checked_add(a_i).ok_or(ProgramError::Custom(E_OVERFLOW))?;
    if count > ext_u32(&a[2], OFF_EXT_SEALED_RECEIPTS)? { return Err(ProgramError::Custom(E_ACCOUNTING_V2)); }
    ext_put_u32(&a[2], OFF_EXT_ACCOUNTED_COUNT, count)?; ext_put_u64(&a[2], OFF_EXT_ACCOUNTED_ACCEPTED, sum)?;
    r.accounted = true; r.write(&a[1])
}

/// Tag 47, no body. Accounts: 0 campaign, 1 extension, 2 the sealed creator (writable). Permissionless, once. Failed
/// round: the whole collateral goes back (no accepted amount was spent). Live round: only after every receipt is
/// accounted, `collateral − dust` goes back, where dust = accepted target − accounted accepted amounts.
pub fn return_collateral_v2(program: &Pubkey, a: &[AccountInfo], body: &[u8]) -> ProgramResult {
    if !body.is_empty() { return Err(ProgramError::InvalidInstructionData); }
    if a.len() != 3 { return Err(ProgramError::NotEnoughAccountKeys); }
    let c = read_lite(program, &a[0])?; let h = ext_of_lite(program, &a[0], &a[1], &c.terms_hash)?;
    if *a[2].key != c.creator || a[2].key == a[0].key { return Err(ProgramError::Custom(E_ACCOUNTING_V2)); }
    if ext_u64(&a[1], OFF_EXT_COLLATERAL_RETURNED)? != 0 { return Err(ProgramError::Custom(E_ACCOUNTING_V2)); }
    let amount = match c.phase {
        PHASE_REFUND_ONLY => COLLATERAL_V2,
        PHASE_LIVE => {
            if !h.sealed || ext_u32(&a[1], OFF_EXT_ACCOUNTED_COUNT)? != ext_u32(&a[1], OFF_EXT_SEALED_RECEIPTS)? { return Err(ProgramError::Custom(E_ACCOUNTING_V2)); }
            let dust = ext_u64(&a[1], OFF_EXT_ACCEPTED_TARGET)?.checked_sub(ext_u64(&a[1], OFF_EXT_ACCOUNTED_ACCEPTED)?).ok_or(ProgramError::Custom(E_ACCOUNTING_V2))?;
            COLLATERAL_V2.checked_sub(dust).ok_or(ProgramError::Custom(E_ACCOUNTING_V2))?
        }
        _ => return Err(ProgramError::Custom(E_ACCOUNTING_V2)),
    };
    // The unpaid refund liability must stay: in a failed round every commitment less what was already refunded; in a
    // live round the unpaid excess is bounded by T - A + dust, which the remaining collateral covers exactly.
    let floor = Rent::get()?.minimum_balance(CAMPAIGN_LEN).checked_add(if c.phase == PHASE_REFUND_ONLY { c.total.checked_sub(c.refunded).ok_or(ProgramError::Custom(E_OVERFLOW))? } else { 0 }).ok_or(ProgramError::Custom(E_OVERFLOW))?;
    ext_put_u64(&a[1], OFF_EXT_COLLATERAL_RETURNED, amount)?;
    if amount == 0 { return Ok(()); }
    move_lamports(&a[0], &a[2], amount, floor)
}

/// Tag 43, no body. Accounts as tag 7 (0 campaign, 1 receipt, 2 launch authority, 3 child mint, 4 custody, 5 the
/// owner's associated token account, 6 Token) plus 7 extension. Permissionless payer, paid once per receipt, no
/// settlement needed: `floor(P × a_i / A)` from the sealed accepted target.
pub fn claim_v2(program: &Pubkey, a: &[AccountInfo], body: &[u8]) -> ProgramResult {
    if !body.is_empty() { return Err(ProgramError::InvalidInstructionData); }
    if a.len() != 8 { return Err(ProgramError::NotEnoughAccountKeys); }
    let mut c = Campaign::read(&a[0], program)?;
    if c.state.accounting_version != ACCOUNTING_VERSION_FUNDING_FIRST { return Err(ProgramError::Custom(E_ACCOUNTING_VERSION)); }
    let h = ext_of(program, &a[0], &a[7], &c)?;
    if c.state.phase != PHASE_LIVE { return Err(ProgramError::Custom(E_NOT_LAUNCHED)); }
    if !h.sealed { return Err(ProgramError::Custom(E_ACCOUNTING_V2)); }
    let mut r = Receipt::read(&a[1], program, a[0].key)?;
    if r.claimed { return Ok(()); }
    let sealed_total = ext_u64(&a[7], OFF_EXT_SEALED_TOTAL)?; let target = ext_u64(&a[7], OFF_EXT_ACCEPTED_TARGET)?;
    let a_i = accepted(r.committed, sealed_total, c.terms.hard);
    let reserve = c.terms.split()?.participants;
    let amount = allocation_q(reserve, a_i, target)?;
    let claimed = c.state.participant_claimed.checked_add(amount).ok_or(ProgramError::Custom(E_OVERFLOW))?;
    if claimed > reserve { return Err(ProgramError::Custom(E_CLAIM_INVALID)); }
    handlers::custody_transfer(program, &c, &a[0], &a[2], &a[3], &a[4], &a[5], &r.owner, &a[6], amount)?;
    let paid = ext_u32(&a[7], OFF_EXT_CLAIMS_PAID)?.checked_add(1).ok_or(ProgramError::Custom(E_OVERFLOW))?;
    ext_put_u32(&a[7], OFF_EXT_CLAIMS_PAID, paid)?;
    c.state.participant_claimed = claimed; r.claimed = true; r.accepted = a_i; r.claimed_tokens = amount; c.write(&a[0])?; r.write(&a[1])
}
