// One rule for where the version-3 creator services may run: the isolated localnet rehearsal (loopback RPC) or a hosted
// release that was verified before composition (provider RPC, never loopback, never credentials in the URL). Every
// creation module checks its scope through this file, so a new mode is a deliberate change here, not a local edit.
import {endpointUrl} from '../jobs/service.mjs';
export const CREATION_MODES=Object.freeze(['localnet-rehearsal','hosted']);
const LOOPBACK=['localhost','127.0.0.1','[::1]','::1'];
/** True for a mode the creator services accept. */
export const creationMode=mode=>CREATION_MODES.includes(mode);
/** True when a parsed RPC URL fits the mode: loopback http(s) without credentials for the rehearsal, a provider endpoint
 * (https, or http on a private-network hostname) without credentials for a hosted release. */
export function creationRpc(u,mode){
 if(!u||!['http:','https:'].includes(u.protocol)||u.username||u.password)return false;
 if(mode==='hosted'){try{endpointUrl(u.href,{mode:'hosted',role:'RPC'});return true;}catch{return false;}}
 return mode==='localnet-rehearsal'&&LOOPBACK.includes(u.hostname);
}
/** A hosted scope must carry the verified release it was composed from; the rehearsal must not pretend to. */
export function assertCreationScope(config){
 if(!creationMode(config?.mode)||config.programVersion!==3)throw Error('Creator services run only in the localnet rehearsal or a verified hosted release, version 3');
 if(config.mode==='hosted'&&(!config.release||config.release.genesisHash!==config.genesisHash||config.release.programId!==config.programId))throw Error('Hosted creator services need the verified release manifest of their scope');
 if(config.mode!=='hosted'&&config.release)throw Error('A rehearsal scope carries no release manifest');
 return config;
}
