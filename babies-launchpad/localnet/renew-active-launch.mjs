// Boot-time renewal of a finished test campaign (private localnet only, behind KIDS_ACTIVE_CAMPAIGN_RENEW=finished|any).
// Runs in the bootstrap process before the API starts, never inside the API (its journals are loaded at import).
// 'finished' renews only a failed campaign with every commitment refunded; 'any' also renews a launched campaign once
// every receipt is settled and no signed intent is unresolved (test ledgers: the old coin stays on chain, unreachable from the site). The old campaign's files are moved to
// .runtime/archive/<campaign>/, never deleted (docs/ENGINEERING-RULES.md: preserve data across deployments).
import {existsSync,mkdirSync,renameSync,readdirSync,writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
const runtime=fileURLToPath(new URL('./.runtime/',import.meta.url));
import {summarizeIntents} from '../shared/intent-retention.mjs';
export const ACTIVE_CAMPAIGN_FILES=['active-launch.json','active-launch-setup-keys.json','active-launch-intents.json','active-launch-operator.json','active-settlement-operator.json','active-fee-operator.json','postlaunch-claim-intents.json','postlaunch-trade-intents.json'];
export const RENEW_MODES=new Set(['finished','any']);
const INTENT_SERVICES=[['active-launch-intents.json','active-launch','confirmedSignature'],['postlaunch-claim-intents.json','postlaunch-claims','confirmedSignature'],['postlaunch-trade-intents.json','postlaunch-trades','confirmed']];
/** Signed intents whose outcome is still unknown block renewal: archiving them would hide money in flight. */
export function unresolvedIntents(dir){
 const out=[];for(const [name,service,field] of INTENT_SERVICES){const path=join(dir,name);if(!existsSync(path))continue;const summary=summarizeIntents(service,JSON.parse(readFileSync(path,'utf8')),field);if(summary.unresolvedSigned>0)out.push({service,unresolvedSigned:summary.unresolvedSigned});}
 return out;
}
/** mode 'finished': only a failed campaign. mode 'any': also a launched campaign, or an OPEN campaign with no receipts and no
 * lamports committed (nobody has money in it, so replacing its terms costs nothing). Test ledgers only. Both need every
 * receipt settled, refunds complete for a failed campaign, and no signed intent with an unknown outcome. */
export function canRenewActiveCampaign(state,{mode='finished',unresolved=[]}={}){
 if(!RENEW_MODES.has(mode))return {ok:false,reason:'unknown renew mode '+mode};
 if(!state||state.configured!==true)return {ok:false,reason:'no active campaign'};
 const empty=state.phase==='open'&&String(state.receiptCount)==='0'&&BigInt(state.totalLamports||0)===0n;
 if(state.phase!=='failed'&&!(mode==='any'&&(state.phase==='launched'||empty)))return {ok:false,reason:'campaign is '+state.phase+', mode '+mode+' does not renew it'};
 if(state.phase==='failed'&&BigInt(state.refundedLamports||0)!==BigInt(state.totalLamports||0))return {ok:false,reason:'refunds outstanding'};
 if(String(state.settledReceiptCount)!==String(state.receiptCount))return {ok:false,reason:'receipts not all settled'};
 if(unresolved.length)return {ok:false,reason:'signed intents unresolved: '+unresolved.map(u=>u.service+'='+u.unresolvedSigned).join(', ')};
 return {ok:true,reason:state.phase+' campaign settled with nothing pending'};
}
/** Moves the campaign's runtime files into an archive folder named after the campaign; returns what moved. */
export function archiveActiveCampaignFiles(dir,campaign){
 if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(campaign))throw Error('Campaign address required');
 const target=join(dir,'archive',campaign);if(existsSync(target)&&readdirSync(target).length)throw Error('Archive folder already holds files for '+campaign);
 mkdirSync(target,{recursive:true,mode:0o700});const moved=[];
 for(const base of [...ACTIVE_CAMPAIGN_FILES,'parent-snapshot-'+campaign+'.json'])for(const name of [base,base+'.archive']){const from=join(dir,name);if(existsSync(from)){renameSync(from,join(target,name));moved.push(name);}}
 return {target,moved};
}
const appliedPath=join(runtime,'renew-applied.json');
/** Parses KIDS_ACTIVE_CAMPAIGN_RENEW: 'finished' | 'any:<token>'. Mode 'any' can archive a launched coin, so it applies
 * once per token (the owner's script sends a fresh token each run); a plain 'any' with no token never renews. */
export function parseRenewSetting(value){
 if(typeof value!=='string'||!value)return null;const [mode,...rest]=value.split(':');const token=rest.join(':')||null;
 if(!RENEW_MODES.has(mode))return null;if(mode==='any'&&!token)return {mode,token:null,refused:"mode 'any' needs a token (any:<token>), a plain 'any' would archive a launched coin on every restart"};
 return {mode,token,refused:null};
}
export function tokenAlreadyApplied(dir,token){if(!token)return false;const path=join(dir,'renew-applied.json');if(!existsSync(path))return false;try{return JSON.parse(readFileSync(path,'utf8')).tokens?.includes(token)===true;}catch{return false;}}
function recordApplied(dir,token,campaign){if(!token)return;const path=join(dir,'renew-applied.json');let data={tokens:[],history:[]};if(existsSync(path)){try{data=JSON.parse(readFileSync(path,'utf8'));}catch{}}data.tokens=[...new Set([...(data.tokens||[]),token])].slice(-200);data.history=[...(data.history||[]),{token,campaign,at:new Date().toISOString()}].slice(-200);writeFileSync(path,JSON.stringify(data,null,1),{mode:0o600});}
/** Puts an archived campaign back as the active one (KIDS_ACTIVE_CAMPAIGN_RESTORE=<campaign>): every file in
 * archive/<campaign>/ moves back into the runtime folder; whatever sits there now for those names is kept aside in
 * archive/<campaign>-replaced-<stamp>/. Nothing is deleted. Returns what moved; throws when there is nothing to restore. */
export function restoreArchivedCampaignFiles(dir,campaign,stamp=new Date().toISOString().replace(/[:.]/g,'-')){
 if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(campaign)))throw Error('Campaign address to restore is invalid');
 const source=join(dir,'archive',campaign);if(!existsSync(source)||!existsSync(join(source,'active-launch.json')))throw Error('No archived campaign files for '+campaign);
 const aside=join(dir,'archive',campaign+'-replaced-'+stamp);const names=readdirSync(source);const moved=[],replaced=[];
 for(const name of names){const current=join(dir,name);if(existsSync(current)){mkdirSync(aside,{recursive:true,mode:0o700});renameSync(current,join(aside,name));replaced.push(name);}}
 for(const name of names){renameSync(join(source,name),join(dir,name));moved.push(name);}
 return {moved,replaced,aside:replaced.length?aside:null};
}
export function restoreActiveCampaign(campaign,log=()=>{}){
 const r=restoreArchivedCampaignFiles(runtime,campaign);log({event:'active-campaign-restored',campaign,moved:r.moved,replaced:r.replaced,aside:r.aside});return r;
}
export async function renewFinishedActiveLaunch({log=()=>{},mode='finished',token=null}={}){
 const {readActive}=await import('./active-launch.mjs');const state=await readActive();
 if(tokenAlreadyApplied(runtime,token)){log({event:'active-campaign-renew-skipped',reason:'token already applied',token});return {renewed:false,reason:'token already applied',campaign:state?.escrowAddress??null};}
 const verdict=canRenewActiveCampaign(state,{mode,unresolved:state?.configured===true?unresolvedIntents(runtime):[]});
 if(!verdict.ok){log({event:'active-campaign-renew-skipped',reason:verdict.reason,phase:state?.phase??null});return {renewed:false,reason:verdict.reason,campaign:state?.escrowAddress??null};}
 const archived=archiveActiveCampaignFiles(runtime,state.escrowAddress);log({event:'active-campaign-archived',campaign:state.escrowAddress,moved:archived.moved});
 // The token is spent the moment something was archived, whether or not the new campaign provisions: on 24 Sep 2026 a
 // renewal that failed at provisioning left its token unrecorded and a later restart archived the launched coin.
 recordApplied(runtime,token,null);
 const {provisionActiveLaunch}=await import('./provision-active-launch.mjs');const next=await provisionActiveLaunch();
 recordApplied(runtime,token,next.escrowAddress);log({event:'active-campaign-renewed',previous:state.escrowAddress,next:next.escrowAddress,deadlineUnix:next.deadlineUnix,token});
 return {renewed:true,previous:state.escrowAddress,archive:archived.target,next:{campaign:next.escrowAddress,deadlineUnix:next.deadlineUnix}};
}
