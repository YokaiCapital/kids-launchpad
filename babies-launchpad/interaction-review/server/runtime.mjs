// Standalone API runtime: no development server, asset serving, or arbitrary proxy.
import http from 'node:http';
import {statusSnapshot,setSignerStatus,setReconciliation} from '../../shared/service-status.mjs';
const runtimeDir=new URL('../../localnet/.runtime/',import.meta.url).pathname;
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
const json=(res,status,body)=>{if(res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
/** Financial write routes stay closed until the startup reconciliation has completed against the chain. */
/** The admin plugin is local-only: refused on any hosted runtime (Railway or another cloud marker) and by KIDS_ADMIN_PLUGIN=0. */
export function adminPluginAllowed(env=process.env){
 if(env.KIDS_ADMIN_PLUGIN==='0')return false;
 if(env.RAILWAY_ENVIRONMENT||env.RAILWAY_SERVICE_ID||env.RAILWAY_PROJECT_ID||env.KIDS_CLOUD==='1')return false;
 if(env.KIDS_NETWORK&&env.KIDS_NETWORK!=='localnet')return false;
 return true;
}

export const FINANCIAL_WRITE_PATHS=/^\/api\/account\/(prelaunch|prelaunch-legacy|postlaunch\/(claim|trade))(\/|$)/;
export function createApiServer({plugins=[],probe=async()=>true,probeInterval=10000,writesGate=null}={}){
 const middleware=[];let healthy=false,checkedAt=0,probing=false,draining=false;
 const gate=writesGate||{open:true,report:null};
 const server=http.createServer((req,res)=>{
  // Readiness = the ledger answers and the process is not draining. Financial writes are a separate, slower gate
  // (reconciliation, RPC health): they are refused with 503 while closed and reported here as writesOpen.
  if(req.url==='/_health/status'&&req.method==='GET'){const ready=!draining&&healthy&&Date.now()-checkedAt<30000;return json(res,200,statusSnapshot({ready,runtimePath:runtimeDir}));}
  if(req.url==='/_health/ready'&&req.method==='GET'){const ready=!draining&&healthy&&Date.now()-checkedAt<30000;return json(res,ready?200:503,{status:ready?'ready':'unavailable',writesOpen:gate.open===true,reconciliation:gate.report?{complete:!!gate.report.complete,unresolvedSigned:gate.report.unresolvedSigned??null,at:gate.report.at??null}:null});}
  if(draining)return json(res,503,{error:'Service restarting; retry with the same request ID.'});
  if(!req.url?.startsWith('/api/'))return json(res,404,{error:'Not found'});
  if(gate.open!==true&&req.method==='POST'&&FINANCIAL_WRITE_PATHS.test(req.url.split('?')[0]))return json(res,503,{error:'Journals are being reconciled with the chain after start; retry with the same request ID.'});
  let i=0;
  const next=error=>{if(res.writableEnded)return;if(error){console.error('API middleware failed:',error.code||error.name);return json(res,500,{error:'Internal service error'});}const fn=middleware[i++];if(!fn)return json(res,404,{error:'Not found'});try{Promise.resolve(fn(req,res,next)).catch(next);}catch(e){next(e);}};
  next();
 });
 const context={httpServer:server,middlewares:{use(fn){if(typeof fn!=='function')throw Error('Invalid API middleware');middleware.push(fn);}}};
 for(const plugin of plugins){const install=plugin.configurePreviewServer||plugin.configureServer;if(install)install(context);}
 // Financial writes close again when the ledger probe fails repeatedly after start (degraded RPC must not accept new
 // money operations that would then fail downstream or need reconciliation); they reopen after two healthy probes.
 let failedProbes=0,healthyProbes=0;
 const check=async()=>{if(probing||draining)return;probing=true;try{healthy=(await probe())===true;}catch{healthy=false;}finally{checkedAt=Date.now();probing=false;
  if(healthy){healthyProbes+=1;failedProbes=0;if(gate.degraded&&healthyProbes>=2){gate.open=gate.reconciled===true;gate.degraded=false;setReconciliation(gate.report,gate.open);console.log(JSON.stringify({event:'writes-reopened',reason:'ledger probe healthy'}));}}
  else{failedProbes+=1;healthyProbes=0;if(failedProbes>=3&&gate.open){gate.open=false;gate.degraded=true;setReconciliation(gate.report,false);console.log(JSON.stringify({event:'writes-closed',reason:'ledger probe failed '+failedProbes+' times'}));}}}};
 const timer=setInterval(check,probeInterval);timer.unref();server.once('listening',check);server.once('close',()=>clearInterval(timer));
 server.headersTimeout=10000;server.requestTimeout=30000;server.keepAliveTimeout=5000;server.maxHeadersCount=40;
 return {server,check,async shutdown(){draining=true;clearInterval(timer);await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();const timeout=setTimeout(()=>server.closeAllConnections(),25000);timeout.unref();server.once('close',()=>clearTimeout(timeout));});}};
}
export async function ledgerProbe(){
 if((process.env.KIDS_NETWORK||'localnet')!=='localnet'){
  // Real network: ready when the RPC answers with the expected genesis. A campaign is optional (none before launch day).
  const {networkProfile}=await import('../../localnet/network.mjs');const profile=networkProfile();
  const reply=await fetch(profile.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getGenesisHash'}),signal:AbortSignal.timeout(6000)});
  if(!reply.ok)return false;const body=await reply.json();return body.result===profile.genesisHash;
 }
 for(const [name,port] of [['active-launch.json',19099],['config.json',18999]]){
  const config=JSON.parse(await readFile(new URL('../../localnet/.runtime/'+name,import.meta.url),'utf8'));
  if(config.network&&config.network!=='localnet')return false;
  if(name==='active-launch.json'&&config.ready!==true)return false;
  const reply=await fetch('http://127.0.0.1:'+port,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getGenesisHash'}),signal:AbortSignal.timeout(2000)});
  if(!reply.ok||(await reply.json()).result!==config.genesisHash)return false;
  if(name==='active-launch.json'){const r=await fetch('http://127.0.0.1:'+port,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'getMultipleAccounts',params:[[config.programId,config.address],{encoding:'base64',commitment:'confirmed'}]}),signal:AbortSignal.timeout(2000)});const accounts=(await r.json()).result?.value;if(!accounts?.[0]?.executable||accounts?.[1]?.owner!==config.programId)return false;}
 }
 return true;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [{accountPlugin},{demoPersistencePlugin},{parentLookupPlugin},{communityPlugin}]=await Promise.all([import('./account-plugin.mjs'),import('./demo-plugin.mjs'),import('./parent-lookup.mjs'),import('./community-plugin.mjs')]);
 const writesGate={open:false,report:null};
 // Admin routes (launch control, rehearsals, settings) exist only on the owner's own machine: a cloud runtime never
 // installs the plugin, whatever the network (security audit, 23 September 2026: "cloud runtime still installs adminPlugin").
 const plugins=[accountPlugin(),parentLookupPlugin(),demoPersistencePlugin(),communityPlugin()];
 if(adminPluginAllowed(process.env)){const {adminPlugin}=await import('./admin-plugin.mjs');plugins.unshift(adminPlugin());}
 else console.log(JSON.stringify({event:'admin-plugin-omitted',reason:'cloud runtime or KIDS_ADMIN_PLUGIN=0'}));
 const runtime=createApiServer({plugins,probe:ledgerProbe,writesGate});
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>runtime.shutdown().then(()=>process.exit(0)));
 runtime.server.listen(4175,'127.0.0.1',()=>console.log('KIDS API listening on loopback:4175 (financial writes closed until journals reconcile with the chain)'));
 // Signer reachability for the status page (every 60 s) when a remote signer is configured.
 if(process.env.KIDS_SIGNER_URL){setSignerStatus({configured:true,publicKey:process.env.KIDS_SIGNER_PUBKEY||null});const probeSigner=async()=>{try{const r=await fetch(process.env.KIDS_SIGNER_URL.replace(/\/$/,'')+'/healthz',{signal:AbortSignal.timeout(4000)});const body=r.ok?await r.json():null;setSignerStatus({ok:r.ok&&body?.publicKey===process.env.KIDS_SIGNER_PUBKEY,checkedAt:Date.now()});}catch{setSignerStatus({ok:false,checkedAt:Date.now()});}};probeSigner();const signerTimer=setInterval(probeSigner,60000);signerTimer.unref();}
 // Reconcile every intent journal with the chain before financial writes reopen; retry until the ledger answers.
 const {reconcileJournals}=await import('../../localnet/startup-reconcile.mjs');
 (async()=>{for(let attempt=1;;attempt+=1){const report=await reconcileJournals({log:line=>console.log(JSON.stringify(line))});writesGate.report=report;setReconciliation(report,report.complete);if(report.complete){writesGate.reconciled=true;writesGate.open=true;console.log(JSON.stringify({event:'startup-reconcile-complete',unresolvedSigned:report.unresolvedSigned,ms:report.ms}));return;}console.error(JSON.stringify({event:'startup-reconcile-retry',attempt,failed:report.services.filter(s=>s.status!=='reconciled').map(s=>s.service)}));await new Promise(r=>setTimeout(r,Math.min(60000,15000*attempt)));}})();
}
