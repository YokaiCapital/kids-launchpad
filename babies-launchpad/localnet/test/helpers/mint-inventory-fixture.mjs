// Synthetic public-address inventory. No secret keys or cryptography in this fixture.
export function fakeInventory({stock=[]}={}){
 const mints=new Map(stock.map(m=>[m,{status:'available'}])),reservations=new Map(),signatures=new Set(),releases=new Map();let serial=0;
 const key=b=>b.creator+'|'+b.draftId+'|'+b.idempotencyKey;
 return {mints,reservations,signatures,
  reserve(b){const prior=reservations.get(key(b));if(prior){if(mints.get(prior.mintAddress).status==='quarantined')throw Error('Mint reservation is quarantined');return prior;}
   const free=[...mints.entries()].find(([,v])=>v.status==='available');if(!free)throw Error('Vanity mint inventory is empty; ordinary mint fallback is disabled');
   mints.get(free[0]).status='reserved';const r={...b,reservationId:'res-'+serial++,mintAddress:free[0],status:'reserved'};reservations.set(key(b),r);return r;},
  findReservation(b){return reservations.get(key(b))||null;},
  releaseUnsignedReservation(b,{reservationId}={}){if(releases.has(reservationId))return releases.get(reservationId);const r=reservations.get(key(b));if(!r)return {released:false,reason:'absent'};if(reservationId&&r.reservationId!==reservationId)throw Error('Reservation mismatch');const m=mints.get(r.mintAddress);if(signatures.has(r.mintAddress)||m.status==='signed')return {released:false,reason:'signed'};if(m.status==='quarantined')return {released:false,reason:'quarantined'};reservations.delete(key(b));m.status='available';const proof={released:true,mintAddress:r.mintAddress,reservationId:r.reservationId};releases.set(r.reservationId,proof);return proof;},
  sign(mint){signatures.add(mint);mints.get(mint).status='signed';},
  counts(){const c={available:0,reserved:0,signed:0,quarantined:0};for(const v of mints.values())c[v.status]++;return c;},
 };
}
