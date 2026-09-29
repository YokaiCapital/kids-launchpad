// Campaign directory (plan section 8, P1): GET /api/campaigns?status=&mode=&cursor=, /api/campaigns/:id and
// /api/campaigns/:id/terms, served from the registry. Read-only. The id is a campaign address or
// genesis:program:campaign (the address alone is refused with 409 when two ledgers share it). The plugin never opens a
// registry file of its own: it is handed the registry (or an opener for it) by the caller. In the API process that is
// the one the startup import opened under KIDS_REGISTRY_URL, seen read-only (campaignsPluginFor); with the variable
// unset the plugin is not installed and the route is 404, as before this slice. A registry that cannot be reached
// answers 503, never an invented empty directory. `live` on one campaign is null unless a readView is configured: chain
// numbers are explicit about their source or absent, never guessed.
import {createPublicLaunchAccess,verifiedPilotOwner,PRIVATE_CAMPAIGNS_PREFIX} from './public-launch-access.mjs';
import {DEFAULT_PAGE} from '../../localnet/registry/registry.mjs';
import {campaignTerms} from '../../localnet/registry/read-adapters.mjs';
import {readPresets} from '../../localnet/registry/presets.mjs';
import {campaignViewModel,publicPresetManifest,PUBLIC_CONTRACT_VERSION} from './public-campaign-contract.mjs';
import {readOnlyRegistry} from '../../localnet/registry/startup.mjs';
export const CAMPAIGNS_PATH=/^\/api\/campaigns(?:\/([1-9A-HJ-NP-Za-km-z]{32,44}(?::[1-9A-HJ-NP-Za-km-z]{32,44}:[1-9A-HJ-NP-Za-km-z]{32,44})?)(\/terms)?)?$/;
export const QUERY_KEYS=Object.freeze(['status','mode','cursor','creator','q','limit','sort']);
export const MAX_QUERY=600;
/** Every field a public campaign row carries; anything else on the registry row (file paths, paging ordinal, future
 * operational columns) stays out. Adding a field here is a deliberate publication. */
export const PUBLIC_CAMPAIGN_FIELDS=Object.freeze(['genesisHash','programId','campaign','slug','network','mode','campaignVersion','termsHash','registryStatus','chainStatus','sourceSlot','sourceCommitment','legacyAdapterVersion','creator','nonce','mint','pool','name','symbol','dev','treasury','parentMints','opensAt','deadlineUnix','launchDeadlineUnix','softCapLamports','hardCapLamports','supplyRaw','launchSignature','launchedAt','createdAt','updatedAt']);
/** Sealed money terms only: the plan time, snapshot directory, program hash and any other internal note stay out. */
export const PUBLIC_TERMS_FIELDS=Object.freeze(['deadlineSeconds','feeNft','note']);
/** Public shape of a registry row: an explicit allow-list of fields; the chain projection is labelled. */
export function publicCampaign(row){
 const out={};for(const k of PUBLIC_CAMPAIGN_FIELDS)out[k]=row[k]===undefined?null:row[k];
 let terms=null;if(row.terms&&typeof row.terms==='object'){terms={};for(const k of PUBLIC_TERMS_FIELDS)if(row.terms[k]!==undefined)terms[k]=row.terms[k];}
 return {...out,terms,view:campaignViewModel(row),id:row.genesisHash+':'+row.programId+':'+row.campaign,chain:{status:row.chainStatus,slot:row.sourceSlot,commitment:row.sourceCommitment,state:row.chainStatus?'projected':'unknown'}};
}
/** The plugin for the API process: installed only when KIDS_REGISTRY_URL is set, over the registry the startup import
 * opened (startRegistryImport), seen read-only. Returns null otherwise, so the route stays 404 and no file is created. */
export function campaignsPluginFor({env=process.env,registryImport=null,readView=null,manifest=null,authorize=null,log}={}){
 if(!env.KIDS_REGISTRY_URL||!registryImport||registryImport.configured!==true)return null;
 const access=createPublicLaunchAccess(env);
 return campaignsPlugin({open:()=>{const r=registryImport.registry;if(!r)throw Error('campaign registry is not open yet');return readOnlyRegistry(r);},readView,manifest,authorize:authorize||((req)=>access.allows(req[verifiedPilotOwner])),...(log?{log}:{})});
}
export function campaignsPlugin({registry=null,open=null,readView=null,manifest=null,readProfile=null,authorize=()=>false,log=line=>console.log(JSON.stringify(line))}={}){
 if(!registry&&typeof open!=='function')throw Error('campaignsPlugin needs a registry or an opener: it never opens a registry file of its own');
 const opener=open||(()=>registry);
 let opened=registry,failedAt=0;
 const getRegistry=()=>{
  if(opened)return opened;if(failedAt&&Date.now()-failedAt<10000)return null;
  try{opened=opener();return opened;}catch(e){failedAt=Date.now();log({event:'campaign-registry-unavailable'});return null;}
 };
 const cache=new Map();
 const enrich=async row=>{
  const id=row.genesisHash+':'+row.programId+':'+row.campaign;
  const body=publicCampaign(row),rowKey=JSON.stringify(body);
  const prior=cache.get(id);if(prior&&prior.rowKey===rowKey&&prior.until>Date.now())return prior.promise;
  const promise=(async()=>{
   let live=null,profile=null;
   if(readView){try{live=await readView(row);}catch{live={available:false,error:{category:'upstream',message:'Live data unavailable'}};}}
   if(readProfile){try{profile=await readProfile(row);}catch{/* profile failure must not invent financial data */}}
   body.live=live;body.view=campaignViewModel(row,{live,profile});return body;
  })();
  if(cache.size>=200)cache.delete(cache.keys().next().value);
  cache.set(id,{rowKey,until:Date.now()+10000,promise});return promise;
 };
 // Release-file manifests are immutable for this process. Live configuration
 // uses the explicit provider function, which is still evaluated per request.
 let releaseManifest;
 const servedManifest=()=>typeof manifest==='function'?manifest():manifest||(releaseManifest??=publicPresetManifest(readPresets()));
 const pendingLists=new Map();
 const listPage=(reg,filters)=>{
  const key=JSON.stringify(filters),prior=pendingLists.get(key);if(prior)return prior;
  // Only in-flight queries coalesce: a subsequent request always sees registry
  // changes, including status/visibility updates. Authorization happens first.
  const promise=Promise.resolve().then(()=>reg.campaigns.list(filters));
  if(pendingLists.size<64){pendingLists.set(key,promise);promise.then(()=>{if(pendingLists.get(key)===promise)pendingLists.delete(key);},()=>{if(pendingLists.get(key)===promise)pendingLists.delete(key);});}
  return promise;
 };
 // A directory larger than the per-coin cache must not evict in-flight reads
 // repeatedly when many visitors request the same pages. Coalesce enrichment
 // for one second; still read/authorize the directory independently per request.
 // The key includes the complete public row, so registry updates bypass it.
 const pages=new Map();
 const enrichPage=rows=>{
  const key=JSON.stringify(rows.map(publicCampaign)),prior=pages.get(key);
  if(prior&&prior.until>Date.now())return prior.promise;
  const promise=(async()=>{const values=[];for(let i=0;i<rows.length;i+=4)values.push(...await Promise.all(rows.slice(i,i+4).map(enrich)));return values;})();
  if(pages.size>=64)pages.delete(pages.keys().next().value);
  pages.set(key,{until:Date.now()+1000,promise});return promise;
 };
 const install=server=>{
  server.middlewares.use(async(req,res,next)=>{
   const url=req.url||'',cut=url.indexOf('?'),path=cut<0?url:url.slice(0,cut),search=cut<0?'':url.slice(cut+1);
   const route=path.startsWith(PRIVATE_CAMPAIGNS_PREFIX)?'/api/campaigns'+path.slice(PRIVATE_CAMPAIGNS_PREFIX.length):path;
   const m=CAMPAIGNS_PATH.exec(route);if(!m)return next();
   const send=(status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.end(JSON.stringify(body));};
   if(req.method!=='GET')return send(405,{error:'Method not allowed'});
   if(!authorize(req))return send(403,{error:'Launch pilot unavailable'});
   const reg=getRegistry();if(!reg)return send(503,{error:'Campaign registry unavailable'});
   if(!m[1]){
    if(search.length>MAX_QUERY||!/^[A-Za-z0-9=&_.%,+~-]*$/.test(search))return send(400,{error:'Invalid query'});
    const q=new URLSearchParams(search);for(const k of q.keys())if(!QUERY_KEYS.includes(k)||q.getAll(k).length!==1)return send(400,{error:'Invalid query parameter '+k});
    const sort=q.get('sort')||'newest',status=q.get('status')||null,mode=q.get('mode')||null,cursor=q.get('cursor')||null,creator=q.get('creator')||null,query=q.get('q')?.trim()||null,limit=q.has('limit')?Number(q.get('limit')):DEFAULT_PAGE;
    if(!Number.isInteger(limit)||limit<1||limit>DEFAULT_PAGE)return send(400,{error:'Invalid page size'});
    let page;try{page=await listPage(reg,{status,mode,creator,query,sort,cursor,limit});}catch(e){const invalid=['Invalid cursor','Invalid directory sort','Cursor sort mismatch','Unknown status filter','Unknown mode filter','Invalid creator filter','Invalid search'].includes(e?.message);return send(invalid?400:503,{error:invalid?'Invalid campaign query':'Campaign registry temporarily unavailable'});}
    const campaigns=await enrichPage(page.campaigns);
    return send(200,{contractVersion:PUBLIC_CONTRACT_VERSION,chainTimeUnix:campaigns.find(c=>c.view?.source.chainTimeUnix!=null)?.view.source.chainTimeUnix??null,campaigns,manifest:servedManifest(),nextCursor:page.nextCursor,count:page.campaigns.length,filters:{status,mode,creator,query,sort}});
   }
   if(search)return send(400,{error:'This route takes no query'});
   let row;try{row=await reg.campaigns.get(m[1]);}catch(e){if(e?.code==='AMBIGUOUS')return send(409,{error:'Campaign address is ambiguous. Use its complete network and program ID.'});return send(503,{error:'Campaign registry temporarily unavailable'});}
   if(!row)return send(404,{error:'Unknown campaign'});
   if(m[2])return send(200,campaignTerms(row));
   return send(200,await enrich(row));
  });
 };
 return {name:'kids-campaigns',configureServer:install,configurePreviewServer:install,close(){if(opened&&opened!==registry){opened.close();}opened=null;}};
}
