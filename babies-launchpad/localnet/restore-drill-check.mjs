// Read-only comparison of the live mainnet API with a restored drill service (docs/RESTORE-DRILL.md).
//   KIDS_DRILL_TOKEN=… node localnet/restore-drill-check.mjs https://live-domain https://drill-domain
import {readFileSync} from 'node:fs';import {homedir} from 'node:os';
const [live,drill]=process.argv.slice(2);if(!live||!drill)throw Error('usage: <live-domain> <drill-domain>');
const access=JSON.parse(readFileSync(homedir()+'/.config/kids/mainnet-access.json','utf8'));const drillToken=process.env.KIDS_DRILL_TOKEN;if(!drillToken)throw Error('KIDS_DRILL_TOKEN missing');
async function read(base,token,path){const r=await fetch(base.replace(/\/$/,'')+path,{headers:{origin:'https://kids.fun',authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});return {status:r.status,body:await r.json().catch(()=>null)};}
const paths=['/statusz','/api/account/prelaunch','/api/account/postlaunch'];const out={};let mismatches=0;
for(const p of paths){const a=await read(live,access.KIDS_BACKEND_TOKEN,p),b=await read(drill,drillToken,p);const pick=o=>o&&typeof o==='object'?Object.fromEntries(Object.entries(o).filter(([k])=>['status','writesOpen','reconciliation','configured','phase','escrowAddress','mint','receiptCount','settledReceiptCount','totalLamports','campaign','pool'].includes(k))):o;
 const la=pick(a.body),lb=pick(b.body);const same=JSON.stringify(la)===JSON.stringify(lb);if(!same)mismatches+=1;out[p]={live:{status:a.status,...la},drill:{status:b.status,...lb},same};}
console.log(JSON.stringify(out,null,1));console.log(mismatches?'MISMATCH: '+mismatches+' path(s) differ (data-loss window or wrong backup)':'restored state matches live on every compared field');process.exit(mismatches?1:0);
