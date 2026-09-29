// V3 restart/restore admission, not an automatic repair tool. A database backup
// must cover the signer's approvals/fences, and recent persisted signatures must
// exist in the disk approval journal. Never silently start a blank spend history.
// This cannot authenticate a coordinated rollback of BOTH stores; restore still
// requires the release runbook and chain reconciliation before workers restart.
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {PublicKey} from '@solana/web3.js';
const fail=()=>{throw Error('Signer journal and registry need recovery verification');};
const validHash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const chunks=function*(rows){for(let n=0;n<rows.length;n+=256)yield rows.slice(n,n+256);};
export async function assertJournalCoverage({registry,stateFile,genesisHash,programId,payer,now=Date.now}){
 const scope=[genesisHash,programId,payer];for(const x of scope)if(new PublicKey(x).toBase58()!==x)fail();
 const at=now();if(!Number.isSafeInteger(at)||at<0)fail();
 let journal=null;
 if(existsSync(stateFile)){
  const stat=lstatSync(stateFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024||(stat.mode&0o077)!==0)fail();
  try{journal=JSON.parse(readFileSync(stateFile,'utf8'));}catch{fail();}
  if(!journal||!Array.isArray(journal.ledger)||!Array.isArray(journal.registry)||!Array.isArray(journal.fences)||journal.registry.length>100000||journal.fences.length>100000)fail();
  for(const e of journal.ledger)if(!Number.isSafeInteger(e.at)||e.at<0||typeof e.lamports!=='string'||!(/^[0-9]{1,20}$/).test(e.lamports))fail();
  const ids=new Set(),fences=new Set();
  for(const entry of journal.registry){
   if(!Array.isArray(entry)||entry.length!==2)fail();const [id,value]=entry;
   if(typeof id!=='string'||!(/^op:[a-f0-9]{64}$/).test(id)||!validHash(value?.hash)||!Number.isSafeInteger(value?.at)||value.at<0||ids.has(id))fail();ids.add(id);
  }
  for(const entry of journal.fences){
   if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||!Number.isSafeInteger(entry[1])||entry[1]<1||fences.has(entry[0]))fail();fences.add(entry[0]);
   const parts=entry[0].split('|');if(parts.length!==2||new PublicKey(parts[0]).toBase58()!==parts[0]||!(/^[A-Za-z0-9_.:-]{1,128}$/).test(parts[1]))fail();
  }
 }
 return registry.transaction(async()=>{
  await registry.query("SET LOCAL statement_timeout='5000ms'");
  const approvals=new Map(journal?.registry||[]),charged=new Map(),approvedCharges=new Map();
  for(const e of journal?.ledger||[])charged.set(e.at,(charged.get(e.at)||0n)+BigInt(e.lamports));
  for(const batch of chunks([...approvals])){
   const rows=(await registry.query('SELECT operation_id,message_hash,maximum_lamports FROM operating_spend_holds WHERE genesis_hash=? AND program_id=? AND payer=? AND operation_id=ANY(?::text[])',[...scope,batch.map(([id])=>id)])).rows;
   const found=new Map(rows.map(r=>[r.operation_id,r.message_hash]));
   if(found.size!==batch.length||batch.some(([id,v])=>found.get(id)!==v.hash))fail();
   const limits=new Map(rows.map(r=>[r.operation_id,r.maximum_lamports]));
   // charge() and approve() use the same timestamp. A conservative charge may
   // exist without an approval after a crash, but never the reverse. Preserve
   // the hourly ceiling even when the corresponding transaction is terminal.
   for(const [id,v] of batch)if(at-v.at<=3600000){
    const amount=limits.get(id);if(typeof amount!=='string'||!(/^[0-9]{1,20}$/).test(amount))fail();
    approvedCharges.set(v.at,(approvedCharges.get(v.at)||0n)+BigInt(amount));
   }
  }
  for(const [timestamp,amount] of approvedCharges)if((charged.get(timestamp)||0n)<amount)fail();
  for(const batch of chunks(journal?.fences||[])){
   const input=batch.map(([name,token])=>{const [campaign,operation]=name.split('|');return {campaign,operation,token};});
   const rows=(await registry.query(`SELECT x.campaign,x.operation,j.fencing_token FROM jsonb_to_recordset(?::jsonb) AS x(campaign text,operation text,token bigint)
    LEFT JOIN jobs j ON j.genesis_hash=? AND j.program_id=? AND j.campaign=x.campaign AND j.operation_key=x.operation`,[JSON.stringify(input),genesisHash,programId])).rows;
   const found=new Map(rows.map(r=>[r.campaign+'|'+r.operation,Number(r.fencing_token)]));
   if(batch.some(([name,token])=>!Number.isSafeInteger(found.get(name))||found.get(name)<token))fail();
  }
  // Terminal signed shadows still represent hourly signing exposure.
  // Shadow packets are retained by operating accounting even after the caller
  // loses its signed response. Restrict the scan to the live spend window.
  const recent=(await registry.query(`SELECT descriptor FROM operator_packets WHERE signed_base64 IS NOT NULL AND updated_at>=?
   AND descriptor::jsonb->'binding'->>'genesisHash'=? AND descriptor::jsonb->'binding'->>'programId'=? AND descriptor::jsonb->'binding'->>'payer'=? LIMIT 100001`,[new Date(Math.max(0,at-3600000)).toISOString(),...scope])).rows;
  if(recent.length>100000)fail();
  for(const r of recent){const b=JSON.parse(r.descriptor).binding;if(!b||approvals.get(b.operationId)?.hash!==b.messageHash)fail();}
  // A missing file with older signatures is also unsafe: it could erase permanent
  // fencing marks. Initial startup is allowed only on an unused payer scope.
  if(!journal){
   const signed=(await registry.query(`SELECT 1 FROM operator_packets WHERE signed_base64 IS NOT NULL
    AND descriptor::jsonb->'binding'->>'genesisHash'=? AND descriptor::jsonb->'binding'->>'programId'=? AND descriptor::jsonb->'binding'->>'payer'=? LIMIT 1`,scope)).rows;
   if(signed.length)fail();
  }
  return {verified:true,approvals:approvals.size,fences:journal?.fences.length??0};
 },{retry:false});
}
