// Installed only with an explicitly configured registry. Production money routes remain off by default.
import {createPublicLaunchAccount} from './public-launch-account.mjs';
import {publicPresetManifest} from './public-campaign-contract.mjs';
import {readCampaignView} from '../../localnet/registry/read-adapters.mjs';
import {createPublicLaunchAccess} from './public-launch-access.mjs';
import {readPresets} from '../../localnet/registry/presets.mjs';
export async function publicServices({registryImport,env=process.env,release=null,canRun=()=>true,log=line=>console.log(JSON.stringify(line))}={}){
 if(!registryImport?.configured)return {account:null,manifest:null};
 // Hosted creator flow for the wallet-restricted pilot (owner order, 27 September 2026): only with a verified release.
 if(env.KIDS_CREATOR_FLOW==='hosted'){
  if(release?.configured!==true)throw Error('KIDS_CREATOR_FLOW=hosted needs the verified release (KIDS_RELEASE_MANIFEST)');
  if(!registryImport.registry)throw Error('KIDS_CREATOR_FLOW=hosted needs the shared registry to be open');
  const {composeHostedCreatorHttp}=await import('./hosted-creator-services.mjs');
  const hosted=await composeHostedCreatorHttp({registry:registryImport.registry,env,manifest:readPresets(),canRun,log});
  return {readView:hosted.readView,account:hosted.account,manifest:hosted.manifest,directory:hosted.directory,close:hosted.close};
 }
 const access=createPublicLaunchAccess(env);
 let actions=null,connection=null;
 // Mainnet enablement is deliberately not implied by a UI flag. v2 creation/Family/launch infrastructure still
 // requires its own rehearsal and release review. These wallet routes are currently localnet-only.
 if(env.KIDS_PUBLIC_WALLET_ACTIONS==='1'&&(env.KIDS_NETWORK||'localnet')==='localnet'&&env.KIDS_PUBLIC_PROGRAM_ID&&env.KIDS_PUBLIC_GENESIS_HASH){
  const [{Connection},{networkProfile},{boundedRpcFetch},{createPublicWalletService}]=await Promise.all([import('@solana/web3.js'),import('../../localnet/network.mjs'),import('../../localnet/rpc-transport.mjs'),import('../../localnet/protocol-v2/public-wallet.mjs')]);
  const profile=networkProfile(env);
  const rpcUrl=env.KIDS_PUBLIC_RPC_URL||profile.rpcUrl;
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpcUrl))throw Error('Public localnet RPC must use loopback');
  connection=new Connection(rpcUrl,{commitment:'confirmed',fetch:boundedRpcFetch()});
  actions=createPublicWalletService({registry:()=>registryImport.registry,connection,genesisHash:env.KIDS_PUBLIC_GENESIS_HASH,programIds:[env.KIDS_PUBLIC_PROGRAM_ID],programVersion:Number(env.KIDS_PUBLIC_PROGRAM_VERSION||2),enabled:true});
 }
 return {readView:row=>readCampaignView(row,{readers:{v2:{connection},v3:{connection}}}),account:createPublicLaunchAccount({registry:()=>registryImport.registry,actions,readPositions:actions?.positions,access}),manifest:()=>publicPresetManifest(readPresets(),{capabilities:{commit:!!actions,claim:!!actions}})};
}
