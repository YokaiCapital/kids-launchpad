// V3 process ownership. Database time grants a bounded lease; monotonic local
// time subtracts the full round trip and a safety margin. Losing it is terminal
// for this process. Automatic renewal must never resurrect an expired owner.
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
const unavailable=()=>Object.assign(Error('Signer ownership unavailable; restart requires journal verification'),{code:'SIGNER_OWNERSHIP_UNAVAILABLE'});
export async function acquireSignerOwnership({registry,genesisHash,programId,payer,ttlMs=30000,marginMs=5000,monotonicNow=()=>performance.now(),heartbeat=true}){
 if(registry?.driver!=='postgres'||typeof registry.query!=='function')throw Error('Signer ownership requires PostgreSQL');
 const scope=[genesisHash,programId,payer];for(const address of scope)if(new PublicKey(address).toBase58()!==address)throw Error('Invalid signer ownership scope');
 if(!Number.isInteger(ttlMs)||ttlMs<10000||ttlMs>60000||!Number.isInteger(marginMs)||marginMs<1000||marginMs>=ttlMs/3||typeof monotonicNow!=='function')throw Error('Invalid signer ownership timing');
 const owner=randomUUID();let epoch=null,deadline=-Infinity,active=true,pending=null,timer=null,closing=null;
 const valid=()=>active&&monotonicNow()<deadline;
 const stop=()=>{active=false;if(timer)clearTimeout(timer);timer=null;};
 const accept=(row,started)=>{
  const remaining=Number(row?.remaining_ms),next=String(row?.epoch??'');
  if(!row||!(/^[1-9][0-9]*$/).test(next)||!Number.isFinite(remaining)||remaining>ttlMs||remaining-(monotonicNow()-started)<=marginMs)throw unavailable();
  if(epoch!==null&&next!==epoch)throw unavailable();
  epoch=next;deadline=started+remaining-marginMs;
 };
 const time='floor(extract(epoch FROM clock_timestamp())*1000)::bigint';
 const started=monotonicNow();
 try{
  const rows=(await registry.query(`WITH t AS MATERIALIZED (SELECT ${time} AS now_ms)
   INSERT INTO signer_ownership(genesis_hash,program_id,payer,owner,epoch,expires_ms)
   SELECT ?,?,?,?,1,t.now_ms+? FROM t
   ON CONFLICT(genesis_hash,program_id,payer) DO UPDATE
    SET owner=EXCLUDED.owner,epoch=signer_ownership.epoch+1,expires_ms=EXCLUDED.expires_ms
    WHERE signer_ownership.owner IS NULL OR signer_ownership.expires_ms<=(SELECT now_ms FROM t)
   RETURNING epoch,expires_ms-(SELECT now_ms FROM t) AS remaining_ms`,[...scope,owner,ttlMs])).rows;
  accept(rows[0],started);
 }catch{stop();throw unavailable();}
 const renew=()=>{
  if(pending)return pending;
  if(!valid()){stop();return Promise.reject(unavailable());}
  const priorDeadline=deadline,started=monotonicNow();
  pending=(async()=>{
   try{
    const rows=(await registry.query(`WITH t AS MATERIALIZED (SELECT ${time} AS now_ms)
     UPDATE signer_ownership SET expires_ms=t.now_ms+? FROM t
     WHERE genesis_hash=? AND program_id=? AND payer=? AND owner=? AND epoch=? AND expires_ms>t.now_ms
     RETURNING epoch,expires_ms-t.now_ms AS remaining_ms`,[ttlMs,...scope,owner,epoch])).rows;
    // A renewal acknowledged after our old conservative deadline cannot restore
    // ownership. Its database row is allowed to expire before a replacement starts.
    if(!active||monotonicNow()>=priorDeadline)throw unavailable();
    accept(rows[0],started);
   }catch{stop();throw unavailable();}
   finally{pending=null;}
  })();return pending;
 };
 const schedule=()=>{if(!heartbeat||!valid())return;timer=setTimeout(async()=>{timer=null;try{await renew();schedule();}catch{/* fail closed until restart */}},Math.floor((ttlMs-marginMs)/3));timer.unref?.();};
 schedule();
 return {
  valid,stop,renew,
  close(){
   if(closing)return closing;stop();
   closing=(async()=>{if(pending)await pending.catch(()=>{});
    // Keep the epoch row. A stale close must never release a replacement owner.
    await registry.query('UPDATE signer_ownership SET owner=NULL,expires_ms=0 WHERE genesis_hash=? AND program_id=? AND payer=? AND owner=? AND epoch=?',[...scope,owner,epoch]);
   })();return closing;
  }
 };
}
