// Community files (believers list and wallet proofs) published by the outreach worker through the gateway's community
// route, stored on the volume and served to the site. The worker never touches KIDS keys; the API only checks the
// envelope, keeps the last versions for audit and serves the current one. The blocklist is NOT here: it is a repository
// file carried by releases, because it drives enforcement.
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,readdirSync,unlinkSync} from 'node:fs';import {fileURLToPath} from 'node:url';
import {trustedGatewayContext} from '../../shared/trusted-gateway.mjs';import {readDenylist} from '../../shared/denylist.mjs';
const runtime=fileURLToPath(new URL('../../localnet/.runtime/community/',import.meta.url));let writeSequence=0;
export const COMMUNITY_FILES=Object.freeze({'supporters':{max:2_000_000,entry:e=>typeof e?.xId==='string'&&/^\d{1,25}$/.test(e.xId)&&typeof e.username==='string'&&e.username.length<=32&&(e.name==null||typeof e.name==='string')&&(e.followers==null||Number.isInteger(e.followers))&&Array.isArray(e.how)&&e.how.every(h=>typeof h==='string'&&h.length<=40)&&typeof e.since==='string'&&!Number.isNaN(Date.parse(e.since))},
 'supporter-wallets':{max:2_000_000,entry:e=>typeof e?.xId==='string'&&/^\d{1,25}$/.test(e.xId)&&typeof e.wallet==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(e.wallet)&&typeof e.provedAt==='string'&&!Number.isNaN(Date.parse(e.provedAt))&&typeof e.tweetUrl==='string'&&/^https:\/\/(x|twitter)\.com\//.test(e.tweetUrl)}});
/** Validates an envelope {generatedAt, entries:[...]}; returns the problem or null. */
export function validateEnvelope(name,body){
 const spec=COMMUNITY_FILES[name];if(!spec)return 'unknown file';
 if(!body||typeof body!=='object'||Array.isArray(body))return 'envelope must be an object';
 if(typeof body.generatedAt!=='string'||Number.isNaN(Date.parse(body.generatedAt)))return 'generatedAt must be an ISO date';
 if(!Array.isArray(body.entries))return 'entries must be an array';if(body.entries.length>50000)return 'too many entries';
 const seen=new Set();for(const [i,e] of body.entries.entries()){if(!spec.entry(e))return 'entry '+i+' is invalid';if(seen.has(e.xId))return 'entry '+i+' repeats xId '+e.xId;seen.add(e.xId);}
 for(const k of Object.keys(body))if(!['generatedAt','entries','source','note'].includes(k))return 'unexpected field '+k;
 return null;
}
export function readCommunityFile(name,dir=runtime){const p=dir+name+'.json';if(!existsSync(p))return null;try{return JSON.parse(readFileSync(p,'utf8'));}catch{return null;}}
export function writeCommunityFile(name,body,dir=runtime,keep=5){
 mkdirSync(dir,{recursive:true,mode:0o700});const p=dir+name+'.json',stamp=new Date().toISOString().replace(/[:.]/g,'-')+'-'+(writeSequence=(writeSequence+1)%1000).toString().padStart(3,'0');
 if(existsSync(p))renameSync(p,dir+name+'.'+stamp+'.json');
 const tmp=p+'.tmp';writeFileSync(tmp,JSON.stringify(body),{mode:0o600});renameSync(tmp,p);
 const old=readdirSync(dir).filter(f=>f.startsWith(name+'.')&&f.endsWith('.json')&&f!==name+'.json').sort();for(const f of old.slice(0,Math.max(0,old.length-keep)))unlinkSync(dir+f);
}
export function communityPlugin({dir=runtime}={}){
 const cache=new Map();
 const install=server=>{
  server.middlewares.use(async(req,res,next)=>{
   const path=(req.url||'').split('?')[0];
   if(path==='/api/community/denylist'){if(req.method!=='GET'){res.statusCode=405;return res.end();}const d=readDenylist();res.statusCode=200;res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');return res.end(JSON.stringify({wallets:d.wallets,counts:d.counts,enforcement:d.enforcement,updatedAt:new Date().toISOString()}));}
   const m=/^\/api\/community\/(supporters|supporter-wallets)$/.exec(path);if(!m)return next();const name=m[1];
   const send=(status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify(body));};
   if(req.method==='GET'){const hit=cache.get(name);const now=Date.now();if(hit&&now-hit.at<60000)return send(hit.status,hit.body);
    const body=readCommunityFile(name,dir);const out=body?{status:200,body:{name,generatedAt:body.generatedAt,count:body.entries.length,entries:body.entries,refreshEveryMinutes:30}}:{status:404,body:{error:'not published yet',name}};cache.set(name,{...out,at:now});return send(out.status,out.body);}
   if(req.method!=='POST')return send(405,{error:'Method not allowed'});
   const gateway=trustedGatewayContext(req,{port:server.httpServer?.address()?.port||4175});if(!gateway||!gateway.community)return send(403,{error:'Community authentication required'});
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>COMMUNITY_FILES[name].max)return send(413,{error:'Request too large'});}
   let body;try{body=JSON.parse(raw);}catch{return send(400,{error:'Invalid JSON'});}
   const problem=validateEnvelope(name,body);if(problem)return send(422,{error:problem});
   const previous=readCommunityFile(name,dir);if(previous&&Date.parse(body.generatedAt)<Date.parse(previous.generatedAt))return send(409,{error:'older than the published version',published:previous.generatedAt});
   writeCommunityFile(name,body,dir);cache.delete(name);console.log(JSON.stringify({event:'community-file-published',name,entries:body.entries.length,generatedAt:body.generatedAt}));
   return send(200,{ok:true,name,entries:body.entries.length,generatedAt:body.generatedAt});
  });
 };
 return {name:'kids-community',configureServer:install,configurePreviewServer:install};
}
