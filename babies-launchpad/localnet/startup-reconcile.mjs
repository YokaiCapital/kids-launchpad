// Startup reconciliation: every intent journal classifies its signed rows against the chain before the API reopens
// financial writes (docs/ENGINEERING-RULES.md: a restored backup must reconcile with the chain first; an old backup
// must never permit a duplicate payout). Rows whose outcome is still unknown stay hot and keep refusing rebuilds.
export async function reconcileJournals({log=()=>{}}={}){
 const started=Date.now(),services=[];
 const passes=[['escrow',async()=>(await import('./escrow.mjs')).reconcile()],['active-launch',async()=>(await import('./active-launch.mjs')).reconcile()],['postlaunch-claims',async()=>(await import('./postlaunch-claim-intents.mjs')).reconcilePostlaunchClaims()],['postlaunch-trades',async()=>(await import('./postlaunch-trade.mjs')).reconcile()]];
 for(const [name,run] of passes){
  const t=Date.now();
  try{const summary=await run();services.push({...summary,status:'reconciled',ms:Date.now()-t});log({event:'startup-reconcile',service:name,...summary,ms:Date.now()-t});}
  catch(error){services.push({service:name,status:'failed',category:error?.category||'error',message:String(error?.message||error).replace(/api[-_]?key=[^&\s"')]+/gi,'api-key=<redacted>').slice(0,160),ms:Date.now()-t});log({event:'startup-reconcile-failed',service:name,ms:Date.now()-t});}
 }
 const complete=services.every(s=>s.status==='reconciled');
 return {complete,unresolvedSigned:services.reduce((n,s)=>n+(s.unresolvedSigned||0),0),services,ms:Date.now()-started,at:new Date().toISOString()};
}
