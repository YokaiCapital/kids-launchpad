import {createCreationCoordinator} from '../../localnet/creation/coordinator.mjs';
import {createCreationActivation} from '../../localnet/creation/activation.mjs';
// Hosted composition of the version-3 creator flow for the wallet-restricted pilot (owner order, 27 September 2026).
// Same services as the local rehearsal (interaction-review/server/local-creator-services.mjs), composed from a verified
// release: provider RPC, the shared PostgreSQL registry, the mint inventory and media store on this service's own volume,
// Pinata for publication, the release manifest's signer as the operating payer. Every money route stays behind the pilot
// wallet restriction (KIDS_PUBLIC_PILOT_WALLET). No key material lives here.
import {readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Connection,PublicKey} from '@solana/web3.js';
import {createLocalCreatorServices} from '../../localnet/creation/services.mjs';
import {createArtworkService} from '../../localnet/creation/artwork.mjs';
import {createVideoService} from '../../localnet/creation/video.mjs';
import {createMetadataPublisher} from '../../localnet/creation/publication.mjs';
import {createPinataProvider} from '../../localnet/creation/pinata.mjs';
import {createImageSanitizer} from '../../localnet/creation/image-sanitizer.mjs';
import {createVideoSanitizer} from '../../localnet/creation/video-sanitizer.mjs';
import {createCreatorProfileReader} from '../../localnet/creation/creator-profile.mjs';
import {STANDARD_MINT_SUPPLY} from '../../localnet/creation/mint-packet.mjs';
import {assertCreationScope} from '../../localnet/creation/scope.mjs';
import {setExtra} from '../../shared/service-status.mjs';
import {fundingFirstBuild,FUNDING_FIRST_BUILDS} from '../../localnet/hosted/funding-first-builds.mjs';
import {createFundingFirstCustody} from '../../localnet/mints/funding-first-custody.mjs';
import {createCustodyService} from '../../localnet/mints/custody-service.mjs';
// Builds of the version-3 program that carry tag 40 (compact creation). A verified release naming another build keeps
// the four-approval path, so a push before the owner's upgrade never offers a transaction the program would refuse.
// The funding-first build (tags 41-47) also carries the compact creation (tag 40): it is a one-transaction build as well.
export const ONE_TRANSACTION_BUILDS=Object.freeze(['ec8f995140f3e2f2c49af14aa4a60518192f1c1eb9c969599205ef4ccc1a68c8',...FUNDING_FIRST_BUILDS]);
import {canonicalHash} from '../../localnet/registry/canonical.mjs';
import {presetsHash,validatePresets,presetTerms} from '../../localnet/registry/presets.mjs';
import {readCreationCosts} from '../../localnet/creation/live-costs.mjs';
/** The estimate the review step adds up before any packet exists: the operating reserve (returned if the launch fails)
 * and the setup costs the creator pays (pool creation fee, account rents, network fees, with the margin), quoted from the
 * chain. The exact setup quote is read again at creation (public-creation.mjs) and reviewed before signing. */
export function manifestCostQuote({costs,manifest,validForSeconds=600,now=Date.now}){
 const c=costs?.costs;if(!c||typeof c.totalLamports!=='string'||!/^\d+$/.test(c.totalLamports))throw Error('Creation cost quote needs the itemized setup costs');
 const items=[],reserve=manifest?.agreed?.operating?.reserveLamports;
 if(typeof reserve==='string'&&/^[1-9]\d*$/.test(reserve))items.push({key:'operating-reserve',label:'Operating reserve for the keeper\'s network fees',kind:'refundable',lamports:reserve,note:'Returned to you if the launch fails; after a launch it keeps paying the coin\'s operations'});
 items.push({key:'setup',label:'Setup: pool creation fee, account rents, network fees',kind:'consumed',lamports:c.totalLamports,note:'Quoted from the chain now; the exact amount is reviewed again before you sign'});
 return {validForSeconds,items,quotedAt:new Date(now()).toISOString(),slot:costs.evidence?.slot??null};
}
import {loadReleaseManifest} from '../../localnet/hosted/release-manifest.mjs';
import {createPublicCampaignStore} from '../../localnet/market/public-campaign-store.mjs';
import {createPublicPositionStore} from '../../localnet/market/public-position-store.mjs';
import {createPublicMarketStore} from '../../localnet/market/public-store.mjs';
import {createPublicActivityStore} from '../../localnet/market/public-activity-store.mjs';
import {createPublicActivityReader} from '../../localnet/market/public-activity-reader.mjs';
import {createPublicMarketReader} from '../../localnet/market/public-reader.mjs';
import {createPublicWalletService} from '../../localnet/protocol-v2/public-wallet.mjs';
import {createPublicTradeService} from '../../localnet/protocol-v3/public-trade.mjs';
import {createAdmissionGuard,admittedConnection} from '../../localnet/jobs/admission.mjs';
import {boundedRpcFetch} from '../../localnet/rpc-transport.mjs';
import {readCampaignView} from '../../localnet/registry/read-adapters.mjs';
import {createCreatorOperationsReader} from './creator-operations.mjs';
import {createPublicCreationReview} from './public-creation.mjs';
import {createPublicLaunchAccount} from './public-launch-account.mjs';
import {createPublicLaunchAccess,verifiedPilotOwner} from './public-launch-access.mjs';
import {createPublicPortfolioReader} from './public-portfolio.mjs';
import {campaignsPlugin} from './campaigns-plugin.mjs';
import {publicPresetManifest} from './public-campaign-contract.mjs';
import {createFileObjectStore} from './media-store.mjs';
const SETUP_PLAN=new URL('../../deployment/hosted/setup-plan-standard-v3.json',import.meta.url);
const LIMITS=Object.freeze({
 // A creator uploads the logo and the banner together, so two artwork jobs per wallet run at once (28 September 2026:
 // one at a time refused the second upload with a generic error).
 // Daily allowances are a cost bound, not a product rule: a creator crops and re-crops freely (28 September 2026: ten
 // attempts a day ran out on retries the site itself had caused). Images are cheap (client-cropped PNG, 2 MB at most).
 artwork:{ownerAttempts:200,globalAttempts:2000,ownerBytes:400000000,globalBytes:4000000000,ownerActive:2,globalActive:4},
 publication:{ownerPins:60,globalPins:600,ownerBytes:400000000,globalBytes:4000000000},
 video:{ownerAttempts:20,globalAttempts:200,ownerBytes:2000000000,globalBytes:20000000000,ownerActive:1,globalActive:2},
 trade:{resource:'wallet-trade',policy:{ratePerSecond:5,burst:10,lanes:{'wallet-trade':{ratePerSecond:5,burst:10}}}},
});
/** The vanity mint inventory on this service's volume with a bounded refill loop that keeps a few `kids` addresses ready. */
export async function openHostedMintInventory({dir,encryptionKeyHex,target=3,processes=1,refill=true,log=()=>{},sleepMs=30000,publish=()=>{}}){
 if(!/^[a-f0-9]{64}$/.test(encryptionKeyHex??''))throw Error('KIDS_MINT_ENCRYPTION_KEY must be 64 lowercase hexadecimal characters');
 if(!Number.isInteger(target)||target<1||target>50||!Number.isInteger(processes)||processes<1||processes>4)throw Error('Mint reserve target 1..50 and processes 1..4');
 mkdirSync(dir,{recursive:true,mode:0o700});
 const [{SqliteVanityMintInventory},{SqliteLaunchExecutionStore},{runParallelMintRefill}]=await Promise.all([import('../../kids-mint-worker/vendor/packages/launcher-sdk/src/mint-inventory.js'),import('../../kids-mint-worker/vendor/packages/launcher-sdk/src/sqlite-execution-store.js'),import('../../kids-mint-worker/vendor/mint-refill-parallel.js')]);
 const records=new SqliteLaunchExecutionStore(join(dir,'executions.sqlite')),encryptionKey=Buffer.from(encryptionKeyHex,'hex');
 const inventory=new SqliteVanityMintInventory({databasePath:join(dir,'inventory.sqlite'),executionStore:records,keyId:'kids-hosted-v1',encryptionKey,fallbackToOrdinaryMint:false});
 encryptionKey.fill(0);
 let stopped=false,current=null,loop=null,last='';
 const sleep=ms=>new Promise(r=>{const t=setTimeout(r,ms);t.unref?.();});
 // The reserve is visible without a server login: counts go to the log when they change and to the status page.
 const report=()=>{const counts={...inventory.counts(),target};const key=JSON.stringify(counts);if(key!==last){last=key;log({event:'hosted-mint-reserve-count',...counts});}publish(counts);return counts;};
 report();
 if(refill)loop=(async()=>{while(!stopped){
  report();
  if(inventory.counts().available<target){
   current=new AbortController();const poll=setInterval(()=>{if(stopped||inventory.counts().available>=target)current.abort();},500);poll.unref?.();
   try{await runParallelMintRefill({inventory,signal:current.signal,processes,webParent:false,report:r=>log({event:'hosted-mint-reserve',...r})});}
   catch(error){log({event:'hosted-mint-reserve-paused',reason:String(error?.message??error).slice(0,120)});}
   finally{clearInterval(poll);current=null;report();}
  }
  if(!stopped)await sleep(sleepMs);
 }})();
 return {inventory,counts:()=>inventory.counts(),async close(){stopped=true;current?.abort();await loop?.catch(()=>{});inventory.close();records.close();}};
}
export function hostedCreatorScope({env,release,manifest,setupPlan}){
 const pilot=env.KIDS_PUBLIC_PILOT_WALLET;
 if(!pilot||new PublicKey(pilot).toBase58()!==pilot)throw Error('KIDS_PUBLIC_PILOT_WALLET (the wallet restriction) is required for the hosted creator flow');
 if(!env.KIDS_RPC_URL)throw Error('KIDS_RPC_URL is required for the hosted creator flow');
 if(validatePresets(manifest).length)throw Error('Invalid creator preset manifest');
 const operating=manifest.agreed?.operating;if(typeof operating?.reserveLamports!=='string')throw Error('The presets manifest must seal the operating reserve');
 // One creation transaction (owner rule, 28 September 2026): the hosted flow seals mint, custody, campaign, budget and
 // reserve into one wallet approval; the priority fee cap comes from the setup plan.
 // Funding-first rounds (KIDS_FUNDING_FIRST=1, new rounds only) need the program build that carries tags 41-47 and the
 // one-transaction path; asking for them on another build is refused at composition, never silently ignored.
 const fundingFirst=env.KIDS_FUNDING_FIRST==='1';
 if(fundingFirst&&!fundingFirstBuild(release))throw Error('KIDS_FUNDING_FIRST needs a release whose program build carries the funding-first accounting');
 if(fundingFirst&&!ONE_TRANSACTION_BUILDS.includes(release.binarySha256))throw Error('KIDS_FUNDING_FIRST needs the one-transaction creation build');
 return assertCreationScope({mode:'hosted',fundingFirst,oneTransaction:ONE_TRANSACTION_BUILDS.includes(release.binarySha256),priorityFeeLamports:String(setupPlan.priorityFeeLamports??'10000'),network:release.network,programVersion:3,rpcUrl:env.KIDS_RPC_URL,genesisHash:release.genesisHash,programId:release.programId,pilotCreator:pilot,treasury:release.treasury,operatingPayer:release.signerPublicKey,operatingReserveLamports:operating.reserveLamports,release,discoveryIndex:true,profilePublication:true,policyHash:presetsHash(manifest),planHash:canonicalHash(setupPlan)});
}
/** Composes the hosted creator flow. `release` is the verified manifest (loadReleaseManifest); injection points exist for tests. */
export async function composeHostedCreatorHttp({registry,env=process.env,release=null,manifest,connection=null,inventory=null,provider=null,storage=null,sanitize=null,readCosts=readCreationCosts,costQuoteIntervalMs=300000,runCoordinator=true,canRun=()=>true,log=line=>console.log(JSON.stringify(line))}){
 if(registry?.driver!=='postgres')throw Error('Hosted creator flow needs the shared PostgreSQL registry');
 release=release??loadReleaseManifest(env.KIDS_RELEASE_MANIFEST);
 if(release.network==='localnet')throw Error('Hosted creator flow refuses a localnet release');
 manifest=structuredClone(manifest);const setupPlan=JSON.parse(readFileSync(SETUP_PLAN,'utf8'));
 const scope=hostedCreatorScope({env,release,manifest,setupPlan});
 connection=connection??new Connection(scope.rpcUrl,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:boundedRpcFetch({timeoutMs:12000})});
 if(connection.rpcEndpoint!==scope.rpcUrl)throw Error('Creator RPC connection differs from the configured endpoint');
 const access=createPublicLaunchAccess({KIDS_PUBLIC_PILOT_WALLET:scope.pilotCreator});
 const mints=inventory?{inventory,close:async()=>{}}:await openHostedMintInventory({dir:env.KIDS_MINT_DATA_DIR||'/data/kids-mints',encryptionKeyHex:env.KIDS_MINT_ENCRYPTION_KEY,target:Number(env.KIDS_MINT_RESERVE_TARGET||3),processes:Number(env.KIDS_MINT_PROCESSES||1),log,publish:counts=>setExtra({mintReserve:counts})});
 try{
  storage=storage??createFileObjectStore({dir:env.KIDS_MEDIA_DIR||'/data/media'});
  sanitize=sanitize??createImageSanitizer();
  const artwork=createArtworkService({registry,config:scope,storage,sanitize,limits:LIMITS.artwork,log});
  const video=env.KIDS_FFMPEG&&env.KIDS_FFPROBE?createVideoService({registry,config:scope,storage,sanitize:createVideoSanitizer({ffmpeg:env.KIDS_FFMPEG,ffprobe:env.KIDS_FFPROBE}),limits:LIMITS.video,log}):null;
  provider=provider??createPinataProvider({jwt:env.KIDS_PINATA_JWT});
  const publisher=createMetadataPublisher({registry,config:scope,loadOwnedImage:artwork.loadOwnedImage,loadOwnedVideo:video?.loadOwnedVideo,provider,limits:LIMITS.publication,log});
  const services=createLocalCreatorServices({registry,connection,config:scope,inventory:mints.inventory,publisher});
  // The private custody endpoint (funding-first launches): the keeper's worker co-signs through it; the inventory never
  // leaves this service. Required whenever funding-first rounds are admitted; token and port from the environment only.
  let custody=null;
  if(env.KIDS_CUSTODY_TOKEN!==undefined||scope.fundingFirst){
   if(typeof env.KIDS_CUSTODY_TOKEN!=='string'||env.KIDS_CUSTODY_TOKEN.length<32||!/^[0-9]{1,5}$/.test(String(env.KIDS_CUSTODY_PORT??'')))throw Error('KIDS_CUSTODY_TOKEN (32+ characters) and KIDS_CUSTODY_PORT are required for the custody endpoint');
   if(!services.custodyCapable)throw Error('The custody endpoint needs the custody-capable mint inventory');
   const adapter=createFundingFirstCustody({inventory:mints.inventory,registry,connection,genesisHash:scope.genesisHash,programId:scope.programId});
   const service=createCustodyService({custody:adapter,token:env.KIDS_CUSTODY_TOKEN,log});
   const address=await service.listen(Number(env.KIDS_CUSTODY_PORT),env.KIDS_CUSTODY_HOST||'::');
   custody={address,close:()=>service.close()};log({event:'custody-endpoint-listening',port:address.port});
  }
  const creation=createPublicCreationReview({registry,connection,config:scope,manifest,setupPlan,artwork,video,preparation:services.preparation});
  const identity={genesisHash:scope.genesisHash,programId:scope.programId};
  const portfolioReader=createPublicPortfolioReader({store:createPublicPositionStore(registry),...identity});
  const activityReader=createPublicActivityReader({store:createPublicActivityStore(registry),...identity});
  const marketReader=createPublicMarketReader({store:createPublicMarketStore(registry),...identity});
  const admitTrade=createAdmissionGuard({registry,...LIMITS.trade,lane:'wallet-trade'});
  const walletService=createPublicWalletService({registry,connection:admittedConnection(connection,admitTrade),genesisHash:scope.genesisHash,programIds:[scope.programId],programVersion:3,enabled:true});
  const trades=createPublicTradeService({registry,connection,...identity,walletService,enabled:true,admit:admitTrade});
  const creatorOperationsReader=createCreatorOperationsReader({registry,...identity});
  const coordinator=createCreationCoordinator({registry,flow:services.flow,owner:scope.pilotCreator,canRun,activate:createCreationActivation({registry,connection,release,owner:scope.pilotCreator}),supplement:s=>services.registrar.completeProfile(scope.pilotCreator,s.requestId),log});
  const account=createPublicLaunchAccount({registry,access,artwork,video,creatorOperationsReader,creation,publication:publisher,creatorFlow:runCoordinator?coordinator.flow:services.flow,provisioning:services.provisionWallet,marketReader,activityReader,portfolioReader,trades,actions:walletService,readPositions:walletService.positions});
  // Cost quote on the served manifest, refreshed from the chain; without it the review step cannot add up and refuses
  // to continue. A failed read leaves it absent and retries sooner. The pilot preset is the one on offer here.
  const quote={value:null,timer:null};
  const quotePreset=(manifest.capPresets||[]).find(p=>p.pilotOnly)||(manifest.capPresets||[]).find(p=>!p.advanced)||(manifest.capPresets||[])[0];
  const refreshQuote=async()=>{
   try{
    const selection=presetTerms(manifest,{mode:'standard',capPresetId:quotePreset.id,pilot:true});
    const costs=await readCosts({connection,genesisHash:scope.genesisHash,owner:scope.pilotCreator,ammConfig:selection.terms.feePolicy.ammConfig,counts:setupPlan.counts,priorityFeeLamports:setupPlan.priorityFeeLamports,marginBps:setupPlan.marginBps});
    quote.value=manifestCostQuote({costs,manifest});log({event:'creation-cost-quote',setupLamports:costs.costs.totalLamports,slot:costs.evidence?.slot??null});
   }catch(error){quote.value=null;log({event:'creation-cost-quote-unavailable',category:error?.code||'read'});}
   quote.timer=setTimeout(refreshQuote,quote.value?costQuoteIntervalMs:Math.min(costQuoteIntervalMs,30000));quote.timer.unref?.();
  };
  await refreshQuote();
  if(runCoordinator){await coordinator.start();publisher.start();}
  const servedManifest=()=>({...publicPresetManifest(manifest,{capabilities:{create:true,commit:true,claim:true,creatorOperationsRead:true,artwork:true,videoPublication:!!video,prepareArtwork:true,videoMaxInputBytes:4*1024*1024,marketRead:true,activityRead:true,portfolioRead:true,trade:true},treasury:scope.treasury,supply:{totalBaseUnits:STANDARD_MINT_SUPPLY,decimals:6},pilot:true}),costQuote:quote.value});
  const campaignViews=createPublicCampaignStore(registry),profiles=createCreatorProfileReader(registry);
  const directory=campaignsPlugin({registry,readView:row=>campaignViews.read(row),readProfile:row=>profiles.read(row),manifest:servedManifest,authorize:req=>access.allows(req[verifiedPilotOwner])});
  log({event:'hosted-creator-flow-composed',network:release.network,programId:scope.programId,oneTransaction:scope.oneTransaction,programBuild:release.binarySha256,operatingPayer:scope.operatingPayer,pilotWallet:scope.pilotCreator,video:!!video});
  return {account,creation,artwork,video,services,directory,config:scope,manifest:servedManifest,readView:row=>readCampaignView(row,{readers:{v2:{connection},v3:{connection}}}),mints,coordinator,custody,close:async()=>{clearTimeout(quote.timer);await coordinator.close();await publisher.close();await custody?.close();return mints.close();}};
 }catch(error){await mints.close().catch(()=>{});throw error;}
}
