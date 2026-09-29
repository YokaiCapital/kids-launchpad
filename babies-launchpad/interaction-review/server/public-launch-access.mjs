import {PublicKey} from '@solana/web3.js';

// Only server-verified sessions may populate this symbol. HTTP headers, bodies and URLs cannot set it.
export const verifiedPilotOwner=Symbol('verified-public-launch-pilot-owner');
export const PRIVATE_CAMPAIGNS_PREFIX='/api/account/launches/campaigns';
export function createPublicLaunchAccess(env=process.env){
 const wallet=env.KIDS_PUBLIC_PILOT_WALLET;
 if(wallet!==undefined&&wallet!==''){
  let valid=false;try{valid=new PublicKey(wallet).toBase58()===wallet;}catch{}
  if(!valid)throw Error('KIDS_PUBLIC_PILOT_WALLET must be a canonical Solana public address');
 }
 // Missing configuration is closed, including builds with the frontend feature flag enabled.
 return Object.freeze({allows:owner=>typeof owner==='string'&&!!wallet&&owner===wallet});
}
export function pilotDirectoryPath(path){
 return path===PRIVATE_CAMPAIGNS_PREFIX||path.startsWith(PRIVATE_CAMPAIGNS_PREFIX+'/');
}
