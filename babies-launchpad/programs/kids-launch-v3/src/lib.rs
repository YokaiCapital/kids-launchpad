//! New deployment only. Reuses the version-2 layout and economic handlers under a
//! DIFFERENT program ID, adding a terminal setup-SOL return. Never upgrade v2 to
//! this binary. No participant/fee/token account is an input to the return.
#![allow(unexpected_cfgs, deprecated)]
use solana_program::{account_info::AccountInfo, clock::Clock, entrypoint, entrypoint::ProgramResult,
    program::invoke_signed, program_error::ProgramError, pubkey::Pubkey, sysvar::Sysvar,
    system_instruction, system_program};
use kids_launch_v2::{state::{Campaign, Terms, LAYOUT_VERSION, METADATA_URI_MAX, SEALED_END}, policy::{PHASE_LIVE, PHASE_REFUND_ONLY, MODE_STANDARD, SPLIT_POLICY_STANDARD_V3, VESTING_RULE_STANDARD_V3, FEE_ROUTING_VERSION_1, SplitBps, VestingRule, FeeWeights}, state::{LAUNCH_AUTHORITY_SEED, SEALED_START, OFF_MODE, OFF_SPLIT_POLICY, OFF_VESTING_RULE}, PLATFORM_TREASURY, RAYDIUM_CPMM, RAYDIUM_LOCK, AMM_CONFIG_TIERS};
#[cfg(not(feature="no-entrypoint"))]
entrypoint!(process_instruction);

pub const TAG_RETURN_SETUP: u8 = 27;
/// Tag 40: create a Standard version-3 campaign from a compact body (one creator transaction, 28 September 2026).
pub const TAG_CREATE_V3: u8 = 40;
pub const E_CREATE_V3_BODY: u32 = 104;
/// Layout of the compact body after the tag: genesis 32, nonce 8, child mint 32, opens_at 8 (0 = the chain's time
/// when the transaction runs), funding seconds 4, launch window seconds 4, soft 8, hard 8, AMM config index 2,
/// metadata hash 32, CID length 1, CID (base58, 1 to 64 bytes). The metadata URI is the fixed gateway prefix plus
/// the CID; every other sealed field is the version-3 Standard economics, the signer is creator and dev beneficiary.
pub const CREATE_V3_FIXED_LEN: usize = 139;
pub const CREATE_V3_URI_PREFIX: &[u8] = b"https://gateway.pinata.cloud/ipfs/";
pub const STANDARD_V3_SUPPLY: u64 = 1_000_000_000_000_000;
pub const STANDARD_V3_DECIMALS: u8 = 6;
/// Upper bounds sealed by the program (review of 28 September 2026, L3): each window at most 30 days and a scheduled
/// opening at most 30 days after the chain's time. The hosted quote is tighter (60 s to 7 days); these keep committed
/// SOL from being locked for years by a mis-built body, since refunds wait for the deadline.
pub const CREATE_V3_MAX_WINDOW_SECONDS: u32 = 2_592_000;
pub const CREATE_V3_MAX_SCHEDULE_SECONDS: i64 = 2_592_000;
const BASE58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
pub const E_SETUP_NOT_TERMINAL: u32 = 100;
pub const E_SETUP_ACCOUNT: u32 = 101;
pub const E_PILOT_CREATOR: u32 = 102;
/// A version-3 Standard campaign seals exactly the economics the owner chose on 27 September 2026:
/// split policy 3 (47.5 / 47.5 / 5) and vesting rule 2 (1.5 % at launch, 3.5 % linear over three months).
pub const E_V3_ECONOMICS: u32 = 103;
/// True when a create body (the sealed bytes, positioned at `SEALED_START`) carries the version-3 Standard
/// economics. Family bodies are refused here as well: new Family creation has its own later qualification.
pub fn v3_economics_sealed(body: &[u8]) -> bool {
    let at = |offset: usize| body.get(offset - SEALED_START).copied();
    at(OFF_MODE) == Some(0) && at(OFF_SPLIT_POLICY) == Some(SPLIT_POLICY_STANDARD_V3) && at(OFF_VESTING_RULE) == Some(VESTING_RULE_STANDARD_V3)
}
#[cfg(not(feature="localnet-pilot"))]
pub const PILOT_CREATOR: Pubkey = solana_program::pubkey!("JBjY3ETQWkJa79G1URqFsgzqxKqxWeNfNycccQLkGVgn");
#[cfg(feature="localnet-pilot")]
pub const PILOT_CREATOR: Pubkey = Pubkey::new_from_array(kids_launch_v2::key_from_hex(env!("KIDS_LOCALNET_PILOT_HEX")));

/// Expands a compact version-3 creation body into the full sealed terms (a buffer positioned like a campaign account:
/// the sealed region at `SEALED_START..SEALED_END`). Refuses a malformed body before any account is read.
pub fn expand_create_v3(body: &[u8], creator: &Pubkey, now: i64) -> Result<[u8; SEALED_END], ProgramError> {
    let e = || ProgramError::Custom(E_CREATE_V3_BODY);
    if body.len() < CREATE_V3_FIXED_LEN { return Err(e()); }
    let cid_len = body[138] as usize;
    if cid_len == 0 || cid_len > 64 || body.len() != CREATE_V3_FIXED_LEN + cid_len { return Err(e()); }
    let cid = &body[CREATE_V3_FIXED_LEN..];
    if !cid.iter().all(|b| BASE58.contains(b)) { return Err(e()); }
    let u64_at = |at: usize| u64::from_le_bytes(body[at..at + 8].try_into().unwrap());
    let u32_at = |at: usize| u32::from_le_bytes(body[at..at + 4].try_into().unwrap());
    let u16_at = |at: usize| u16::from_le_bytes(body[at..at + 2].try_into().unwrap());
    let key_at = |at: usize| Pubkey::new_from_array(body[at..at + 32].try_into().unwrap());
    let genesis: [u8; 32] = body[0..32].try_into().unwrap();
    let opens_raw = u64_at(72);
    if opens_raw > i64::MAX as u64 { return Err(e()); }
    let opens_at = if opens_raw == 0 { now } else { opens_raw as i64 };
    let funding = u32_at(80); let window = u32_at(84);
    if opens_at <= 0 || funding == 0 || window == 0 || funding > CREATE_V3_MAX_WINDOW_SECONDS || window > CREATE_V3_MAX_WINDOW_SECONDS { return Err(e()); }
    if opens_raw != 0 && opens_at > now.checked_add(CREATE_V3_MAX_SCHEDULE_SECONDS).ok_or_else(e)? { return Err(e()); }
    let (funding, window) = (funding as i64, window as i64);
    let deadline = opens_at.checked_add(funding).ok_or_else(e)?;
    let launch_deadline = deadline.checked_add(window).ok_or_else(e)?;
    let index = u16_at(104);
    let tier = AMM_CONFIG_TIERS.iter().find(|t| t.0 == index).ok_or_else(e)?;
    let uri_len = CREATE_V3_URI_PREFIX.len() + cid_len;
    if uri_len > METADATA_URI_MAX { return Err(e()); }
    let mut metadata_uri = [0u8; METADATA_URI_MAX];
    metadata_uri[..CREATE_V3_URI_PREFIX.len()].copy_from_slice(CREATE_V3_URI_PREFIX);
    metadata_uri[CREATE_V3_URI_PREFIX.len()..uri_len].copy_from_slice(cid);
    let terms = Terms {
        layout_version: LAYOUT_VERSION, mode: MODE_STANDARD, decimals: STANDARD_V3_DECIMALS, split_policy: SPLIT_POLICY_STANDARD_V3, vesting_rule: VESTING_RULE_STANDARD_V3, fee_routing_version: FEE_ROUTING_VERSION_1, creator_fee_enabled: 0,
        genesis, creator: *creator, nonce: u64_at(32), dev: *creator, treasury: PLATFORM_TREASURY, child_mint: key_at(40), supply: STANDARD_V3_SUPPLY,
        opens_at, deadline, launch_deadline, soft: u64_at(88), hard: u64_at(96),
        amm_program: RAYDIUM_CPMM, amm_config: tier.1, amm_trade_fee_rate: tier.2, amm_config_index: index,
        fee_weights: FeeWeights::for_version_and_mode(FEE_ROUTING_VERSION_1, MODE_STANDARD).ok_or_else(e)?, split_bps: SplitBps::for_policy(SPLIT_POLICY_STANDARD_V3).ok_or_else(e)?, vesting: VestingRule::for_rule(VESTING_RULE_STANDARD_V3).ok_or_else(e)?, buyback_max_slippage_bps: 0,
        lock_program: RAYDIUM_LOCK, distribution_program: Pubkey::default(),
        parent_mint: [Pubkey::default(); 2], parent_program: [Pubkey::default(); 2], parent_slot: [0; 2], parent_root: [[0u8; 32]; 2], parent_supply: [0; 2], parent_eligible: [0; 2], parent_expiry_seconds: 0,
        metadata_hash: body[106..138].try_into().unwrap(), metadata_uri_len: uri_len as u8, metadata_uri, parent_reference_config: [0; 2],
    };
    let mut sealed = [0u8; SEALED_END];
    terms.encode(&mut sealed);
    Ok(sealed)
}

pub mod funding_first;

pub fn process_instruction(program: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (&tag, body) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    if tag == TAG_RETURN_SETUP { return return_setup(program, accounts, body); }
    // Funding-first accounting (version 2): its own opening; the old money tags are refused on a version-2 record; a
    // commit on a version-2 record must respect the receipt limits. Version-0 records are untouched by these checks.
    if tag == funding_first::TAG_OPEN_FUNDING { return funding_first::open_funding(program, accounts, body); }
    if tag == funding_first::TAG_LAUNCH_V2 { return funding_first::launch_funding_first(program, accounts, body); }
    match tag {
        funding_first::TAG_CLAIM_V2 => return funding_first::claim_v2(program, accounts, body),
        funding_first::TAG_REFUND_V2 => return funding_first::refund_v2(program, accounts, body),
        funding_first::TAG_CLOSE_V2 => return funding_first::close_v2(program, accounts, body),
        funding_first::TAG_ACCOUNT_V2 => return funding_first::account_v2(program, accounts, body),
        funding_first::TAG_RETURN_COLLATERAL_V2 => return funding_first::return_collateral_v2(program, accounts, body),
        _ => {}
    }
    if funding_first::old_money_tag(tag) && funding_first::touches_funding_first(program, accounts) {
        return Err(ProgramError::Custom(funding_first::E_ACCOUNTING_VERSION));
    }
    if tag == kids_launch_v2::TAG_COMMIT { funding_first::commit_limits(program, accounts, body)?; }
    if tag == TAG_CREATE_V3 {
        // Same pilot rule as the full create; the economics are fixed by construction, then the version-2 create
        // validates every sealed field, the AMM config account and the campaign address exactly as before.
        let creator = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
        if *creator.key != PILOT_CREATOR { return Err(ProgramError::Custom(E_PILOT_CREATOR)); }
        let sealed = expand_create_v3(body, creator.key, Clock::get()?.unix_timestamp)?;
        return kids_launch_v2::handlers::create(program, accounts, &sealed[SEALED_START..SEALED_END]);
    }
    // The exclusive pilot is enforced on chain, not merely by a hidden button.
    // This does not restrict commits, refunds, paid claims or keeper recovery.
    if tag == kids_launch_v2::TAG_CREATE && accounts.first().map(|a| *a.key) != Some(PILOT_CREATOR) {
        return Err(ProgramError::Custom(E_PILOT_CREATOR));
    }
    if tag == kids_launch_v2::TAG_CREATE && !v3_economics_sealed(body) {
        return Err(ProgramError::Custom(E_V3_ECONOMICS));
    }
    kids_launch_v2::process_instruction(program, accounts, data)
}

/// Permissionless tag 27. Body: sealed genesis, 32 bytes. Accounts (exactly four):
/// campaign read-only, launch-authority PDA writable, sealed creator writable,
/// executable System program read-only. Returns ALL currently remaining native
/// SOL at this authority, including unsolicited donations, only in LIVE or
/// REFUND_ONLY. Failed launches must first be finalized on chain. Replays with
/// zero balance succeed without a CPI; future donations may also be returned.
/// This is not a reimbursement of consumed rent/fees or a release of tokens.
pub fn return_setup(program: &Pubkey, accounts: &[AccountInfo], genesis: &[u8]) -> ProgramResult {
    if genesis.len() != 32 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() != 4 { return Err(ProgramError::NotEnoughAccountKeys); }
    let campaign = Campaign::read(&accounts[0], program)?;
    if genesis != campaign.terms.genesis { return Err(ProgramError::Custom(kids_launch_v2::E_NETWORK_MISMATCH)); }
    if !matches!(campaign.state.phase, PHASE_LIVE | PHASE_REFUND_ONLY) {
        return Err(ProgramError::Custom(E_SETUP_NOT_TERMINAL));
    }
    let (authority, bump) = campaign.launch_authority(accounts[0].key, program);
    let source = &accounts[1]; let creator = &accounts[2]; let system = &accounts[3];
    if *source.key != authority || *source.owner != system_program::id() ||
        !source.data_is_empty() || source.executable || !source.is_writable ||
        *creator.key != campaign.terms.creator || !creator.is_writable || creator.executable ||
        creator.key == source.key || creator.key == accounts[0].key ||
        *system.key != system_program::id() || !system.executable {
        return Err(ProgramError::Custom(E_SETUP_ACCOUNT));
    }
    let amount = source.lamports();
    if amount == 0 { return Ok(()); }
    let bump_seed = [bump];
    invoke_signed(&system_instruction::transfer(source.key, creator.key, amount),
        &[source.clone(), creator.clone(), system.clone()],
        &[&[LAUNCH_AUTHORITY_SEED, accounts[0].key.as_ref(), &bump_seed]])
}

#[cfg(test)]
mod tests;
