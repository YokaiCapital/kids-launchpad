// Turns mainnet snapshot evidence (snapshot-parents-mainnet.mjs output) into the campaign snapshot the program and the
// claim proofs use: the same Merkle tree as the localnet fixture, built from the CAPPED counted balances with the
// evidence's eligible total. Refuses evidence for another campaign, a missing parent or a hash that does not match.
import {existsSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {parentTree} from './atomic-claims.mjs';
const sha256=s=>createHash('sha256').update(s).digest('hex');
export function readSnapshotEvidence(directory,campaign,mint){
 const folder=join(directory,campaign),jsonPath=join(folder,mint+'.json'),allocationPath=join(folder,mint+'.allocation.csv');
 if(!existsSync(jsonPath)||!existsSync(allocationPath))throw Error('Snapshot evidence missing for '+mint+' under '+folder);
 const json=JSON.parse(readFileSync(jsonPath,'utf8')),csv=readFileSync(allocationPath,'utf8');
 if(json.campaign!==campaign||json.mint!==mint)throw Error('Snapshot evidence belongs to another campaign or mint');
 if(json.complete!==true)throw Error('Snapshot evidence is incomplete');
 if(json.allocation?.csvSha256!==sha256(csv))throw Error('Allocation CSV does not match its recorded hash');
 const lines=csv.trim().split('\n');if(lines[0]!=='owner,countedBalance,originalBalance')throw Error('Unexpected allocation CSV header');
 const balances=lines.slice(1).map(line=>{const [owner,counted]=line.split(',');if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)||!/^\d+$/.test(counted))throw Error('Bad allocation row');return {owner,balance:BigInt(counted)};});
 return {json,balances,eligibleTotal:BigInt(json.allocation.eligibleTotal),supply:BigInt(json.supply),slot:json.slotAfter??json.slot??null,tokenProgram:json.tokenProgram};
}
/** @returns the campaign snapshot in the fixture format ({network,genesisHash,campaign,commitment,slot,parents}) */
export function buildCampaignSnapshot({directory,campaign,network,genesisHash,parents}){
 const rows=parents.map((parent,index)=>{
  const e=readSnapshotEvidence(directory,campaign,parent.mint);
  const tree=parentTree(campaign,index,e.supply,e.balances,1000000000000000n,e.eligibleTotal);
  return {mint:parent.mint,tokenProgram:e.tokenProgram||parent.tokenProgram,supply:e.supply,balances:e.balances,slot:e.slot,evidenceSha256:{allocationCsv:e.json.allocation.csvSha256,holdersCsv:e.json.csvSha256},...tree};
 });
 const slot=rows.reduce((m,r)=>r.slot!==null&&(m===null||r.slot>m)?r.slot:m,null);
 return {network,genesisHash,campaign,commitment:'finalized',slot,source:'mainnet-parent-snapshot evidence',parents:rows};
}
