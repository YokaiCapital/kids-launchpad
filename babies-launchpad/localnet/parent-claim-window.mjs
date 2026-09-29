// Parent claim window and burn record of program build 6 (deployment/decisions/BUILD-6-2026-09-24.md), shared by the
// keeper and the API. Everything is keyed on the live program's feature list, never on a date or an env setting:
// a build without 'parent-claim-expiry' has no window (expiry null, window flags null) and its parent rewards never expire.
export const PARENT_CLAIM_WINDOW_SECONDS=0;// build 6 closes parent claims at the launch time (owner, 24 Sep 2026); programs/atomic-launch/src/lib.rs PARENT_CLAIM_WINDOW
/** KIDSPAR1 offsets written by tag 11: burned for parent A, burned for parent B, unix time of the first run. */
export const PARENTS_BURNED_OFFSET=224,PARENTS_BURNED_AT_OFFSET=240;
/** The window's closing time (unix seconds) from the campaign's recorded launch time, or null when the live build has no window. */
export function parentClaimExpiryUnix(launchedAt,features=[]){
 if(!Array.isArray(features)||!features.includes('parent-claim-expiry'))return null;
 if(!Number.isSafeInteger(launchedAt)||launchedAt<=0)return null;
 return launchedAt+PARENT_CLAIM_WINDOW_SECONDS;
}
/** Window facts at `now` (unix seconds): {expiresAtUnix, windowOpen, expired}; the flags are null without a window. */
export function parentClaimWindow(launchedAt,features,now){
 const expiresAtUnix=parentClaimExpiryUnix(launchedAt,features);
 if(expiresAtUnix===null)return {expiresAtUnix:null,windowOpen:null,expired:null};
 if(!Number.isFinite(now))throw Error('Clock unavailable');
 return {expiresAtUnix,windowOpen:now<expiresAtUnix,expired:now>=expiresAtUnix};
}
/** Tag 11's record in the parents account (256 bytes): burned raw units per parent and when it first ran (null until then). */
export function parentsBurnRecord(data){
 if(!Buffer.isBuffer(data)||data.length!==256)throw Error('Invalid parents account');
 const at=data.readBigUInt64LE(PARENTS_BURNED_AT_OFFSET);
 return {burnedRaw:[data.readBigUInt64LE(PARENTS_BURNED_OFFSET),data.readBigUInt64LE(PARENTS_BURNED_OFFSET+8)],burnedAtUnix:at===0n?null:Number(at)};
}
/** Plain sentence for a refused claim after the window. */
export function parentWindowClosedMessage(expiresAtUnix){return 'The parent claim window closed on '+new Date(expiresAtUnix*1000).toISOString().slice(0,16).replace('T',' ')+' UTC. Unclaimed parent rewards are burned.';}
