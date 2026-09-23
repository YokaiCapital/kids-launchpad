// Feed bootstrap: resolves the launched campaign (registered active record, or the qualified rehearsal on localnet),
// derives the canonical pool identity from launch state, opens the store on the runtime volume and starts the
// ingest worker. Runs only when a launched campaign exists; retries the resolution every minute until then.
// Kill switch: KIDS_MARKET_FEED=0. Websocket wake-up: KIDS_MARKET_WS=1 (URL from KIDS_HELIUS_WS_URL, else derived
// from KIDS_HELIUS_RPC_URL). Nothing here logs an RPC URL.
import {fileURLToPath} from 'node:url';
import {openMarketStore} from './store.mjs';
import {createRpcClient} from './rpc.mjs';
import {createMarketIngest,deriveWsUrl} from './ingest.mjs';
import {createMarketApi} from './api.mjs';
import {WSOL_MINT} from './decode.mjs';
import {setMarketStatus} from '../../shared/service-status.mjs';
export const DEFAULT_STORE_PATH=fileURLToPath(new URL('../.runtime/market.sqlite',import.meta.url));
export const marketFeedEnabled=(env=process.env)=>env.KIDS_MARKET_FEED!=='0';
/** Canonical identity from a resolved campaign (postlaunch-campaign.mjs resolve()) plus the coin's decimals. */
export async function identityFromCampaign(selected,{campaignPoolAddresses,decimalsOf}){
 const {ctx,state,campaign}=selected;
 const p=campaignPoolAddresses(state.mint,state.pool);
 const mint=state.mint.toBase58(),mint0=p.mint0.toBase58(),mint1=p.mint1.toBase58();
 if(mint0!==WSOL_MINT&&mint1!==WSOL_MINT)throw Error('Launch pool is not quoted in SOL');
 const coinDecimals=await decimalsOf(ctx,state.mint);
 if(!Number.isInteger(coinDecimals)||coinDecimals<0||coinDecimals>18)throw Error('Coin decimals unavailable');
 return {genesis:ctx.manifest.genesisHash,campaign:campaign.toBase58(),mint,pool:p.pool.toBase58(),authority:p.authority.toBase58(),vault0:p.vault0.toBase58(),vault1:p.vault1.toBase58(),mint0,mint1,decimals0:mint0===WSOL_MINT?9:coinDecimals,decimals1:mint1===WSOL_MINT?9:coinDecimals,coinDecimals,scope:selected.scope};
}
async function defaultResolve(){
 const [{resolvePostlaunchCampaign},{campaignPoolAddresses}]=await Promise.all([import('../postlaunch-campaign.mjs'),import('../atomic-launch.mjs')]);
 let selected=await resolvePostlaunchCampaign('active');
 if(!selected&&(process.env.KIDS_NETWORK||'localnet')==='localnet')selected=await resolvePostlaunchCampaign('rehearsal');
 if(!selected)return null;
 return identityFromCampaign(selected,{campaignPoolAddresses,decimalsOf:async(ctx,mint)=>(await ctx.connection.getTokenSupply(mint)).value.decimals});
}
export function createMarketFeed({env=process.env,resolve=defaultResolve,storePath=DEFAULT_STORE_PATH,rpcUrl=null,log=line=>console.log(JSON.stringify(line)),retryMs=60000,statusMs=15000,report=setMarketStatus,options={},webSocketFactory=null,now=Date.now}={}){
 const enabled=marketFeedEnabled(env);
 let identity=null,store=null,ingest=null,timer=null,statusTimer=null,stopped=false,lastResolveError=null,starting=null;
 const feed={enabled,identity:()=>identity,store:()=>store,stats:()=>ingest?ingest.stats():null,lastResolveError:()=>lastResolveError};
 /** Compact status for /_health/status and /statusz: no URLs, no keys. */
 function status(){const s=feed.stats();return {enabled,running:!!ingest,campaign:identity?.campaign||null,connected:s?s.connected:null,lagSeconds:s?s.lagSeconds:null,lastTradeAgeSeconds:s?s.lastTradeAgeSeconds:null,openGaps:s?s.openGaps:0,decodeFailures:s?s.decodeFailures:0,unsupported:s?s.unsupportedRecorded:0,rpcErrors:s?s.rpcErrors:0,provisional:s?.store?.provisional??0,backfillComplete:s?s.backfillComplete:false,websocket:s?.ws?.connected??false,lastError:s?.lastError||lastResolveError||null};}
 async function attempt(){
  if(stopped||ingest||starting)return;
  starting=(async()=>{
   try{
    const found=await resolve();if(!found){lastResolveError='no launched campaign yet';return;}
    const url=rpcUrl||(await import('../network.mjs')).networkProfile(env).rpcUrl;
    store=openMarketStore(storePath);
    const rpc=createRpcClient({url});
    identity=found;
    const wsWanted=env.KIDS_MARKET_WS==='1',wsUrl=wsWanted?deriveWsUrl(env):null;
    const factory=webSocketFactory||(wsWanted&&typeof globalThis.WebSocket==='function'?u=>new globalThis.WebSocket(u):null);
    ingest=createMarketIngest({identity,rpc,store,now,log,options,webSocketFactory:factory});
    ingest.start({wsUrl});
    lastResolveError=null;
    log({event:'market-feed-started',campaign:identity.campaign,pool:identity.pool,scope:identity.scope,websocket:!!(wsUrl&&factory),store:storePath.replace(/^.*\/(\.runtime\/)/,'$1')});
   }catch(error){lastResolveError=String(error?.message||error).replace(/api[-_]?key=[^&\s"')]+/gi,'api-key=<redacted>').slice(0,200);log({event:'market-feed-waiting',reason:lastResolveError});}
   finally{starting=null;}
  })();
  return starting;
 }
 return {
  ...feed,
  api:createMarketApi({feed,now}),
  status,
  start(){if(!enabled){log({event:'market-feed-disabled',reason:'KIDS_MARKET_FEED=0'});report(status());return;}if(timer)return;attempt();timer=setInterval(attempt,retryMs);timer.unref?.();statusTimer=setInterval(()=>report(status()),statusMs);statusTimer.unref?.();report(status());},
  async stop(){stopped=true;clearInterval(timer);timer=null;clearInterval(statusTimer);statusTimer=null;if(starting)await starting;if(ingest)await ingest.stop();ingest=null;store?.close();store=null;identity=null;},
  attempt,
 };
}
