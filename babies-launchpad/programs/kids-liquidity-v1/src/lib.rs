//! Isolated Direct-liquidity kernel. No entrypoint, signer, recipient, RPC or asset transfer.
//! An eventual new controller must authenticate every account and take measurements itself;
//! accepting client-supplied `Effects`/`Pool` values would NOT establish these invariants.
//! Nothing here changes or links to a deployed legacy program.

pub mod codec;

pub const DAY: u64 = 86_400;
pub const BPS: u64 = 10_000;
pub const PPM: u64 = 1_000_000;
pub const PERMANENT_BPS: u64 = 5_000;
pub const TEMPORARY_BPS: u64 = 5_000;
pub const DAILY_REMAINING_BPS: u64 = 300;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidPolicy,
    InvalidState,
    Overflow,
    Dust,
    TooEarly,
    Closed,
    Sequence,
    Effects,
    InvalidPool,
    FeeAccountingNotImplemented,
}
pub type Result<T> = core::result::Result<T, Error>;

/// Explicit selection, not a production default. A finite limit counts successful cycles,
/// not calendar days: outages do not silently shorten the advertised cycle count.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    UntilDust,
    AfterCycles(u32),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TemporaryFees {
    /// Historical research only; not the owner-selected policy.
    RecycleWithPrincipal,
    /// Owner decision, 25 September 2026. Accounting is not implemented yet.
    PreserveTreasuryDev,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    pub first_delay_seconds: u64,
    pub end: End,
    pub temporary_fees: TemporaryFees,
}
impl Policy {
    /// Release precondition only, not an on-chain activation instruction. No candidate passes
    /// until fee harvesting and principal accounting exist. Legacy research is not selectable.
    pub fn validate_for_activation(self) -> Result<()> {
        if self.temporary_fees != TemporaryFees::PreserveTreasuryDev {
            return Err(Error::InvalidPolicy);
        }
        Err(Error::FeeAccountingNotImplemented)
    }

    pub fn validate(self) -> Result<()> {
        if self.temporary_fees == TemporaryFees::PreserveTreasuryDev {
            return Err(Error::FeeAccountingNotImplemented);
        }
        if self.first_delay_seconds < DAY || matches!(self.end, End::AfterCycles(0)) {
            return Err(Error::InvalidPolicy);
        }
        Ok(())
    }
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or(Error::Overflow)
}
fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b).ok_or(Error::Effects)
}
fn mul_div(a: u64, b: u64, d: u64) -> Result<u64> {
    if d == 0 {
        return Err(Error::InvalidPool);
    }
    u64::try_from(u128::from(a) * u128::from(b) / u128::from(d)).map_err(|_| Error::Overflow)
}
pub fn split(initial_received_lp: u64) -> Result<(u64, u64)> {
    let temporary = mul_div(initial_received_lp, TEMPORARY_BPS, BPS)?;
    if temporary == 0 {
        return Err(Error::Dust);
    }
    Ok((initial_received_lp - temporary, temporary)) // odd-unit dust remains permanently locked
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    WaitUntil(u64),
    Recycle(u64),
    LockRemainder(u64),
    Closed,
}
/// Private fields: all mutation goes through validated transitions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    policy: Policy,
    initial_lp: u64,
    permanent_lp: u64,
    remaining_lp: u64,
    redeemed_lp: u64,
    relocked_lp: u64,
    launched_at: u64,
    last_execution: Option<u64>,
    cycles: u32,
    burned_withdrawn: u64,
    burned_purchased: u64,
    closed: bool,
}
impl State {
    /// Called only after the real new-program launch verifies both LP custodies atomically.
    pub fn new(initial_lp: u64, launched_at: u64, policy: Policy) -> Result<Self> {
        policy.validate()?;
        add(launched_at, policy.first_delay_seconds)?;
        let (permanent_lp, remaining_lp) = split(initial_lp)?;
        Ok(Self {
            policy,
            initial_lp,
            permanent_lp,
            remaining_lp,
            redeemed_lp: 0,
            relocked_lp: 0,
            launched_at,
            last_execution: None,
            cycles: 0,
            burned_withdrawn: 0,
            burned_purchased: 0,
            closed: false,
        })
    }
    pub fn policy(&self) -> Policy {
        self.policy
    }
    pub fn permanent_lp(&self) -> u64 {
        self.permanent_lp
    }
    pub fn remaining_lp(&self) -> u64 {
        self.remaining_lp
    }
    pub fn redeemed_lp(&self) -> u64 {
        self.redeemed_lp
    }
    pub fn relocked_lp(&self) -> u64 {
        self.relocked_lp
    }
    pub fn cycles(&self) -> u32 {
        self.cycles
    }
    pub fn total_burned(&self) -> Result<u64> {
        add(self.burned_withdrawn, self.burned_purchased)
    }
    pub fn validate(&self) -> Result<()> {
        self.policy.validate()?;
        let (permanent, temporary) = split(self.initial_lp)?;
        let first_due = add(self.launched_at, self.policy.first_delay_seconds)?;
        // A u64 budget at 3% reaches sub-34-unit dust in fewer than 2,048 cycles.
        // Bound the loop before decoding untrusted bytes, then verify the entire budget trajectory.
        if self.cycles > 2048 {
            return Err(Error::InvalidState);
        }
        let mut expected_remaining = temporary;
        for _ in 0..self.cycles {
            let slice = mul_div(expected_remaining, DAILY_REMAINING_BPS, BPS)?;
            if slice == 0 {
                return Err(Error::InvalidState);
            }
            expected_remaining -= slice;
        }
        if self.closed
            && !matches!(self.policy.end, End::AfterCycles(n) if self.cycles >= n)
            && mul_div(expected_remaining, DAILY_REMAINING_BPS, BPS)? != 0
        {
            return Err(Error::InvalidState);
        }
        if self.redeemed_lp != temporary - expected_remaining
            || (!self.closed && self.remaining_lp != expected_remaining)
            || (self.closed && self.relocked_lp != expected_remaining)
            || (self.cycles == 0 && (self.burned_withdrawn != 0 || self.burned_purchased != 0))
            || (self.cycles > 0
                && (self.burned_withdrawn < u64::from(self.cycles)
                    || self.burned_purchased < u64::from(self.cycles)))
        {
            return Err(Error::InvalidState);
        }
        if permanent != self.permanent_lp
            || add(add(self.remaining_lp, self.redeemed_lp)?, self.relocked_lp)? != temporary
            || self.closed != (self.remaining_lp == 0)
            || (!self.closed && self.relocked_lp != 0)
            || (self.cycles == 0) != self.last_execution.is_none()
            || self.last_execution.is_some_and(|t| {
                u128::from(t)
                    < u128::from(first_due)
                        + u128::from(self.cycles.saturating_sub(1)) * u128::from(DAY)
            })
            || matches!(self.policy.end, End::AfterCycles(n) if self.cycles > n)
        {
            return Err(Error::InvalidState);
        }
        self.total_burned()?;
        Ok(())
    }
    pub fn next(&self, now: u64) -> Result<Action> {
        self.validate()?;
        if self.closed {
            return Ok(Action::Closed);
        }
        if matches!(self.policy.end, End::AfterCycles(n) if self.cycles >= n) {
            return Ok(Action::LockRemainder(self.remaining_lp));
        }
        let due = match self.last_execution {
            None => add(self.launched_at, self.policy.first_delay_seconds)?,
            Some(t) => add(t, DAY)?,
        };
        if now < due {
            return Ok(Action::WaitUntil(due));
        }
        let slice = mul_div(self.remaining_lp, DAILY_REMAINING_BPS, BPS)?;
        Ok(if slice == 0 {
            Action::LockRemainder(self.remaining_lp)
        } else {
            Action::Recycle(slice)
        })
    }
    /// All quantities must be controller-measured deltas surrounding fixed CPIs in ONE instruction.
    /// No catch-up, caller-chosen slice, donation-driven budget or partial state mutation on failure.
    pub fn apply_cycle(&self, now: u64, expected_sequence: u32, e: Effects) -> Result<Self> {
        if expected_sequence != self.cycles {
            return Err(Error::Sequence);
        }
        let slice = match self.next(now)? {
            Action::Recycle(n) => n,
            Action::WaitUntil(_) => return Err(Error::TooEarly),
            _ => return Err(Error::Closed),
        };
        e.verify(slice, self.remaining_lp)?;
        let mut next = self.clone();
        next.remaining_lp = sub(self.remaining_lp, slice)?;
        next.redeemed_lp = add(self.redeemed_lp, slice)?;
        next.burned_withdrawn = add(self.burned_withdrawn, e.withdrawn_tokens)?;
        next.burned_purchased = add(self.burned_purchased, e.purchased_tokens)?;
        next.last_execution = Some(now);
        next.cycles = self.cycles.checked_add(1).ok_or(Error::Overflow)?;
        next.validate()?;
        Ok(next)
    }
    /// Remainder goes to a canonical permanent lock. No SOL/token withdrawal, swap or wallet sweep.
    /// The adapter must verify the lock account/program identity and read its LP delta.
    pub fn apply_lock(&self, now: u64, e: LockEffects) -> Result<Self> {
        let amount = match self.next(now)? {
            Action::LockRemainder(n) => n,
            _ => return Err(Error::TooEarly),
        };
        if e.temporary_before < amount
            || sub(e.temporary_before, e.temporary_after)? != amount
            || sub(e.locked_after, e.locked_before)? != amount
            || e.lp_supply_before != e.lp_supply_after
        {
            return Err(Error::Effects);
        }
        let mut next = self.clone();
        next.relocked_lp = add(next.relocked_lp, amount)?;
        next.remaining_lp = 0;
        next.closed = true;
        next.validate()?;
        Ok(next)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockEffects {
    pub temporary_before: u64,
    pub temporary_after: u64,
    pub locked_before: u64,
    pub locked_after: u64,
    pub lp_supply_before: u64,
    pub lp_supply_after: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Effects {
    pub temporary_before: u64,
    pub temporary_after: u64,
    pub lp_supply_before: u64,
    pub lp_supply_after: u64,
    pub pool_lp_supply_before: u64,
    pub pool_lp_supply_after: u64,
    pub child_supply_before: u64,
    pub child_supply_after: u64,
    pub token_custody_before: u64,
    pub token_custody_after: u64,
    pub sol_custody_before: u64,
    pub sol_custody_after: u64,
    pub withdrawn_tokens: u64,
    pub withdrawn_sol: u64,
    pub purchased_tokens: u64,
    pub spent_sol: u64,
}
impl Effects {
    pub fn verify(self, slice: u64, tracked_remaining: u64) -> Result<()> {
        if slice == 0
            || slice > tracked_remaining
            || self.temporary_before < tracked_remaining
            || sub(self.temporary_before, self.temporary_after)? != slice
            || sub(self.lp_supply_before, self.lp_supply_after)? != slice
            || sub(self.pool_lp_supply_before, self.pool_lp_supply_after)? != slice
            || self.withdrawn_tokens == 0
            || self.withdrawn_sol == 0
            || self.purchased_tokens == 0
            || self.spent_sol != self.withdrawn_sol
            || sub(self.child_supply_before, self.child_supply_after)?
                != add(self.withdrawn_tokens, self.purchased_tokens)?
            || self.sol_custody_before != self.sol_custody_after
            || self.token_custody_before != self.token_custody_after
        {
            return Err(Error::Effects);
        }
        Ok(())
    }
}

/// Offline constant-product estimate, classic SPL/WSOL, no creator fee. Input reserves MUST
/// exclude accrued protocol/fund fees. Not an execution-price reference or Raydium parity proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pool {
    pub tokens: u64,
    pub sol: u64,
    pub lp_supply: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fees {
    pub trade_ppm: u64,
    pub protocol_share_ppm: u64,
    pub fund_share_ppm: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Estimate {
    pub after: Pool,
    pub withdrawn_tokens: u64,
    pub withdrawn_sol: u64,
    pub purchased_tokens: u64,
    pub trade_fee: u64,
    pub protocol_fee: u64,
    pub fund_fee: u64,
}
pub fn estimate(pool: Pool, lp: u64, fees: Fees) -> Result<Estimate> {
    if pool.tokens == 0
        || pool.sol == 0
        || lp == 0
        || lp >= pool.lp_supply
        || fees.trade_ppm >= PPM
        || add(fees.protocol_share_ppm, fees.fund_share_ppm)? > PPM
    {
        return Err(Error::InvalidPool);
    }
    let tokens = mul_div(pool.tokens, lp, pool.lp_supply)?;
    let sol = mul_div(pool.sol, lp, pool.lp_supply)?;
    if tokens == 0 || sol == 0 {
        return Err(Error::Dust);
    }
    let fee =
        u64::try_from((u128::from(sol) * u128::from(fees.trade_ppm)).div_ceil(u128::from(PPM)))
            .map_err(|_| Error::Overflow)?;
    let net = sub(sol, fee)?;
    if net == 0 {
        return Err(Error::Dust);
    }
    let output = mul_div(pool.tokens - tokens, net, pool.sol - fee)?;
    if output == 0 {
        return Err(Error::Dust);
    }
    let protocol_fee = mul_div(fee, fees.protocol_share_ppm, PPM)?;
    let fund_fee = mul_div(fee, fees.fund_share_ppm, PPM)?;
    Ok(Estimate {
        after: Pool {
            tokens: sub(pool.tokens - tokens, output)?,
            sol: sub(pool.sol, add(protocol_fee, fund_fee)?)?,
            lp_supply: pool.lp_supply - lp,
        },
        withdrawn_tokens: tokens,
        withdrawn_sol: sol,
        purchased_tokens: output,
        trade_fee: fee,
        protocol_fee,
        fund_fee,
    })
}

#[cfg(test)]
mod tests;
