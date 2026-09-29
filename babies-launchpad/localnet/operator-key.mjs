// The operator keypair by network: localnet uses the generated admin fixture; devnet and mainnet read
// KIDS_OPERATOR_KEY_FILE (hosted: written from the service secret at boot) or ~/.config/kids/<network>/operator-keypair.json.
import {existsSync,readFileSync} from 'node:fs';import {homedir} from 'node:os';import {join} from 'node:path';import {Keypair} from '@solana/web3.js';
import {networkProfile} from './network.mjs';
export function operatorKeyPath(env=process.env){const profile=networkProfile(env);if(env.KIDS_OPERATOR_KEY_FILE)return env.KIDS_OPERATOR_KEY_FILE;if(profile.network==='localnet')return null;return join(homedir(),'.config/kids',profile.network,'operator-keypair.json');}
export async function operatorKeypair(env=process.env){
 const path=operatorKeyPath(env);
 if(path===null){const {localKey}=await import('./dev-vesting.mjs');return localKey('admin');}
 if(!existsSync(path))throw Error('Operator key file missing: '+path);
 return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path,'utf8'))));
}
