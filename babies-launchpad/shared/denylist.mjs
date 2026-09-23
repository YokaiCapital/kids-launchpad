// Wallet blocklist (owner decision, 23 September 2026): an append-only journal in the repository, carried by releases.
// kids.fun refuses listed wallets (launch creation, commitments, trades through the site); program-level enforcement
// follows in a later build. Public pools cannot be blocked, so listed wallets' trades are shown, not hidden.
import {readFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';
const journalPath=fileURLToPath(new URL('../deployment/mainnet/denylist.json',import.meta.url));
export const DENY_REASONS=Object.freeze(['bundler','fake-leaderboard','drained-funds','vamp','other']);
/** Current state of the journal: the last row per wallet wins; only 'active' rows are enforced. */
export function denylistState(journal,now=new Date()){
 const rows=Array.isArray(journal?.entries)?journal.entries:[];const byWallet=new Map();
 for(const r of rows){if(!r||typeof r.wallet!=='string')continue;const prev=byWallet.get(r.wallet);byWallet.set(r.wallet,{...r,status:r.status||'active',history:[...(prev?.history||[]),{status:r.status||'active',addedAt:r.addedAt||null,reason:r.reason||'other',evidenceUrl:r.evidenceUrl||null}]});}
 const wallets=[...byWallet.values()].map(r=>({wallet:r.wallet,clusterId:r.clusterId||null,reason:r.reason||'other',evidenceUrl:r.evidenceUrl||null,addedAt:r.addedAt||null,addedBy:r.addedBy||null,status:r.status,history:r.history}));
 const active=new Set(wallets.filter(w=>w.status==='active').map(w=>w.wallet));
 const today=now.toISOString().slice(0,10),addedToday=rows.filter(r=>typeof r?.addedAt==='string'&&r.addedAt.slice(0,10)===today).length;
 return {wallets,active,counts:{active:active.size,total:wallets.length,addedToday},enforcement:{site:true,program:false,note:'Refused on kids.fun today: launches, commitments and trades through the site. Refused by the program from a later build. Public pools cannot be blocked; listed wallets\' trades are shown.'}};
}
let cache={at:0,value:null};
export function readDenylist(now=Date.now()){if(cache.value&&now-cache.at<60000)return cache.value;let journal;try{journal=JSON.parse(readFileSync(journalPath,'utf8'));}catch{journal={entries:[]};}cache={at:now,value:denylistState(journal,new Date(now))};return cache.value;}
export function walletDenied(wallet){try{return readDenylist().active.has(String(wallet));}catch{return false;}}
export const DENIED_MESSAGE='This wallet is not allowed to use kids.fun. The list and the reasons are public on the site.';
