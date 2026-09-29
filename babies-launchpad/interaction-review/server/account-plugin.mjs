const postlaunchClaimIntentsURL=new URL('../../localnet/postlaunch-claim-intents.mjs',import.meta.url).href;
import {verifiedPilotOwner,pilotDirectoryPath} from './public-launch-access.mjs';
import {readArtworkUpload,sendPrivateArtwork} from './artwork-http.mjs';
import {createVideoUploadReader,createVideoPlaybackAdmission,sendPrivateVideo} from './video-http.mjs';
import {createActiveLifecycleKeeper} from '../../localnet/active-keeper.mjs';
const activeFeeURL=new URL('../../localnet/active-fee-keeper.mjs',import.meta.url).href;
const launchOperatorURL=new URL('../../localnet/launch-active.mjs',import.meta.url).href;
import {createEscrowKeepers} from './escrow-keepers.mjs';
import {runKeeper} from '../../shared/service-status.mjs';
import {trustedGatewayContext,gatewayFinancialDenied} from '../../shared/trusted-gateway.mjs';
const activeLaunchURL=new URL('../../localnet/active-launch.mjs',import.meta.url).href;
const activeLaunch=()=>import(/* @vite-ignore */ activeLaunchURL);
const postlaunchTradeURL=new URL('../../localnet/postlaunch-trade.mjs',import.meta.url).href;
const postlaunchStateURL=new URL('../../localnet/postlaunch-state.mjs',import.meta.url).href;
const postlaunchClaimsURL=new URL('../../localnet/postlaunch-claims.mjs',import.meta.url).href;
const escrowURL=new URL('../../localnet/escrow.mjs',import.meta.url).href;
const escrow=()=>import(/* @vite-ignore */ escrowURL);
const vestingURL=new URL('../../localnet/dev-vesting.mjs',import.meta.url).href;
const vesting=()=>import(/* @vite-ignore */ vestingURL);
import {readLocalConfig} from './local-config.mjs';
import {canonical} from '../../protocol/core.mjs';
import {governance,publicRounds} from './local-governance.mjs';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {AccountStore} from './account-store.mjs';
import {PostgresAccountStore} from './postgres-account-store.mjs';
import {createReplicaCsrf} from '../../shared/replica-csrf.mjs';
import {guardLocalRequest,newCsrfToken} from '../../shared/local-http.mjs';
import {signWithSeed,rpc} from '../../shared/solana.mjs';
import {parseMint} from '../src/mint.js';
import {createMarketFeed} from '../../localnet/market/feed.mjs';
import {createActivityFeed} from '../../localnet/market/activity.mjs';import {setActivityStatus} from '../../shared/service-status.mjs';
const runtime=fileURLToPath(new URL('../../localnet/.runtime/',import.meta.url));
export function accountPlugin({publicLaunchService=null,accountFilename=runtime+'/accounts.sqlite',accountRegistry=null,sharedAccounts=false,csrfSecret=process.env.KIDS_CSRF_SECRET,backgroundServices=true}={}){
 if(typeof backgroundServices!=='boolean')throw Error('Explicit account background-service mode required');
 const sharedCsrf=sharedAccounts?createReplicaCsrf({secret:csrfSecret}):null;
 const readVideoUpload=createVideoUploadReader(),admitVideoPlayback=createVideoPlaybackAdmission();
 const install=server=>{
  mkdirSync(runtime,{recursive:true,mode:0o700});const stores=new Map(),localCsrf=newCsrfToken();
  const activeTick=createActiveLifecycleKeeper({read:async()=>(await activeLaunch()).readActive(),settle:async()=>(await activeLaunch()).settleActive(),launch:async()=>(await import(/* @vite-ignore */ launchOperatorURL)).launchActive()});
  let feeTick;
  const tickKeepers=createEscrowKeepers({legacy:()=>runKeeper('legacy',async()=>{await (await escrow()).runRefundKeeper();}),active:()=>runKeeper('active',activeTick),fees:()=>runKeeper('fees',async()=>{feeTick??=(await import(/* @vite-ignore */ activeFeeURL)).createActiveFeeKeeper();return feeTick();})},(name,error)=>console.error('Local '+name+' escrow keeper:',error.message));
  // An explicitly composed registry API does not run the legacy single-coin
  // keepers or feeds. Dedicated worker roles own those jobs. Default preserved.
  const keeper=backgroundServices?setInterval(tickKeepers,15000):null;keeper?.unref();
  const market=backgroundServices?createMarketFeed():null,activity=backgroundServices?createActivityFeed():null;
  market?.start();activity?.start();const activityHealth=backgroundServices?setInterval(()=>{try{setActivityStatus(activity.status());}catch{}},15000):null;activityHealth?.unref();
  if(activity)server.middlewares.use(activity.api.middleware);if(market)server.middlewares.use(market.api.middleware);
  server.httpServer?.once('close',()=>{clearInterval(keeper);clearInterval(activityHealth);market?.stop();activity?.stop();for(const store of stores.values())store.close();});
  server.middlewares.use(async(req,res,next)=>{
   const path=req.url?.split('?')[0];if(!path?.startsWith('/api/account/'))return next();
   const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
   const denied=guardLocalRequest(req,{port:server.httpServer.address()?.port||4175,subject:'KIDS local account service',allowGateway:true});if(denied)return send(denied.status,denied.body);
   try{
    const gateway=trustedGatewayContext(req,{port:server.httpServer.address()?.port||4175});
    const origin=gateway?.origin||'http://'+req.headers.host;
    const csrf=sharedCsrf?sharedCsrf.issue(origin):localCsrf;
    if(!stores.has(origin)){
     const registry=typeof accountRegistry==='function'?accountRegistry():accountRegistry;
     if(sharedAccounts&&registry?.driver!=='postgres')return send(503,{error:'Wallet sign-in is temporarily unavailable'});
     stores.set(origin,sharedAccounts?new PostgresAccountStore({registry,origin}):new AccountStore({filename:accountFilename,origin}));
    }const store=stores.get(origin);
    const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('kids_session='))?.slice(13),session=await store.session(token);
    if(req.method==='GET'&&pilotDirectoryPath(path)){
     if(!session)return send(401,{error:'Sign in with a wallet first'});
     if(!publicLaunchService?.canAccess(session.owner))return send(403,{error:'Launch pilot unavailable for this wallet'});
     req[verifiedPilotOwner]=session.owner;return next();
    }
    if(req.method==='GET'&&['/api/account/postlaunch','/api/account/postlaunch-preview'].includes(path)){
     const stateModule=await import(/* @vite-ignore */ postlaunchStateURL),view=await stateModule.postlaunchState(path.endsWith('-preview')?'rehearsal':'active');
     let wallet=null;if(view.configured&&session?.owner&&!path.endsWith('-preview')){try{const {activeContext}=await activeLaunch();wallet=await stateModule.walletBalances((await activeContext()).connection,session.owner,view.mint);}catch(error){wallet={owner:session.owner,error:'Balances unavailable right now'};}}
     return send(200,{...view,wallet,claims:view.configured?await (await import(/* @vite-ignore */ postlaunchClaimsURL)).postlaunchClaims(session?.owner,view.campaign):null});
    }
    if(req.method==='GET'&&path==='/api/account/prelaunch')return send(200,await (await activeLaunch()).readActive(session?.owner));
    if(req.method==='GET'&&path==='/api/account/prelaunch-legacy')return send(200,await (await escrow()).prelaunchState(session?.owner));
    if(req.method==='GET'&&path==='/api/account/dev-vesting')return send(200,await (await vesting()).devVestingState());
    if(req.method==='GET'&&path==='/api/account/rounds')return send(200,publicRounds());
    if(req.method==='GET'&&path==='/api/account/state')return send(200,{owner:session?.owner||null,publicLaunches:{allowed:publicLaunchService?.canAccess(session?.owner)===true},account:session?await store.state(session.owner):null,csrf,localIdentities:(!gateway||gateway.operator)&&existsSync(runtime+'/config.json')?readLocalConfig().wallets:{}});
    if(req.method==='GET'&&path.startsWith('/api/account/launches/')&&publicLaunchService){let completed;try{if(path.startsWith('/api/account/launches/video/'))completed=admitVideoPlayback(res);const result=await publicLaunchService.handle({method:req.method,path,owner:session?.owner});if(sendPrivateArtwork(res,result)||sendPrivateVideo(res,result,req.headers.range))return;return send(result.status,result.body);}catch(e){if(e.status)return send(e.status,{error:e.message});throw e;}finally{completed?.();}}
    if(req.method!=='POST')return send(405,{error:'Method not allowed'});
    if(sharedCsrf?!sharedCsrf.verify(req.headers['x-kids-csrf'],origin):req.headers['x-kids-csrf']!==csrf)return send(403,{error:'Refresh sign-in before trying again'});
    if(path==='/api/account/launches/video/upload'){
     if(!session)return send(401,{error:'Sign in with a wallet first'});
     if(!publicLaunchService?.canUploadVideo?.(session.owner))return send(403,{error:'Video uploads are not available for this wallet'});
     let upload;try{upload=await readVideoUpload(req);const result=await publicLaunchService.handle({method:req.method,path,owner:session.owner,input:upload.input});return send(result.status,result.body);}catch(e){return send(e.status||400,{error:e.status?e.message:'Video upload could not finish'});}finally{upload?.release();}
    }
    if(path==='/api/account/launches/artwork/upload'){
     if(!session)return send(401,{error:'Sign in with a wallet first'});
     if(!publicLaunchService?.canAccess(session.owner))return send(403,{error:'Launch pilot unavailable for this wallet'});
     let input;try{input=await readArtworkUpload(req);}catch(e){return send(e.status||400,{error:e.message});}
     const result=await publicLaunchService.handle({method:req.method,path,owner:session.owner,input});return send(result.status,result.body);
    }
    if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
    let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2000000)return send(413,{error:'Request too large'});}const input=JSON.parse(body),original=structuredClone(input);
    if(path==='/api/account/challenge')return send(200,await store.challenge(input.owner));
    if(path==='/api/account/verify'||path==='/api/account/local'){
     let proof=input;
     if(path==='/api/account/local'){
      if(gateway&&!gateway.operator)return send(403,{error:'Operator authentication required for local test identities'});
      if(!['alice','bob'].includes(input.identity))throw Error('Choose an existing local test identity');
      const config=readLocalConfig();
      if(await rpc(config.rpcUrl,'getGenesisHash')!==config.genesisHash)throw Error('Localnet ledger changed');
      const challenge=await store.challenge(config.wallets[input.identity]),bytes=Buffer.from(JSON.parse(readFileSync(runtime+'/'+input.identity+'.json','utf8')));
      try{proof={id:challenge.id,signature:signWithSeed(bytes.subarray(0,32),Buffer.from(challenge.message)).toString('base64')};}finally{bytes.fill(0);}
     }
     const verified=await store.verify(proof);res.setHeader('Set-Cookie',`kids_session=${verified.token}; HttpOnly; SameSite=Strict; Path=/api/account; Max-Age=86400${gateway?'; Secure':''}`);
     return send(200,{owner:verified.owner,publicLaunches:{allowed:publicLaunchService?.canAccess(verified.owner)===true},account:await store.state(verified.owner)});
    }
    if(path==='/api/account/logout'){await store.logout(token);res.setHeader('Set-Cookie','kids_session=; HttpOnly; SameSite=Strict; Path=/api/account; Max-Age=0'+(gateway?'; Secure':''));return send(200,{owner:null,publicLaunches:{allowed:false}});}
    if(!session)return send(401,{error:'Sign in with a wallet first'});
    if(gateway&&!gateway.operator&&gatewayFinancialDenied(gateway,path,session.owner,readLocalConfig()?.wallets))return send(403,{error:'Operator authentication required for local test wallet transactions'});
    if(path.startsWith('/api/account/launches/')&&publicLaunchService){const result=await publicLaunchService.handle({method:req.method,path,owner:session.owner,input});return send(result.status,result.body);}
    // Without the background services (the pilot API) the existing coin's money routes are not installed at all.
    if(!backgroundServices&&/^\/api\/account\/(?:postlaunch|prelaunch|prelaunch-legacy|dev-vesting)\//.test(path))return send(404,{error:'Not found'});
    if(path==='/api/account/postlaunch/trade/quote')return send(200,await (await import(/* @vite-ignore */ postlaunchTradeURL)).quotePostlaunchTrade(session.owner,input));
    if(path==='/api/account/postlaunch/trade/prepare')return send(200,await (await import(/* @vite-ignore */ postlaunchTradeURL)).preparePostlaunchTrade(session.owner,input));
    if(path==='/api/account/postlaunch/trade/submit')return send(200,await (await import(/* @vite-ignore */ postlaunchTradeURL)).submitPostlaunchTrade(session.owner,input));
    if(path==='/api/account/postlaunch/trade/execute')return send(200,await (await import(/* @vite-ignore */ postlaunchTradeURL)).executePostlaunchTrade(session.owner,input));
    if(path==='/api/account/postlaunch/claim/prepare')return send(200,await (await import(/* @vite-ignore */ postlaunchClaimIntentsURL)).preparePostlaunchClaim(session.owner,input));
    if(path==='/api/account/postlaunch/claim/submit')return send(200,await (await import(/* @vite-ignore */ postlaunchClaimIntentsURL)).submitPostlaunchClaim(session.owner,input));
    if(path==='/api/account/postlaunch/claim')return send(200,await (await import(/* @vite-ignore */ postlaunchClaimsURL)).claimPostlaunch(session.owner,input));
    if(path==='/api/account/prelaunch/prepare')return send(200,await (await activeLaunch()).prepareActive(session.owner,input));
    if(path==='/api/account/prelaunch-legacy/prepare'){if(input.action!=='refund')return send(409,{error:'Earlier escrow accepts refunds only'});return send(200,await (await escrow()).preparePrelaunch(session.owner,input));}
    if(path==='/api/account/prelaunch/submit')return send(200,await (await activeLaunch()).submitActive(session.owner,input));
    if(path==='/api/account/prelaunch-legacy/submit')return send(200,await (await escrow()).submitPrelaunch(session.owner,input));
    if(path==='/api/account/dev-vesting/claim')return send(200,await (await vesting()).claimDevVesting(session.owner));
    if(path.startsWith('/api/account/vote/')||(path==='/api/account/action'&&input.action==='submit'))return send(410,{error:'Voting and submissions have been removed. Public launches are coming soon.'});
    if(path==='/api/account/vote/challenge'){const protocol=governance();const config=readLocalConfig();if(!config||await rpc(config.rpcUrl,'getGenesisHash')!==config.genesisHash)throw Error('Localnet ledger changed');protocol.localnetGenesis=config.genesisHash;protocol.domain=origin;return send(200,protocol.challenge({owner:session.owner,action:'vote',payload:input}));}
    if(path==='/api/account/vote/accept'){const protocol=governance();protocol.domain=origin;const challenge=protocol.read().challenges.find(c=>c.id===input.id);if(challenge?.message.owner!==session.owner)throw Error('Vote belongs to another wallet');let signature=input.signature;if(input.local===true){const config=readLocalConfig();const name=Object.keys(config.wallets).find(k=>config.wallets[k]===session.owner);if(!['alice','bob'].includes(name))throw Error('Not a local test wallet');const bytes=Buffer.from(JSON.parse(readFileSync(runtime+'/'+name+'.json','utf8')));try{signature=signWithSeed(bytes.subarray(0,32),Buffer.from(canonical(challenge.message))).toString('base64');}finally{bytes.fill(0);}}return send(200,protocol.accept({id:input.id,signature}));}
    if(path==='/api/account/action'){
     if(input.action==='submit'){
      const config=readLocalConfig();if(await rpc(config.rpcUrl,'getGenesisHash')!==config.genesisHash)throw Error('Localnet ledger changed');
      const draft=input.payload?.draft;if(!draft)throw Error('Draft required');
      for(const key of ['a','b']){
       draft[key]=config.mints[draft[key]?.toUpperCase()]||draft[key];
       const info=parseMint(draft[key],await rpc(config.rpcUrl,'getAccountInfo',[draft[key],{encoding:'jsonParsed',commitment:'finalized'}]));draft.parentData={...draft.parentData,[key]:info};
      }
     }
     return send(200,await store.apply(session.owner,original,input.payload));
    }
    return send(404,{error:'Not found'});
   }catch(e){if(sharedAccounts&&/^(?:[0-9A-Z]{5}|ECONNRESET|ECONNREFUSED|ETIMEDOUT)$/.test(e?.code||''))return send(503,{error:'Wallet service temporarily unavailable; retry shortly'});return send(400,{error:e.message});}
  });
 };
 return {name:'kids-wallet-accounts',configureServer:install,configurePreviewServer:install};
}
