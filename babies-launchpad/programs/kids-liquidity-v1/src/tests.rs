use super::*;
fn policy() -> Policy {
    Policy {
        first_delay_seconds: DAY,
        end: End::UntilDust,
        temporary_fees: TemporaryFees::RecycleWithPrincipal,
    }
}
fn pool() -> Pool {
    Pool {
        tokens: 100_000_000,
        sol: 100_000_000_000,
        lp_supply: 1_000_000,
    }
}
fn zero_fees() -> Fees {
    Fees {
        trade_ppm: 0,
        protocol_share_ppm: 0,
        fund_share_ppm: 0,
    }
}
fn effects(s: &State, p: Pool, now: u64) -> Effects {
    let Action::Recycle(lp) = s.next(now).unwrap() else {
        panic!("not due")
    };
    let q = estimate(p, lp, zero_fees()).unwrap();
    Effects {
        temporary_before: s.remaining_lp,
        temporary_after: s.remaining_lp - lp,
        lp_supply_before: p.lp_supply,
        lp_supply_after: q.after.lp_supply,
        pool_lp_supply_before: p.lp_supply + 100,
        pool_lp_supply_after: q.after.lp_supply + 100,
        child_supply_before: p.tokens,
        child_supply_after: q.after.tokens,
        token_custody_before: 7,
        token_custody_after: 7,
        sol_custody_before: 11,
        sol_custody_after: 11,
        withdrawn_tokens: q.withdrawn_tokens,
        withdrawn_sol: q.withdrawn_sol,
        purchased_tokens: q.purchased_tokens,
        spent_sol: q.withdrawn_sol,
    }
}
#[test]
fn approved_split_and_independent_first_cycle() {
    let s = State::new(1_000_000, 1, policy()).unwrap();
    assert_eq!(s.permanent_lp(), 500_000);
    assert_eq!(s.next(1 + DAY).unwrap(), Action::Recycle(15_000));
    let q = estimate(pool(), 15_000, zero_fees()).unwrap();
    assert_eq!(q.withdrawn_tokens, 1_500_000);
    assert_eq!(q.withdrawn_sol, 1_500_000_000);
    assert_eq!(q.purchased_tokens, 1_477_500);
    assert_eq!(q.after.tokens, 97_022_500);
    assert_eq!(q.after.sol, pool().sol);
    let n = s
        .apply_cycle(1 + DAY, 0, effects(&s, pool(), 1 + DAY))
        .unwrap();
    assert_eq!(n.next(1 + DAY * 2).unwrap(), Action::Recycle(14_550));
    assert_eq!(n.permanent_lp(), s.permanent_lp());
}
#[test]
fn odd_unit_favours_permanent_and_u64_is_exact() {
    assert_eq!(split(10_001).unwrap(), (5_001, 5_000));
    assert_eq!(
        split(u64::MAX).unwrap(),
        (9_223_372_036_854_775_808, 9_223_372_036_854_775_807)
    );
    assert_eq!(split(1), Err(Error::Dust));
    assert_eq!(State::new(100, u64::MAX, policy()), Err(Error::Overflow));
}
#[test]
fn rolling_day_and_no_catchup() {
    let s = State::new(1_000_000, 100, policy()).unwrap();
    assert_eq!(s.next(100 + DAY - 1).unwrap(), Action::WaitUntil(100 + DAY));
    let now = 100 + 10 * DAY;
    let e = effects(&s, pool(), now);
    let next = s.apply_cycle(now, 0, e).unwrap();
    assert_eq!(next.redeemed_lp(), 15_000);
    assert_eq!(next.apply_cycle(now, 0, e), Err(Error::Sequence));
    assert_eq!(next.apply_cycle(now + DAY - 1, 1, e), Err(Error::TooEarly));
    assert_eq!(next.cycles(), 1);
}
#[test]
fn configured_delay_and_end_are_explicit() {
    let mut p = policy();
    p.first_delay_seconds = 7 * DAY;
    let s = State::new(1_000_000, 1, p).unwrap();
    assert_eq!(s.next(1 + DAY).unwrap(), Action::WaitUntil(1 + 7 * DAY));
    p.first_delay_seconds = DAY - 1;
    assert_eq!(State::new(1000, 1, p), Err(Error::InvalidPolicy));
    p = policy();
    p.end = End::AfterCycles(0);
    assert_eq!(State::new(1000, 1, p), Err(Error::InvalidPolicy));
}
#[test]
fn donations_never_expand_budget_or_get_burn_credit() {
    let s = State::new(1_000_000, 1, policy()).unwrap();
    let mut e = effects(&s, pool(), 1 + DAY);
    e.temporary_before += 500_000;
    e.temporary_after += 500_000;
    let n = s.apply_cycle(1 + DAY, 0, e).unwrap();
    assert_eq!(n.remaining_lp(), 485_000);
    assert_eq!(n.total_burned().unwrap(), 2_977_500);
    // Donation consumed in addition to the authorized slice.
    e.temporary_after -= 1;
    assert_eq!(s.apply_cycle(1 + DAY, 0, e), Err(Error::Effects));
}
#[test]
fn each_false_receipt_is_rejected_and_original_state_unchanged() {
    let s = State::new(1_000_000, 1, policy()).unwrap();
    let original = s.clone();
    let good = effects(&s, pool(), 1 + DAY);
    let changes: [fn(&mut Effects); 13] = [
        |e| e.temporary_after += 1,
        |e| e.lp_supply_after += 1,
        |e| e.pool_lp_supply_after += 1,
        |e| e.child_supply_after += 1,
        |e| e.token_custody_after += 1,
        |e| e.token_custody_after -= 1,
        |e| e.sol_custody_after += 1,
        |e| e.sol_custody_after -= 1,
        |e| e.spent_sol -= 1,
        |e| e.spent_sol += 1,
        |e| e.withdrawn_tokens = 0,
        |e| e.withdrawn_sol = 0,
        |e| e.purchased_tokens = 0,
    ];
    for change in changes {
        let mut bad = good;
        change(&mut bad);
        assert!(s.apply_cycle(1 + DAY, 0, bad).is_err());
        assert_eq!(s, original);
    }
}
#[test]
fn finite_cycles_lock_remainder_without_an_extra_cycle() {
    let mut p = policy();
    p.end = End::AfterCycles(90);
    let mut s = State::new(1_000_000_000_000, 1, p).unwrap();
    let mut q = Pool {
        tokens: 485_000_000_000_000,
        sol: 100_000_000_000,
        lp_supply: 1_000_000_000_000,
    };
    for i in 0..90 {
        let now = 1 + (u64::from(i) + 1) * DAY;
        let Action::Recycle(lp) = s.next(now).unwrap() else {
            panic!("expected cycle")
        };
        let e = effects(&s, q, now);
        s = s.apply_cycle(now, i, e).unwrap();
        q = estimate(q, lp, zero_fees()).unwrap().after;
        assert_eq!(
            s.permanent_lp() + s.remaining_lp() + s.redeemed_lp(),
            s.initial_lp
        );
    }
    assert_eq!(s.cycles(), 90);
    assert_eq!(
        s.next(1 + 90 * DAY).unwrap(),
        Action::LockRemainder(s.remaining_lp())
    );
    let lp = s.remaining_lp();
    let e = LockEffects {
        temporary_before: lp + 5,
        temporary_after: 5,
        locked_before: 0,
        locked_after: lp,
        lp_supply_before: q.lp_supply,
        lp_supply_after: q.lp_supply,
    };
    assert!(s
        .apply_lock(
            1 + 90 * DAY,
            LockEffects {
                locked_after: lp - 1,
                ..e
            }
        )
        .is_err());
    let closed = s.apply_lock(1 + 90 * DAY, e).unwrap();
    assert_eq!(closed.next(u64::MAX).unwrap(), Action::Closed);
    assert_eq!(closed.relocked_lp(), lp);
    assert_eq!(closed.permanent_lp(), 500_000_000_000);
    assert!(closed.apply_lock(u64::MAX, e).is_err());
}
#[test]
fn lp_dust_locks_without_rounding_up() {
    let s = State::new(66, 1, policy()).unwrap();
    assert_eq!(s.next(1 + DAY).unwrap(), Action::LockRemainder(33));
    let s2 = State::new(68, 1, policy()).unwrap();
    assert_eq!(s2.next(1 + DAY).unwrap(), Action::Recycle(1));
}
#[test]
fn returning_sol_does_not_restore_fee_excluded_reserves() {
    let q = estimate(
        pool(),
        15_000,
        Fees {
            trade_ppm: 25_000,
            protocol_share_ppm: 120_000,
            fund_share_ppm: 40_000,
        },
    )
    .unwrap();
    assert_eq!(q.trade_fee, 37_500_000);
    assert_eq!(q.protocol_fee, 4_500_000);
    assert_eq!(q.fund_fee, 1_500_000);
    assert_eq!(q.after.sol, 99_994_000_000);
    assert!(q.purchased_tokens < 1_477_500);
}
#[test]
fn adverse_selling_reverses_the_no_fee_price_increase() {
    let q = estimate(pool(), 15_000, zero_fees()).unwrap();
    let sell = 1_477_500;
    let sol_out = mul_div(sell, q.after.sol, q.after.tokens + sell).unwrap();
    assert_eq!(sol_out, 1_500_000_000);
    assert_eq!(
        u128::from(q.after.tokens + sell) * u128::from(pool().sol),
        u128::from(q.after.sol - sol_out) * u128::from(pool().tokens)
    );
}
#[test]
fn invalid_pools_and_fee_overflows_fail() {
    assert_eq!(
        estimate(pool(), pool().lp_supply, zero_fees()),
        Err(Error::InvalidPool)
    );
    assert_eq!(estimate(pool(), 0, zero_fees()), Err(Error::InvalidPool));
    assert_eq!(
        estimate(Pool { sol: 1, ..pool() }, 1, zero_fees()),
        Err(Error::Dust)
    );
    assert_eq!(
        estimate(
            pool(),
            1,
            Fees {
                trade_ppm: PPM,
                ..zero_fees()
            }
        ),
        Err(Error::InvalidPool)
    );
    assert_eq!(
        estimate(
            pool(),
            1,
            Fees {
                protocol_share_ppm: u64::MAX,
                fund_share_ppm: 1,
                ..zero_fees()
            }
        ),
        Err(Error::Overflow)
    );
}
#[test]
fn forged_but_conserved_budget_and_counter_dos_are_rejected() {
    let mut s = State::new(1_000_000, 1, policy()).unwrap();
    s.remaining_lp -= 1;
    s.redeemed_lp += 1;
    assert_eq!(s.validate(), Err(Error::InvalidState));
    s.cycles = u32::MAX;
    assert_eq!(s.validate(), Err(Error::InvalidState));
}
#[test]
fn maximum_u64_budget_reaches_dust_within_decode_work_bound() {
    let mut remaining = split(u64::MAX).unwrap().1;
    let mut cycles = 0;
    while remaining >= 34 {
        remaining -= mul_div(remaining, 300, 10000).unwrap();
        cycles += 1;
        assert!(cycles < 2048);
    }
    assert!(remaining < 34);
}
#[test]
fn premature_lock_cannot_be_forged_as_a_valid_closed_state() {
    let mut s = State::new(1_000_000, 1, policy()).unwrap();
    s.relocked_lp = s.remaining_lp;
    s.remaining_lp = 0;
    s.closed = true;
    assert_eq!(s.validate(), Err(Error::InvalidState));
}
#[test]
fn selected_fee_preservation_cannot_fall_back_to_recycling_fees() {
    let research = policy();
    assert_eq!(
        research.validate_for_activation(),
        Err(Error::InvalidPolicy)
    );
    let selected = Policy {
        temporary_fees: TemporaryFees::PreserveTreasuryDev,
        ..research
    };
    assert_eq!(
        selected.validate_for_activation(),
        Err(Error::FeeAccountingNotImplemented)
    );
    assert_eq!(selected.encode(), Err(Error::FeeAccountingNotImplemented));
    assert_eq!(
        State::new(1_000_000, 1, selected),
        Err(Error::FeeAccountingNotImplemented)
    );
}
