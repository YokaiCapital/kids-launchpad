// Operator tool: take the two mainnet parent snapshots for a campaign and write create-once evidence.
// Usage: KIDS_HELIUS_RPC_URL=<server-side Helius URL> node localnet/snapshot-parents-mainnet.mjs <campaign-address> <evidence-dir>
// Never prints the URL. Refuses anything but mainnet. Writes nothing on any failure.
import {readFileSync} from 'node:fs';import {Connection} from '@solana/web3.js';
import {readParentSnapshot,writeParentSnapshotEvidence,createHeliusDasClient,publicParentSnapshot,loadExclusions,sanitize,READ_RETRY_POLICY,finalizeParentAllocation,PER_OWNER_CAP_BPS} from './mainnet-parent-snapshot.mjs';
const exclusions=loadExclusions(readFileSync(new URL('../deployment/PARENT-SNAPSHOT-EXCLUSIONS.json',import.meta.url),'utf8'));
const [campaign,directory]=process.argv.slice(2);if(!campaign||!directory)throw Error('usage: <campaign-address> <evidence-dir>');
const url=process.env.KIDS_HELIUS_RPC_URL;if(!url)throw Error('KIDS_HELIUS_RPC_URL is not set (server-side variable)');
const identities=JSON.parse(readFileSync(new URL('../deployment/MAINNET-IDENTITIES.json',import.meta.url),'utf8'));
const log=line=>{if(line.event!=='read-ok')console.log(JSON.stringify(line));};
const deadlineAt=Date.now()+READ_RETRY_POLICY.operationDeadlineMs;
const connection=new Connection(url,'finalized'),das=createHeliusDasClient(url,globalThis.fetch,log,{deadlineAt});
const outcomes=await Promise.allSettled(identities.parents.map(async parent=>{
 console.log('reading',parent.role,parent.mint);const started=Date.now();
 const result=await readParentSnapshot(connection,das,parent.mint,{passes:2,exclusions,log,deadlineAt,custodialSignals:{rpcUrl:url,deadlineAt},onProgress:p=>{if(p.pages%25===0)console.log(JSON.stringify({mint:parent.mint,...p}));}});
 result.elapsedMs=Date.now()-started;result.allocation=finalizeParentAllocation(result,{capBps:PER_OWNER_CAP_BPS});return {parent,result};
}));
const failed=outcomes.filter(o=>o.status==='rejected');
if(failed.length){for(const f of failed)console.error('snapshot failed:',sanitize(f.reason?.message||f.reason).slice(0,300));console.error('nothing written: every parent must succeed in the same run');process.exit(1);}
const incomplete=outcomes.filter(o=>o.value.result.complete!==true);
if(incomplete.length){for(const {value:{parent,result}} of incomplete)console.error('incomplete evidence for',parent.role,'unresolved owner lookups:',result.custodialSignals?.unresolved);console.error('nothing written: incomplete evidence is never published');process.exit(2);}
for(const {value:{parent,result}} of outcomes){const {csvPath,jsonPath}=writeParentSnapshotEvidence(directory,campaign,result);const {balances,csv,allocation,...summary}=publicParentSnapshot(result);console.log(JSON.stringify({role:parent.role,...summary,allocation:{capBps:allocation.capBps,capped:allocation.capped,countedTotal:allocation.countedTotal,eligibleTotal:allocation.eligibleTotal,unallocatedBps:allocation.unallocatedBps,csvSha256:allocation.csvSha256},csvPath,jsonPath}));}
