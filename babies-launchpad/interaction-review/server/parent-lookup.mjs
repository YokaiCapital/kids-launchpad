import {readLocalConfig} from './local-config.mjs';
import {isMintAddress,parseMint} from '../src/mint.js';
export async function fetchMint(mint,{fetchImpl=fetch,rpcUrl='https://api.mainnet-beta.solana.com'}={}) {
  if(!isMintAddress(mint))throw Error('Paste a valid Solana mint address (32-byte base58).');
  const response=await fetchImpl(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',params:[mint,{encoding:'jsonParsed',commitment:'finalized'}]}),signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error(response.status===429?'Solana RPC is rate limited. Your draft is kept; retry shortly.':'Solana RPC is unavailable. Your draft is kept; retry shortly.');
  const payload=await response.json();
  if(payload.error)throw Error('Solana RPC could not complete the lookup. Retry shortly.');
  return parseMint(mint,payload.result);
}
export function parentLookupPlugin() {
  const install=server=>{server.middlewares.use(async(req,res,next)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname!=='/api/parents')return next();
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    if(req.method!=='GET'){res.statusCode=405;res.end(JSON.stringify({error:'Read-only endpoint.'}));return;}
    try{res.end(JSON.stringify(await fetchMint(url.searchParams.get('mint'),{rpcUrl:readLocalConfig()?.rpcUrl||'http://127.0.0.1:18999'})));}
    catch(error){res.statusCode=error.name==='TimeoutError'?504:400;res.end(JSON.stringify({error:error.name==='TimeoutError'?'Lookup timed out. Your parents are kept; retry shortly.':error.message}));}
  });};
  return {name:'read-only-parent-lookup',configureServer:install,configurePreviewServer:install};
}
