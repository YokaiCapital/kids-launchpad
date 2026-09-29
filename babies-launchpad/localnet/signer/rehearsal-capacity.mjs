// Capacity experiments are not live signing-policy changes. Only the dedicated
// owned loopback ledger can opt into this finite profile. Other modes keep the
// legacy limits; campaign capabilities and exact operating holds still apply.
import {DEFAULT_LIMITS} from '../signer-policy.mjs';
export const FLEET_REHEARSAL_GENESIS='JDaL29FzwQ8LjBGpMArZpfVNKP5UBbaatjkehtFg3ebp';
/** `profile` is the profile name, or {profile, hourlyLamports} to widen the rolling-hour ceiling for one isolated run
 * (for example returning a hundred campaigns' reserves at once); the override never leaves the isolated ledger gate. */
export function rehearsalSignerCapacity(profile,{programVersion,rpcUrl,genesisHash}={}){
 if(profile===undefined)return {};
 const name=typeof profile==='object'&&profile!==null?profile.profile:profile,hourly=typeof profile==='object'&&profile!==null?profile.hourlyLamports:undefined;
 if(name!=='isolated-fleet-100'||programVersion!==3||rpcUrl!=='http://127.0.0.1:19499'||genesisHash!==FLEET_REHEARSAL_GENESIS)throw Error('Capacity profile requires the isolated v3 fleet ledger');
 if(hourly!==undefined&&(!Number.isSafeInteger(hourly)||hourly<1000000||hourly>20000000000))throw Error('Rehearsal hourly ceiling must be 0.001 to 20 SOL');
 return {maxPerMinute:600,limits:{...DEFAULT_LIMITS,maxHourlyLamports:hourly??5000000000}};
}
