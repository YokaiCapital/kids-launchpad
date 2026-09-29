//! Canonical draft codec for the isolated kernel. Not a deployed account ABI.
use crate::*;
pub const POLICY_LEN: usize = 32;
pub const STATE_LEN: usize = 128;
fn word(d: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}
fn put(d: &mut [u8], at: usize, n: u64) {
    d[at..at + 8].copy_from_slice(&n.to_le_bytes());
}
impl Policy {
    pub fn encode(self) -> Result<[u8; POLICY_LEN]> {
        self.validate()?;
        let mut d = [0; POLICY_LEN];
        d[..8].copy_from_slice(b"KIDSDLP1");
        d[8..10].copy_from_slice(&1u16.to_le_bytes());
        d[10] = 1;
        if let End::AfterCycles(n) = self.end {
            d[11] = 1;
            d[12..16].copy_from_slice(&n.to_le_bytes());
        }
        put(&mut d, 16, self.first_delay_seconds);
        d[24..26].copy_from_slice(&(PERMANENT_BPS as u16).to_le_bytes());
        d[26..28].copy_from_slice(&(TEMPORARY_BPS as u16).to_le_bytes());
        d[28..30].copy_from_slice(&(DAILY_REMAINING_BPS as u16).to_le_bytes());
        Ok(d)
    }
    pub fn decode(d: &[u8]) -> Result<Self> {
        if d.len() != POLICY_LEN
            || &d[..8] != b"KIDSDLP1"
            || d[8..10] != [1, 0]
            || d[10] != 1
            || d[11] > 1
        {
            return Err(Error::InvalidPolicy);
        }
        let cycles = u32::from_le_bytes(d[12..16].try_into().unwrap());
        if d[11] == 0 && cycles != 0 {
            return Err(Error::InvalidPolicy);
        }
        let p = Self {
            first_delay_seconds: word(d, 16),
            end: if d[11] == 0 {
                End::UntilDust
            } else {
                End::AfterCycles(cycles)
            },
            temporary_fees: TemporaryFees::RecycleWithPrincipal,
        };
        if p.encode()?.as_slice() != d {
            return Err(Error::InvalidPolicy);
        }
        Ok(p)
    }
}
impl State {
    pub fn encode(&self) -> Result<[u8; STATE_LEN]> {
        self.validate()?;
        let mut d = [0; STATE_LEN];
        d[..32].copy_from_slice(&self.policy.encode()?);
        for (at, n) in [
            (32, self.initial_lp),
            (40, self.permanent_lp),
            (48, self.remaining_lp),
            (56, self.redeemed_lp),
            (64, self.relocked_lp),
            (72, self.launched_at),
            (80, self.last_execution.unwrap_or(0)),
            (96, self.burned_withdrawn),
            (104, self.burned_purchased),
        ] {
            put(&mut d, at, n);
        }
        d[88..92].copy_from_slice(&self.cycles.to_le_bytes());
        d[92] = self.closed as u8;
        d[93] = self.last_execution.is_some() as u8;
        Ok(d)
    }
    pub fn decode(d: &[u8]) -> Result<Self> {
        if d.len() != STATE_LEN
            || d[92] > 1
            || d[93] > 1
            || d[94..96] != [0, 0]
            || d[112..].iter().any(|b| *b != 0)
            || (d[93] == 0 && word(d, 80) != 0)
        {
            return Err(Error::InvalidState);
        }
        let s = Self {
            policy: Policy::decode(&d[..32])?,
            initial_lp: word(d, 32),
            permanent_lp: word(d, 40),
            remaining_lp: word(d, 48),
            redeemed_lp: word(d, 56),
            relocked_lp: word(d, 64),
            launched_at: word(d, 72),
            last_execution: if d[93] == 0 { None } else { Some(word(d, 80)) },
            cycles: u32::from_le_bytes(d[88..92].try_into().unwrap()),
            closed: d[92] == 1,
            burned_withdrawn: word(d, 96),
            burned_purchased: word(d, 104),
        };
        s.validate()?;
        if s.encode()?.as_slice() != d {
            return Err(Error::InvalidState);
        }
        Ok(s)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_canonical_and_unsupported_rates_rejected() {
        let p = Policy {
            first_delay_seconds: DAY,
            end: End::AfterCycles(90),
            temporary_fees: TemporaryFees::RecycleWithPrincipal,
        };
        let bytes = p.encode().unwrap();
        assert_eq!(Policy::decode(&bytes), Ok(p));
        assert_eq!(
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            "4b494453444c5031010001015a0000008051010000000000881388132c010000"
        );
        assert_eq!(&bytes[24..30], &[0x88, 0x13, 0x88, 0x13, 0x2c, 0x01]);
        for at in [0, 8, 10, 11, 24, 26, 28, 30, 31] {
            let mut b = bytes;
            b[at] ^= 128;
            assert!(Policy::decode(&b).is_err());
        }
        assert!(Policy::decode(&bytes[..31]).is_err());
    }
    #[test]
    fn state_roundtrip_and_custody_tampering() {
        let p = Policy {
            first_delay_seconds: DAY,
            end: End::UntilDust,
            temporary_fees: TemporaryFees::RecycleWithPrincipal,
        };
        let s = State::new(1_000_000, 1, p).unwrap();
        let d = s.encode().unwrap();
        assert_eq!(State::decode(&d), Ok(s));
        for at in [32, 40, 48, 56, 64, 80, 88, 92, 93, 94, 112, 127] {
            let mut b = d;
            b[at] ^= 1;
            assert!(State::decode(&b).is_err(), "byte {at}");
        }
        assert!(State::decode(&d[..127]).is_err());
    }
}
