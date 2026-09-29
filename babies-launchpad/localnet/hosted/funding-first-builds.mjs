// The program builds that carry the funding-first accounting (version 2 records: tags 41-47 of kids-launch-v3, programs/
// kids-launch-v3/src/funding_first.rs). A hosted release may open funding-first rounds or run the funding-first lifecycle only
// when its verified program bytes are one of these builds; the isolated-ledger rehearsals of 29 September 2026 ran the first
// one (byte-identical rebuild of the recovered source). A mainnet upgrade to a new build adds its sha256 here with its evidence.
export const FUNDING_FIRST_BUILDS=Object.freeze(['6236f4e8ee6cd003779469a4ca098bb16c73a97650969949d2617b045ad54755']);
export const fundingFirstBuild=release=>typeof release?.binarySha256==='string'&&FUNDING_FIRST_BUILDS.includes(release.binarySha256);
