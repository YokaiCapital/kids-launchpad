import {createHash} from 'node:crypto';

/** Basis-point denominator. `perOwnerCapBps` of 10000 disables the per-owner cap. */
const MAXIMUM_BPS=10_000;

export interface SnapshotTokenAccount {
 readonly address:string;
 readonly owner:string;
 readonly amountRaw:bigint;
 readonly frozen:boolean;
 readonly ownerOnCurve:boolean;
}

export interface CommunitySnapshot {
 readonly mint:string;
 readonly slot:number;
 readonly decimals:number;
 readonly supplyRaw:bigint;
 readonly accounts:readonly SnapshotTokenAccount[];
 /** Provenance of the read, recorded in the snapshot hash (e.g. "helius-das-getTokenAccounts"). */
 readonly source:string;
}

export interface CommunityAllocationRules {
 readonly version:1;
 /** Floor per community, applied to the owner total after aggregation (raw units of the gentler community). */
 readonly minimumOwnerBalanceRaw:bigint;
 /** Published rule (12 Sep 2026): 25 = 0.25% of each community's total supply; the snapshot reader applies it per community before anything is stored. Optional for records written before the rule. */
 readonly minimumOwnerShareBps?:number;
 /** Cap of a community pool one owner may receive (200 = 2%); 10000 = no cap. */
 readonly perOwnerCapBps:number;
 /** Explicit exclusions: pool vaults, program accounts, the creator wallet. */
 readonly excludedOwners:readonly string[];
 /** PDAs (pools, vaults, escrows) are excluded when true. */
 readonly excludeOffCurveOwners:boolean;
 readonly excludeFrozenAccounts:boolean;
}

export interface CommunityPoolInput {
 readonly snapshot:CommunitySnapshot;
 /** New-coin raw units reserved for this community. */
 readonly poolRaw:bigint;
}

export interface OwnerAllocation {
 readonly owner:string;
 readonly amountRaw:bigint;
 readonly byCommunity:readonly {mint:string;amountRaw:bigint;snapshotBalanceRaw:bigint}[];
}

export interface CommunityAllocationResult {
 readonly rules:CommunityAllocationRules;
 readonly communities:readonly {mint:string;slot:number;poolRaw:bigint;eligibleOwners:number;eligibleBalanceRaw:bigint;excludedAccounts:number;allocatedRaw:bigint;remainderRaw:bigint;capped:number;snapshotSha256:string}[];
 /** Sorted by owner (plain code-unit order), one entry per owner, amounts > 0 only. */
 readonly allocations:readonly OwnerAllocation[];
 readonly totalAllocatedRaw:bigint;
 readonly totalRemainderRaw:bigint;
 /** sha256 of canonicalCommunityAllocationJson(result), which omits this field. */
 readonly allocationSha256:string;
}

/** Plain code-unit comparison; never locale-aware, so ordering is portable. */
const compare=(left:string,right:string)=>left<right?-1:left>right?1:0;
const sum=(values:Iterable<bigint>)=>{let total=0n;for(const value of values)total+=value;return total;};
const sha256=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');

type CanonicalValue=string|number|boolean|null|bigint|readonly CanonicalValue[]|{readonly [key:string]:CanonicalValue};

/** JSON with object keys sorted by code unit, bigint as a decimal string and no
 * float, NaN or undefined. Array order is the order the caller defined. */
function canonical(value:CanonicalValue):string{
 if(typeof value==='bigint')return JSON.stringify(value.toString());
 if(typeof value==='number'){
  if(!Number.isSafeInteger(value))throw new Error('Canonical allocation JSON accepts only safe integer numbers');
  return String(value);
 }
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(Array.isArray(value))return `[${(value as readonly CanonicalValue[]).map(entry=>canonical(entry)).join(',')}]`;
 const record=value as {readonly [key:string]:CanonicalValue};
 return `{${Object.keys(record).sort(compare).map(key=>{
  const entry=record[key];
  if(entry===undefined)throw new Error(`Canonical allocation JSON cannot contain undefined (${key})`);
  return `${JSON.stringify(key)}:${canonical(entry)}`;
 }).join(',')}}`;
}

function assertIndex(value:number,label:string){
 if(!Number.isSafeInteger(value)||value<0)throw new Error(`${label} must be a nonnegative safe integer`);
}

function assertCapBps(perOwnerCapBps:number){
 if(!Number.isSafeInteger(perOwnerCapBps)||perOwnerCapBps<1||perOwnerCapBps>MAXIMUM_BPS)throw new Error(`perOwnerCapBps must be an integer in [1, ${MAXIMUM_BPS}]`);
}

function assertPoolRaw(poolRaw:bigint){
 if(typeof poolRaw!=='bigint'||poolRaw<0n)throw new Error('poolRaw must be a nonnegative raw amount');
}

/** Validates and normalizes the rules. `excludedOwners` is deduplicated and
 * sorted so an equivalent exclusion list always yields the same hash. */
function normalizeRules(rules:CommunityAllocationRules):CommunityAllocationRules{
 if(rules.version!==1)throw new Error('Unsupported community allocation rules version');
 assertCapBps(rules.perOwnerCapBps);
 if(typeof rules.minimumOwnerBalanceRaw!=='bigint'||rules.minimumOwnerBalanceRaw<0n)throw new Error('minimumOwnerBalanceRaw must be a nonnegative raw amount');
 if(typeof rules.excludeOffCurveOwners!=='boolean'||typeof rules.excludeFrozenAccounts!=='boolean')throw new Error('Exclusion switches must be booleans');
 for(const owner of rules.excludedOwners)if(typeof owner!=='string'||owner.length===0)throw new Error('Excluded owner address cannot be empty');
 return {
  version:1,
  minimumOwnerBalanceRaw:rules.minimumOwnerBalanceRaw,
  ...(Number.isSafeInteger(rules.minimumOwnerShareBps)&&(rules.minimumOwnerShareBps as number)>0?{minimumOwnerShareBps:rules.minimumOwnerShareBps as number}:{}),
  perOwnerCapBps:rules.perOwnerCapBps,
  excludedOwners:[...new Set(rules.excludedOwners)].sort(compare),
  excludeOffCurveOwners:rules.excludeOffCurveOwners,
  excludeFrozenAccounts:rules.excludeFrozenAccounts,
 };
}

/** A snapshot must be internally consistent before it can be hashed or used:
 * unique token accounts, nonnegative amounts and a holder total that never
 * exceeds the recorded mint supply. */
function assertSnapshot(snapshot:CommunitySnapshot){
 if(typeof snapshot.mint!=='string'||snapshot.mint.length===0)throw new Error('Snapshot mint cannot be empty');
 if(typeof snapshot.source!=='string'||snapshot.source.length===0)throw new Error(`Snapshot of ${snapshot.mint} needs a source`);
 assertIndex(snapshot.slot,`Snapshot slot of ${snapshot.mint}`);
 if(!Number.isSafeInteger(snapshot.decimals)||snapshot.decimals<0||snapshot.decimals>255)throw new Error(`Snapshot decimals of ${snapshot.mint} must be an integer in [0, 255]`);
 if(typeof snapshot.supplyRaw!=='bigint'||snapshot.supplyRaw<0n)throw new Error(`Snapshot supply of ${snapshot.mint} must be a nonnegative raw amount`);
 const addresses=new Set<string>();
 let total=0n;
 for(const account of snapshot.accounts){
  if(typeof account.address!=='string'||account.address.length===0)throw new Error(`Snapshot of ${snapshot.mint} has an empty token account address`);
  if(typeof account.owner!=='string'||account.owner.length===0)throw new Error(`Token account ${account.address} has an empty owner`);
  if(typeof account.amountRaw!=='bigint'||account.amountRaw<0n)throw new Error(`Token account ${account.address} has a negative balance`);
  if(typeof account.frozen!=='boolean'||typeof account.ownerOnCurve!=='boolean')throw new Error(`Token account ${account.address} has a non-boolean flag`);
  if(addresses.has(account.address))throw new Error(`Token account ${account.address} appears twice in the snapshot of ${snapshot.mint}`);
  addresses.add(account.address);
  total+=account.amountRaw;
 }
 if(total>snapshot.supplyRaw)throw new Error(`Snapshot of ${snapshot.mint} holds ${total} raw units, more than its supply of ${snapshot.supplyRaw}`);
}

/** sha256 over the canonical snapshot: accounts sorted by token account
 * address, bigint amounts as decimal strings, object keys sorted. */
export function snapshotSha256(snapshot:CommunitySnapshot):string{
 assertSnapshot(snapshot);
 return sha256(canonical({
  mint:snapshot.mint,
  slot:snapshot.slot,
  decimals:snapshot.decimals,
  supplyRaw:snapshot.supplyRaw,
  source:snapshot.source,
  accounts:[...snapshot.accounts].sort((left,right)=>compare(left.address,right.address)).map(account=>({
   address:account.address,
   owner:account.owner,
   amountRaw:account.amountRaw,
   frozen:account.frozen,
   ownerOnCurve:account.ownerOnCurve,
  })),
 }));
}

/**
 * Sums every token account of the same owner into one eligible balance.
 *
 * An account is dropped before aggregation when its amount is 0, its owner is
 * listed in `excludedOwners`, `excludeOffCurveOwners` is set and the owner is
 * off curve (a PDA: pool, vault, escrow), or `excludeFrozenAccounts` is set and
 * the account is frozen. After aggregation an owner whose total is below
 * `minimumOwnerBalanceRaw` is dropped as dust; two small accounts that together
 * clear the floor therefore stay eligible.
 *
 * `excludedAccounts` counts every token account that did not end up in an
 * eligible balance, including the accounts of owners removed by the dust floor,
 * so eligible accounts plus `excludedAccounts` equal the snapshot account count.
 * The returned map is built in owner order, so iteration is deterministic.
 */
export function aggregateSnapshotByOwner(snapshot:CommunitySnapshot,rules:CommunityAllocationRules):{eligible:Map<string,bigint>;excludedAccounts:number}{
 const normalized=normalizeRules(rules);
 assertSnapshot(snapshot);
 const excludedOwners=new Set(normalized.excludedOwners);
 const totals=new Map<string,{amountRaw:bigint;accounts:number}>();
 let excludedAccounts=0;
 for(const account of snapshot.accounts){
  const dropped=account.amountRaw===0n
   ||excludedOwners.has(account.owner)
   ||(normalized.excludeOffCurveOwners&&!account.ownerOnCurve)
   ||(normalized.excludeFrozenAccounts&&account.frozen);
  if(dropped){excludedAccounts+=1;continue;}
  const current=totals.get(account.owner)??{amountRaw:0n,accounts:0};
  current.amountRaw+=account.amountRaw;
  current.accounts+=1;
  totals.set(account.owner,current);
 }
 const eligible=new Map<string,bigint>();
 for(const [owner,total] of [...totals.entries()].sort(([left],[right])=>compare(left,right))){
  if(total.amountRaw<normalized.minimumOwnerBalanceRaw){excludedAccounts+=total.accounts;continue;}
  eligible.set(owner,total.amountRaw);
 }
 return {eligible,excludedAccounts};
}

/**
 * Integer-only pro-rata allocation of one community pool.
 *
 * `share(owner) = floor(poolRaw * balance / eligibleBalance)`. When
 * `perOwnerCapBps < 10000` the cap is `floor(poolRaw * perOwnerCapBps / 10000)`;
 * every owner over the cap is fixed at exactly the cap and the pool that remains
 * (`poolRaw - sum(capped)`) is redistributed pro-rata among the still uncapped
 * owners by their balances. That repeats until no uncapped owner exceeds the cap
 * (bounded by the owner count, since each pass fixes at least one owner). If
 * every owner ends up capped, whatever is left over stays as remainder.
 *
 * Flooring remainders are never handed to individuals; they accumulate in
 * `remainderRaw`, so `sum(shares) + remainderRaw === poolRaw` always holds.
 * Only positive shares are returned, in owner order. `capped` counts owners
 * fixed at the cap, including the degenerate case of a cap that floors to zero.
 */
export function allocateCommunityPool(eligible:Map<string,bigint>,poolRaw:bigint,perOwnerCapBps:number):{shares:Map<string,bigint>;remainderRaw:bigint;capped:number}{
 assertPoolRaw(poolRaw);
 assertCapBps(perOwnerCapBps);
 const owners:(readonly [string,bigint])[]=[];
 for(const [owner,balance] of eligible){
  if(typeof owner!=='string'||owner.length===0)throw new Error('Eligible owner address cannot be empty');
  if(typeof balance!=='bigint'||balance<0n)throw new Error(`Eligible balance of ${owner} must be a nonnegative raw amount`);
  if(balance>0n)owners.push([owner,balance]);
 }
 owners.sort(([left],[right])=>compare(left,right));
 const shares=new Map<string,bigint>();
 const eligibleBalance=sum(owners.map(([,balance])=>balance));
 if(owners.length===0||eligibleBalance===0n||poolRaw===0n)return {shares,remainderRaw:poolRaw,capped:0};
 const capRaw=perOwnerCapBps>=MAXIMUM_BPS?null:(poolRaw*BigInt(perOwnerCapBps))/BigInt(MAXIMUM_BPS);
 const fixed=new Map<string,bigint>();
 let open=owners;
 let remainingPool=poolRaw;
 let remainingBalance=eligibleBalance;
 let uncapped:(readonly [string,bigint])[]=[];
 for(let pass=0;;pass+=1){
  if(pass>owners.length)throw new Error('Per-owner cap redistribution did not converge');
  if(open.length===0||remainingBalance===0n){uncapped=[];break;}
  const proposed=open.map(([owner,balance])=>[owner,(remainingPool*balance)/remainingBalance] as const);
  if(capRaw===null){uncapped=proposed;break;}
  const over=proposed.filter(([,amount])=>amount>capRaw);
  if(over.length===0){uncapped=proposed;break;}
  for(const [owner] of over)fixed.set(owner,capRaw);
  remainingPool-=capRaw*BigInt(over.length);
  const overOwners=new Set(over.map(([owner])=>owner));
  open=open.filter(([owner])=>!overOwners.has(owner));
  remainingBalance=sum(open.map(([,balance])=>balance));
 }
 const combined=[...fixed.entries(),...uncapped].filter(([,amount])=>amount>0n).sort(([left],[right])=>compare(left,right));
 const allocatedRaw=sum(combined.map(([,amount])=>amount));
 if(allocatedRaw>poolRaw)throw new Error('Community allocation exceeded its pool');
 for(const [owner,amount] of combined)shares.set(owner,amount);
 return {shares,remainderRaw:poolRaw-allocatedRaw,capped:fixed.size};
}

/** The hashed body of a result: everything except the hash itself. */
function allocationBody(result:Omit<CommunityAllocationResult,'allocationSha256'>):CanonicalValue{
 return {
  rules:{
   version:result.rules.version,
   minimumOwnerBalanceRaw:result.rules.minimumOwnerBalanceRaw,
   perOwnerCapBps:result.rules.perOwnerCapBps,
   excludedOwners:[...result.rules.excludedOwners],
   excludeOffCurveOwners:result.rules.excludeOffCurveOwners,
   excludeFrozenAccounts:result.rules.excludeFrozenAccounts,
  },
  communities:result.communities.map(community=>({
   mint:community.mint,
   slot:community.slot,
   poolRaw:community.poolRaw,
   eligibleOwners:community.eligibleOwners,
   eligibleBalanceRaw:community.eligibleBalanceRaw,
   excludedAccounts:community.excludedAccounts,
   allocatedRaw:community.allocatedRaw,
   remainderRaw:community.remainderRaw,
   capped:community.capped,
   snapshotSha256:community.snapshotSha256,
  })),
  allocations:result.allocations.map(allocation=>({
   owner:allocation.owner,
   amountRaw:allocation.amountRaw,
   byCommunity:allocation.byCommunity.map(entry=>({mint:entry.mint,amountRaw:entry.amountRaw,snapshotBalanceRaw:entry.snapshotBalanceRaw})),
  })),
  totalAllocatedRaw:result.totalAllocatedRaw,
  totalRemainderRaw:result.totalRemainderRaw,
 };
}

/** Deterministic JSON of the allocation: object keys sorted by code unit, every
 * bigint a decimal string, arrays in their defined order (communities and
 * `byCommunity` in input order, allocations in owner order) and no float or
 * undefined anywhere. `allocationSha256` is deliberately omitted, so
 * `sha256(canonicalCommunityAllocationJson(result)) === result.allocationSha256`
 * and the hash can be recomputed from the published document. */
export function canonicalCommunityAllocationJson(result:CommunityAllocationResult):string{
 return canonical(allocationBody(result));
}

/**
 * Computes the disclosed Pair Babies allocation for exactly two existing token
 * communities from their holder snapshots.
 *
 * Each community is aggregated and allocated independently under the same
 * rules, so the per-owner cap applies per community pool. A wallet eligible in
 * both communities receives both amounts, summed into a single OwnerAllocation
 * carrying one `byCommunity` row per community it was paid from, in input order.
 * Owners are sorted by plain code-unit comparison and only positive amounts are
 * reported. Same inputs give a byte-identical canonical JSON and hash.
 */
export function computeCommunityAllocation(inputs:readonly CommunityPoolInput[],rules:CommunityAllocationRules):CommunityAllocationResult{
 const normalized=normalizeRules(rules);
 if(inputs.length!==2)throw new Error('A Pair Babies launch allocates to exactly two communities');
 const [first,second]=inputs;
 if(first===undefined||second===undefined)throw new Error('A Pair Babies launch allocates to exactly two communities');
 if(first.snapshot.mint===second.snapshot.mint)throw new Error(`Both communities are the same mint (${first.snapshot.mint})`);
 const communities:CommunityAllocationResult['communities'][number][]=[];
 const byOwner=new Map<string,{amountRaw:bigint;byCommunity:{mint:string;amountRaw:bigint;snapshotBalanceRaw:bigint}[]}>();
 for(const input of inputs){
  assertPoolRaw(input.poolRaw);
  const {eligible,excludedAccounts}=aggregateSnapshotByOwner(input.snapshot,normalized);
  const {shares,remainderRaw,capped}=allocateCommunityPool(eligible,input.poolRaw,normalized.perOwnerCapBps);
  const allocatedRaw=sum(shares.values());
  communities.push({
   mint:input.snapshot.mint,
   slot:input.snapshot.slot,
   poolRaw:input.poolRaw,
   eligibleOwners:eligible.size,
   eligibleBalanceRaw:sum(eligible.values()),
   excludedAccounts,
   allocatedRaw,
   remainderRaw,
   capped,
   snapshotSha256:snapshotSha256(input.snapshot),
  });
  for(const [owner,amountRaw] of shares){
   const entry=byOwner.get(owner)??{amountRaw:0n,byCommunity:[]};
   entry.amountRaw+=amountRaw;
   entry.byCommunity.push({mint:input.snapshot.mint,amountRaw,snapshotBalanceRaw:eligible.get(owner)??0n});
   byOwner.set(owner,entry);
  }
 }
 const allocations=[...byOwner.entries()]
  .sort(([left],[right])=>compare(left,right))
  .map(([owner,entry]):OwnerAllocation=>({owner,amountRaw:entry.amountRaw,byCommunity:entry.byCommunity}));
 const totalAllocatedRaw=sum(communities.map(community=>community.allocatedRaw));
 const totalRemainderRaw=sum(communities.map(community=>community.remainderRaw));
 if(totalAllocatedRaw+totalRemainderRaw!==sum(communities.map(community=>community.poolRaw)))throw new Error('Community allocation did not conserve the disclosed pools');
 if(sum(allocations.map(allocation=>allocation.amountRaw))!==totalAllocatedRaw)throw new Error('Owner allocations did not reconcile to the community totals');
 const body={rules:normalized,communities,allocations,totalAllocatedRaw,totalRemainderRaw};
 return {...body,allocationSha256:sha256(canonical(allocationBody(body)))};
}
