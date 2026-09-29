// Shared async API over both engines. Every mutation is one atomic SQL statement;
// no async callback can escape a synchronous SQLite transaction. External effects
// must happen AFTER these calls return. Packet contents are private server data.
import {canonicalJson} from './canonical.mjs';
const key=value=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('Invalid operator operation identity');return value;};
const conflict=()=>Object.assign(Error('Operator operation parameters changed'),{code:'IDEMPOTENCY_CONFLICT'});
const decode=r=>r?{operationId:r.operation_id,attempt:Number(r.attempt),descriptor:r.descriptor,prepared:JSON.parse(r.prepared_json),signedBase64:r.signed_base64,signature:r.signature,status:r.status,result:r.result_json?JSON.parse(r.result_json):null}:null;
export function operatorPacketsApi({get,run},{now=Date.now}={}){
 const api={
  async get(operationId,attempt){key(operationId);if(!Number.isSafeInteger(attempt)||attempt<1)throw Error('Invalid operator attempt');return decode(await get('SELECT * FROM operator_packets WHERE operation_id=? AND attempt=?',[operationId,attempt]));},
  async latest(operationId){return decode(await get('SELECT * FROM operator_packets WHERE operation_id=? ORDER BY attempt DESC LIMIT 1',[key(operationId)]));},
  async prepare({operationId,descriptor,prepared,previous=null}){
   key(operationId);if(typeof descriptor!=='string'||!descriptor||descriptor.length>16384)throw Error('Invalid operator descriptor');
   if(previous!==null&&(!Number.isSafeInteger(previous)||previous<1))throw Error('Invalid previous attempt');
   const at=new Date(now()).toISOString(),attempt=(previous??0)+1;
   const values=[operationId,attempt,descriptor,canonicalJson(prepared),at,at];
   if(previous===null)await run("INSERT INTO operator_packets(operation_id,attempt,descriptor,prepared_json,status,created_at,updated_at) SELECT ?,?,?,?,'prepared',?,? WHERE NOT EXISTS (SELECT 1 FROM operator_packets WHERE operation_id=?) ON CONFLICT(operation_id,attempt) DO NOTHING",[...values,operationId]);
   else await run("INSERT INTO operator_packets(operation_id,attempt,descriptor,prepared_json,status,created_at,updated_at) SELECT ?,?,?,?,'prepared',?,? WHERE EXISTS (SELECT 1 FROM operator_packets WHERE operation_id=? AND attempt=? AND descriptor=? AND status IN ('failed','expired')) AND NOT EXISTS (SELECT 1 FROM operator_packets WHERE operation_id=? AND attempt>?) ON CONFLICT(operation_id,attempt) DO NOTHING",[...values,operationId,previous,descriptor,operationId,previous]);
   const row=await api.latest(operationId);
   if(!row||row.descriptor!==descriptor)throw conflict();
   return row;
  },
  /** Attaches custody (auxiliary) signatures to a PREPARED attempt: the prepared JSON is replaced only if it still equals the
   * exact previous one (compare-and-set) and the row is still prepared. The caller verified the message is unchanged. */
  async attachAuxiliary({operationId,attempt,prepared,previousPrepared}){
   key(operationId);if(!Number.isSafeInteger(attempt)||attempt<1)throw Error('Invalid operator attempt');
   const next=canonicalJson(prepared),prior=canonicalJson(previousPrepared);if(next===prior)return api.get(operationId,attempt);
   await run("UPDATE operator_packets SET prepared_json=?,updated_at=? WHERE operation_id=? AND attempt=? AND status='prepared' AND prepared_json=?",[next,new Date(now()).toISOString(),operationId,attempt,prior]);
   const row=await api.get(operationId,attempt);
   if(!row||canonicalJson(row.prepared)!==next)throw Object.assign(Error('Operator packet changed before custody signatures were attached'),{code:'PACKET_CONFLICT'});
   return row;
  },
  async sign({operationId,attempt,signedBase64,signature}){
   key(operationId);
   if(typeof signedBase64!=='string'||signedBase64.length>1644||!signedBase64||typeof signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature))throw Error('Invalid signed operator packet');
   await run("UPDATE operator_packets SET signed_base64=?,signature=?,status='signed',updated_at=? WHERE operation_id=? AND attempt=? AND status='prepared'",[signedBase64,signature,new Date(now()).toISOString(),operationId,attempt]);
   const row=decode(await get('SELECT * FROM operator_packets WHERE operation_id=? AND attempt=?',[operationId,attempt]));
   if(!row||row.signedBase64!==signedBase64||row.signature!==signature)throw Object.assign(Error('Operator packet changed or is no longer signable'),{code:'PACKET_CONFLICT'});
   return row;
  },
  async progress({operationId,attempt,from,to,result=null}){
   key(operationId);
   const allowed={prepared:['expired'],signed:['confirmed','finalized','failed','expired'],confirmed:['finalized']};
   if(!allowed[from]?.includes(to))throw Error('Invalid operator packet transition');
   await run('UPDATE operator_packets SET status=?,result_json=?,updated_at=? WHERE operation_id=? AND attempt=? AND status=?',[to,canonicalJson(result),new Date(now()).toISOString(),operationId,attempt,from]);
   return decode(await get('SELECT * FROM operator_packets WHERE operation_id=? AND attempt=?',[operationId,attempt]));
  },
 };
 return api;
}
