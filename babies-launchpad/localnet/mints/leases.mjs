// Vanity mint leases (plan section 9, P3) over the registry mint_leases table and the existing encrypted inventory
// (kids-mint-worker/vendor/.../mint-inventory.js: SqliteVanityMintInventory). Key generation, the AES-GCM record format and
// its AAD stay in the inventory; this module never sees a private key and hands the public API only the mint's public
// key and a lease reference.
// States: reserved -> signed-pending -> consumed | quarantined; reserved -> releasing -> released only when the inventory proves the
// mint never signed anything AND the chain says the mint account is absent. A timeout on its own changes nothing.
// The inventory contract used here: reserve(binding) -> {mintAddress, reservationId, status}; findReservation(binding);
// releaseUnsignedReservation(binding) -> {released, reason}; counts() -> {available, reserved, signed, quarantined}.
import {PublicKey} from '@solana/web3.js';
import {GENESIS_BY_NETWORK} from '../registry/import-legacy.mjs';
export const SUFFIX='kids';
export const NETWORKS=Object.freeze(['localnet','devnet','mainnet']);
const b58=v=>{try{const k=new PublicKey(v);return k.toBase58()===v?k:null;}catch{return null;}};
/** Exactly lowercase `kids`, canonical base58, on the curve (a mint must sign). Throws with a plain reason. */
export function validateKidsMint(mint){
 const key=b58(mint);if(!key)throw Error('Mint is not a canonical address');
 if(!mint.endsWith(SUFFIX))throw Error('Mint does not end in lowercase '+SUFFIX);
 if(key.equals(PublicKey.default)||!PublicKey.isOnCurve(key.toBytes()))throw Error('Mint must be an on-curve, non-default address');
 return mint;
}
/** devnet and mainnet have one genesis each; localnet accepts the genesis the caller names. */
export function validateNetwork({network,genesisHash}){
 if(!NETWORKS.includes(network))throw Error('network must be one of '+NETWORKS.join(', '));
 if(!b58(genesisHash))throw Error('genesisHash must be an address');
 const expected=GENESIS_BY_NETWORK[network];if(expected&&expected!==genesisHash)throw Error('genesis '+genesisHash+' is not the '+network+' genesis');
 return {network,genesisHash};
}
const NO_STOCK=/inventory is empty|No available mint/i,QUARANTINED=/quarantined/i;
const publicView=l=>l?{leaseId:l.leaseId,mint:l.mint,state:l.state,campaign:l.campaign,network:l.network}:null;
/** `validateMint` defaults to the strict kids rule; tests inject a relaxed check because grinding a kids key takes minutes. */
export function createMintLeases({registry,inventory,now=Date.now,log=()=>{},validateMint=validateKidsMint}){
 if(!registry?.mintLeases)throw Error('Mint leases need a registry');if(!inventory||typeof inventory.reserve!=='function')throw Error('Mint leases need the encrypted inventory');
 const binding=l=>({creator:l.creator,draftId:l.draftId,idempotencyKey:l.idempotencyKey});
 return {
  /** Reserves one kids mint for (network genesis, campaign or draft, creator, idempotency key). The same key returns the same
   * lease; two callers can never hold the same mint (inventory write lock + UNIQUE(mint)); empty stock is `no-stock`. */
  async reserve({network,genesisHash,programId=null,campaign=null,draftId,creator,idempotencyKey}){
   validateNetwork({network,genesisHash});
   if(!b58(creator))return {outcome:'refused',reason:'creator must be an address'};
   const matches=l=>l.creator===creator&&l.idempotencyKey===idempotencyKey&&l.draftId===draftId&&l.network===network&&l.genesisHash===genesisHash&&l.programId===programId&&l.campaign===campaign;
   const existing=await registry.mintLeases.byBinding({creator,idempotencyKey});
   if(existing){
    if(!matches(existing))return {outcome:'refused',reason:'idempotency key is bound to another draft, campaign or network'};
    return {outcome:'existing',lease:publicView(existing)};
   }
   let reservation;
   try{reservation=await inventory.reserve({creator,draftId,idempotencyKey});}
   catch(e){const m=String(e?.message||e);if(NO_STOCK.test(m)){log({event:'mint-lease-no-stock',network,creator});return {outcome:'no-stock',reason:'no kids mint in stock'};}if(QUARANTINED.test(m))return {outcome:'refused',reason:'reservation is quarantined'};throw e;}
   const mint=reservation.mintAddress;
   try{validateMint(mint);}catch(e){log({event:'mint-lease-invalid-mint',reason:e.message,mint});return {outcome:'invalid-mint',reason:e.message,mint};}
   const leased=await registry.mintLeases.byMint(mint);
   if(leased&&matches(leased))return {outcome:'existing',lease:publicView(leased)};
   if(leased&&leased.state!=='released'){const err=Error('Inventory handed out a mint that another lease already holds');err.code='MINT_CONFLICT';throw err;}
   // a released mint came back from stock: its row is rebound to the new binding (one row per mint)
   let lease;
   try{lease=leased?await registry.mintLeases.rebind({leaseId:leased.leaseId,mint,genesisHash,programId,campaign,creator,network,draftId,idempotencyKey,signerRef:reservation.reservationId??null}):await registry.mintLeases.insert({mint,genesisHash,programId,campaign,creator,network,draftId,idempotencyKey,signerRef:reservation.reservationId??null});}
   catch(e){
    // Inventory reservation and registry insertion are separate durable stores.
    // A retry recovers the winner rather than freeing or replacing its mint.
    if(e.code!=='23505'&&!/UNIQUE constraint/.test(String(e.message)))throw e;
    const won=await registry.mintLeases.byBinding({creator,idempotencyKey});
    if(won&&matches(won)&&won.mint===mint)return {outcome:'existing',lease:publicView(won)};
    throw Object.assign(Error('Mint reservation conflicts with another binding'),{code:'MINT_CONFLICT'});
   }
   if(!lease){const err=Error('Mint lease changed concurrently');err.code='MINT_CONFLICT';throw err;}
   log({event:'mint-leased',leaseId:lease.leaseId,mint,network});
   return {outcome:'reserved',lease:publicView(lease)};
  },
  /** Persists the approved creation message digest BEFORE any signature is asked for. Same digest again: idempotent. */
  async recordSigningIntent({leaseId,messageDigest}){
   if(typeof messageDigest!=='string'||!/^[a-f0-9]{64}$/.test(messageDigest))throw Error('Approved message digest required');
   const l=await registry.mintLeases.get(leaseId);if(!l)return {outcome:'refused',reason:'unknown lease'};
   if(l.state==='signed-pending')return l.messageDigest===messageDigest?{outcome:'recorded',lease:publicView(l)}:{outcome:'refused',reason:'lease already bound to another message'};
   if(l.state!=='reserved')return {outcome:'refused',reason:'lease is '+l.state};
   const next=await registry.mintLeases.transition({leaseId,from:'reserved',to:'signed-pending',messageDigest});
   return next?{outcome:'recorded',lease:publicView(next)}:{outcome:'refused',reason:'lease changed concurrently'};
  },
  /** Records the signature of the approved message; only the recorded digest may be signed. */
  async recordSignature({leaseId,messageDigest,signature}){
   if(typeof messageDigest!=='string'||!/^[a-f0-9]{64}$/.test(messageDigest))throw Error('Approved message digest required');
   const l=await registry.mintLeases.get(leaseId);if(!l||l.state!=='signed-pending')return {outcome:'refused',reason:l?'lease is '+l.state:'unknown lease'};
   if(l.messageDigest!==messageDigest)return {outcome:'refused',reason:'signature is for another message'};
   if(l.signature&&l.signature!==signature)return {outcome:'refused',reason:'lease already carries another signature'};
   const next=await registry.mintLeases.transition({leaseId,from:'signed-pending',to:'signed-pending',signature});
   return next?{outcome:'recorded',lease:publicView(next)}:{outcome:'refused',reason:'lease changed concurrently'};
  },
  async markConsumed({leaseId,signature=undefined}){
   const l=await registry.mintLeases.get(leaseId);if(!l)return {outcome:'refused',reason:'unknown lease'};if(l.state==='consumed')return {outcome:'consumed',lease:publicView(l)};
   if(l.state!=='signed-pending')return {outcome:'refused',reason:'only a signed-pending lease can be consumed (lease is '+l.state+')'};
   const next=await registry.mintLeases.transition({leaseId,from:'signed-pending',to:'consumed',signature});return next?{outcome:'consumed',lease:publicView(next)}:{outcome:'refused',reason:'lease changed concurrently'};
  },
  async quarantine({leaseId,reason}){
   const l=await registry.mintLeases.get(leaseId);if(!l)return {outcome:'refused',reason:'unknown lease'};if(l.state==='consumed')return {outcome:'refused',reason:'a consumed mint is not quarantined'};
   const next=await registry.mintLeases.transition({leaseId,from:l.state,to:'quarantined',reason:String(reason).slice(0,200)});return next?{outcome:'quarantined',lease:publicView(next)}:{outcome:'refused',reason:'lease changed concurrently'};
  },
  /** Reconciles one lease with the chain. rpc: {mintExists(mint) -> boolean, signatureStatus(sig) -> {status}}. Releases a
   * reserved lease only when the inventory holds no signature for it AND the mint account is absent; an unreadable chain
   * leaves the lease as it is (unresolved). A signed-pending lease is never released. */
  async reconcile({leaseId,rpc}){
   const l=await registry.mintLeases.get(leaseId);if(!l)return {outcome:'refused',reason:'unknown lease'};
   if(['consumed','released','quarantined'].includes(l.state))return {outcome:'unchanged',state:l.state};
   let exists;try{exists=await rpc.mintExists(l.mint);}catch{log({event:'mint-lease-unresolved',leaseId,category:'chain-read'});return {outcome:'unresolved',state:l.state,reason:'chain read failed'};}
   if(typeof exists!=='boolean')return {outcome:'unresolved',state:l.state,reason:'chain read gave no answer'};
   if(l.state==='signed-pending'){
    if(exists){const next=await registry.mintLeases.transition({leaseId,from:'signed-pending',to:'consumed'});return {outcome:'consumed',state:next?next.state:l.state};}
    if(l.signature){let s;try{s=await rpc.signatureStatus(l.signature);}catch{return {outcome:'unresolved',state:l.state,reason:'signature status unreadable'};}if(s?.status==='confirmed'){const next=await registry.mintLeases.transition({leaseId,from:'signed-pending',to:'consumed'});return {outcome:'consumed',state:next?next.state:l.state};}}
    return {outcome:'kept',state:'signed-pending',reason:'a signed message may still land; never returned to stock'};
   }
   // Reserve a release claim before crossing into the inventory, so signing intent
   // cannot race an inventory release. A durable inventory receipt recovers crashes.
   if(exists){const next=await registry.mintLeases.transition({leaseId,from:l.state,to:'quarantined',reason:'mint account exists although this lease never signed'});return {outcome:'quarantined',state:next?next.state:l.state};}
   if(!l.signerRef)return {outcome:'unresolved',state:l.state,reason:'reservation identity missing'};
   if(l.state==='reserved'){const claimed=await registry.mintLeases.transition({leaseId,from:'reserved',to:'releasing'});if(!claimed)return {outcome:'unresolved',state:l.state,reason:'lease changed before release'};}
   const r=await inventory.releaseUnsignedReservation(binding(l),{reservationId:l.signerRef});
   if(r.released){if(r.mintAddress!==l.mint||r.reservationId!==l.signerRef)throw Error('Mint release proof does not match lease');const next=await registry.mintLeases.transition({leaseId,from:'releasing',to:'released',reason:'never signed, absent on chain'});if(!next)return {outcome:'unresolved',state:'releasing',reason:'lease changed after inventory release'};log({event:'mint-lease-released',leaseId,mint:l.mint});return {outcome:'released',state:next.state};}
   if(r.reason==='signed'){const next=await registry.mintLeases.transition({leaseId,from:'releasing',to:'signed-pending',reason:'inventory holds a signature for this mint'});return {outcome:'kept',state:next?next.state:l.state,reason:'inventory holds a signature'};}
   if(r.reason==='quarantined'){const next=await registry.mintLeases.transition({leaseId,from:'releasing',to:'quarantined',reason:'inventory quarantined the mint'});return {outcome:'quarantined',state:next?next.state:l.state};}
   return {outcome:'unresolved',state:l.state,reason:'inventory has no reservation for this lease'};
  },
  /** Reconciles every reserved lease older than `olderThanMs`; a timeout releases nothing by itself. */
  async expireReserved({olderThanMs,rpc,limit=100}){
   if(!Number.isSafeInteger(olderThanMs)||olderThanMs<0)throw Error('Reserved expiry age must be a non-negative integer');
   const cutoff=now()-olderThanMs;const out=[];
   for(const l of [...await registry.mintLeases.list({state:'releasing',limit}),...await registry.mintLeases.list({state:'reserved',limit})].slice(0,limit)){if(l.state!=='releasing'&&Date.parse(l.createdAt)>cutoff)continue;out.push({leaseId:l.leaseId,mint:l.mint,...(await this.reconcile({leaseId:l.leaseId,rpc}))});}
   return out;
  },
  /** Stock by state, inventory and leases side by side. `usable` is the inventory's available count, nothing more. */
  async stock(){const inv=await inventory.counts();return {inventory:inv,leases:await registry.mintLeases.counts(),usable:inv.available??0};},
  async get(leaseId){return publicView(await registry.mintLeases.get(leaseId));},
 };
}
