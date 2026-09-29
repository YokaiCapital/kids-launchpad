import {createCreationCoordinator} from '../../localnet/creation/coordinator.mjs';
import {createCreationActivation} from '../../localnet/creation/activation.mjs';
import {createCreatorOperationsReader} from './creator-operations.mjs';
import {createVideoService} from '../../localnet/creation/video.mjs';
import {createCreatorProfileReader} from '../../localnet/creation/creator-profile.mjs';
import {createPublicCampaignStore} from '../../localnet/market/public-campaign-store.mjs';
import {createPublicPositionStore} from '../../localnet/market/public-position-store.mjs';
import {createPublicPortfolioReader} from './public-portfolio.mjs';
// Explicit dependency composition for the isolated creator HTTP rehearsal.
// Not imported by production startup; no environment flag enables money routes.
import {createLocalCreatorServices} from '../../localnet/creation/services.mjs';
import {createArtworkService} from '../../localnet/creation/artwork.mjs';
import {createMetadataPublisher} from '../../localnet/creation/publication.mjs';
import {canonicalHash} from '../../localnet/registry/canonical.mjs';
import {presetsHash,validatePresets} from '../../localnet/registry/presets.mjs';
import {createPublicCreationReview} from './public-creation.mjs';
import {createPublicLaunchAccount} from './public-launch-account.mjs';
import {createPublicLaunchAccess,verifiedPilotOwner} from './public-launch-access.mjs';
import {campaignsPlugin} from './campaigns-plugin.mjs';
import {STANDARD_MINT_SUPPLY} from '../../localnet/creation/mint-packet.mjs';
import {publicPresetManifest} from './public-campaign-contract.mjs';
import {createPublicWalletService} from '../../localnet/protocol-v2/public-wallet.mjs';
import {createPublicTradeService} from '../../localnet/protocol-v3/public-trade.mjs';
import {createAdmissionGuard,admittedConnection} from '../../localnet/jobs/admission.mjs';
import {Connection} from '@solana/web3.js';
import {boundedRpcFetch} from '../../localnet/rpc-transport.mjs';
import {createPublicMarketStore} from '../../localnet/market/public-store.mjs';
import {createPublicActivityStore} from '../../localnet/market/public-activity-store.mjs';
import {createPublicActivityReader} from '../../localnet/market/public-activity-reader.mjs';
import {createPublicMarketReader} from '../../localnet/market/public-reader.mjs';
export function composeLocalCreatorHttp({registry,connection,config,manifest,setupPlan,inventory,storage,sanitize,provider,artworkLimits,publicationLimits,tradeAdmission=null,sanitizeVideo=null,videoLimits=null,coordinated=false}){
 if(config?.mode!=='localnet-rehearsal'||config.programVersion!==3||registry?.driver!=='postgres')throw Error('Isolated v3 shared creator rehearsal required');
 const url=new URL(config.rpcUrl);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||connection.rpcEndpoint!==config.rpcUrl)throw Error('Exact loopback creator RPC required');
 if(validatePresets(manifest).length)throw Error('Invalid creator preset manifest');
 manifest=structuredClone(manifest);setupPlan=structuredClone(setupPlan);
 const scope={...structuredClone(config),discoveryIndex:true,profilePublication:true,policyHash:presetsHash(manifest),planHash:canonicalHash(setupPlan),operatingPayer:config.operatingPayer??config.treasury??null,operatingReserveLamports:manifest.agreed?.operating?.reserveLamports??null};
 const access=createPublicLaunchAccess({KIDS_PUBLIC_PILOT_WALLET:scope.pilotCreator});
 const artwork=createArtworkService({registry,config:scope,storage,sanitize,limits:artworkLimits});
 const video=sanitizeVideo?createVideoService({registry,config:scope,storage,sanitize:sanitizeVideo,limits:videoLimits}):null;
 const publisher=createMetadataPublisher({registry,config:scope,loadOwnedImage:artwork.loadOwnedImage,loadOwnedVideo:video?.loadOwnedVideo,provider,limits:publicationLimits});
 const services=createLocalCreatorServices({registry,connection,config:scope,inventory,publisher});
 const creation=createPublicCreationReview({registry,connection,config:scope,manifest,setupPlan,artwork,video,preparation:services.preparation});
 const portfolioReader=createPublicPortfolioReader({store:createPublicPositionStore(registry),genesisHash:scope.genesisHash,programId:scope.programId});
 const activityReader=createPublicActivityReader({store:createPublicActivityStore(registry),genesisHash:scope.genesisHash,programId:scope.programId});
 const marketReader=createPublicMarketReader({store:createPublicMarketStore(registry),genesisHash:scope.genesisHash,programId:scope.programId});
 const admitTrade=tradeAdmission?createAdmissionGuard({registry,...tradeAdmission,lane:'wallet-trade'}):null;
 // Abort the actual HTTP request on timeout. SDK retries cannot bypass the
 // shared admission lane; a timed-out send remains a durable unknown packet.
 const tradeConnection=admitTrade?new Connection(scope.rpcUrl,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:boundedRpcFetch({timeoutMs:8000})}):connection;
 const walletService=createPublicWalletService({registry,connection:admitTrade?admittedConnection(tradeConnection,admitTrade):connection,genesisHash:scope.genesisHash,programIds:[scope.programId],programVersion:3,enabled:false});
 const trades=tradeAdmission?createPublicTradeService({registry,connection:tradeConnection,genesisHash:scope.genesisHash,programId:scope.programId,walletService,enabled:true,admit:admitTrade}):null;
 const creatorOperationsReader=createCreatorOperationsReader({registry,genesisHash:scope.genesisHash,programId:scope.programId});
 const coordinator=coordinated?createCreationCoordinator({registry,flow:services.flow,owner:scope.pilotCreator,activate:createCreationActivation({registry,connection,release:{...scope,network:'localnet',signerPublicKey:scope.treasury},owner:scope.pilotCreator}),supplement:s=>services.registrar.completeProfile(scope.pilotCreator,s.requestId)}):null;
 const account=createPublicLaunchAccount({registry,access,artwork,video,creatorOperationsReader,creation,publication:publisher,creatorFlow:coordinator?.flow||services.flow,provisioning:services.provisionWallet,marketReader,activityReader,portfolioReader,trades,readPositions:trades?walletService.positions:null});
 const servedManifest=()=>publicPresetManifest(manifest,{capabilities:{creatorOperationsRead:true,artwork:true,videoPublication:!!video,marketRead:true,activityRead:true,portfolioRead:true,trade:!!trades},treasury:scope.treasury,supply:{totalBaseUnits:STANDARD_MINT_SUPPLY,decimals:6},pilot:true});
 const campaignViews=createPublicCampaignStore(registry),profiles=createCreatorProfileReader(registry);
 const directory=campaignsPlugin({registry,readView:row=>campaignViews.read(row),readProfile:row=>profiles.read(row),manifest:servedManifest,authorize:req=>access.allows(req[verifiedPilotOwner])});
 return {account,creation,artwork,video,services,directory,config:scope,manifest:servedManifest,publisher,coordinator,async start(){if(coordinator)await coordinator.start();publisher.start();},async close(){await coordinator?.close();await publisher.close();}};
}
