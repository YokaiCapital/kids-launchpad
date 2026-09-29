// PostgreSQL is the clock authority for worker leases. Host timestamps remain
// useful for logs, but must never grant, extend or finish financial job custody.
// Rewrite only the explicitly listed shared job statements; caller-supplied
// deadlines/not-before times retain their meaning. SQLite keeps its test clock.
import {SQL} from './registry.mjs';
export const databaseIso="to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
const rules=[
 ['jobInsert',{time:[8,9]}],
 ['jobNext',{time:[0,1]}],
 ['jobDue',{time:[0,1]}],
 ['jobHolds',{time:[3]}],
 ['jobLease',{time:[3,6],expiry:1,base:3}],
 ['jobRenew',{time:[1,5],expiry:0,base:1}],
 ['jobComplete',{time:[1,4]}],
 ['jobFail',{time:[2,5]}],
 ['jobRequeue',{time:[2,5]}]
];
export function postgresJobStatement(sql,params){
 const rule=rules.find(([name])=>SQL[name]===sql)?.[1];if(!rule)return null;
 let index=0;const values=[];
 let text=sql.replace(/\?/g,()=>{
  const i=index++;
  if(rule.time.includes(i))return databaseIso;
  if(i===rule.expiry){
   const ttl=Date.parse(params[i])-Date.parse(params[rule.base]);
   if(!Number.isInteger(ttl)||ttl<1000||ttl>3600000)throw Error('Invalid database lease duration');
   values.push(ttl);
   return `to_char((clock_timestamp()+($${values.length}::double precision*interval '1 millisecond')) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  }
  values.push(params[i]);return '$'+values.length;
 });
 if(index!==params.length)throw Error('Job statement parameter mismatch');
 if(sql.startsWith('UPDATE jobs')){
  // Obtain the row before evaluating expiry. A writer can otherwise wait on
  // an unchanged row lock and finish using a predicate evaluated before expiry.
  const binding=text.match(/WHERE job_id=(\$\d+)/)?.[1];
  if(!binding)throw Error('Job update lock binding unavailable');
  text=`WITH kids_locked_job AS MATERIALIZED (SELECT job_id FROM jobs WHERE job_id=${binding} FOR UPDATE) `+
   text.replace('WHERE job_id='+binding,'WHERE job_id=(SELECT job_id FROM kids_locked_job)');
 }
 return {text,values};
}
