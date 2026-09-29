// Dedicated media admission, separate from financial work and image quotas.
import {randomUUID,createHash} from 'node:crypto';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {VIDEO_POLICY_VERSION,VIDEO_MAX_OUTPUT_BYTES,VIDEO_POSTER_MAX_BYTES,VIDEO_MAX_SECONDS,validateVideoInput} from './video-policy.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),key=/^[A-Za-z0-9_.:-]{1,128}$/,LEASE_MS=180000;
const fail=(message,code='MEDIA_CONFLICT')=>Object.assign(Error(message),{code});
export function createVideoService({registry,config,storage,sanitize,limits,log=()=>{}}){
 if(registry?.driver!=='postgres'||!creationMode(config?.mode)||config.programVersion!==3||!config.pilotCreator||!storage?.read||!storage?.put||!storage?.verifyPrivacy||typeof sanitize!=='function'||!/^[a-f0-9]{64}$/.test(storage.storageId??''))throw Error('Private video needs an isolated v3 media service');
 const ownerAllowed=config.pilotCreator,caps=structuredClone(limits);
 for(const k of ['ownerAttempts','globalAttempts','ownerBytes','globalBytes','ownerActive','globalActive'])if(!Number.isSafeInteger(caps?.[k])||caps[k]<1)throw Error('Explicit video quotas required');
 if(caps.ownerActive>caps.globalActive||caps.globalActive>8)throw Error('Invalid video concurrency');
 const fixed={storageId:storage.storageId,version:VIDEO_POLICY_VERSION},policy=canonicalJson({caps,...fixed}),q=(s,p=[])=>registry.query(s,p);
 const owned=async(owner,assetId)=>{if(owner!==ownerAllowed||!key.test(assetId??''))throw fail('Video unavailable');return (await q('SELECT * FROM creation_videos WHERE owner=? AND asset_id=?',[owner,assetId])).rows[0];};
 const describe=r=>({assetId:r.asset_id,kind:'video',status:r.state,sha256:r.sha256??null,posterHash:r.poster_hash??null,size:r.byte_count==null?null:Number(r.byte_count),width:r.state==='ready'?1280:null,height:r.state==='ready'?720:null,durationMs:r.duration_ms??null,contentType:r.state==='ready'?'video/mp4':null});
 async function assertPolicy(){
  await q('INSERT INTO creation_video_policy(singleton,body) VALUES(1,?) ON CONFLICT(singleton) DO NOTHING',[policy]);
  const stored=(await q('SELECT body FROM creation_video_policy WHERE singleton=1')).rows[0].body;if(stored===policy)return;
  // Same rule as artwork: storage identity and policy version stay pinned; quotas and concurrency ship with the code.
  let previous=null;try{previous=JSON.parse(stored);}catch{previous=null;}
  if(!previous||previous.storageId!==fixed.storageId||previous.version!==fixed.version)throw fail('Video policy differs across services','MEDIA_POLICY_CONFLICT');
  await q('UPDATE creation_video_policy SET body=? WHERE singleton=1 AND body=?',[policy,stored]);
  log({event:'video-policy-caps-updated',previous:previous.caps,caps});
 }
 let checked=0,checking=null;
 async function privacy(){if(Date.now()-checked<30000)return;if(!checking)checking=storage.verifyPrivacy().then(ok=>{if(ok!==true)throw fail('Private storage not verified');checked=Date.now();}).finally(()=>checking=null);await checking;}
 return {
  async upload(owner,{requestId,contentType,bytes}){
   if(owner!==ownerAllowed||!key.test(requestId??''))throw fail('Video unavailable');validateVideoInput(bytes,contentType);bytes=Buffer.from(bytes);const sourceHash=hash(bytes);await privacy();
   const admission=await registry.transaction(async()=>{
    await assertPolicy();const previous=(await q('SELECT * FROM creation_videos WHERE owner=? AND request_key=?',[owner,requestId])).rows[0];
    if(previous&&(previous.source_hash!==sourceHash||previous.source_type!==contentType||previous.policy_version!==VIDEO_POLICY_VERSION))throw fail('Video request changed');
    const time=(await q("SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms,TO_CHAR(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day")).rows[0],now=Number(time.ms);
    if(previous&&(previous.state==='ready'||previous.state==='failed'||Number(previous.lease_until)>now))return {perform:false,row:previous};
    if(previous&&previous.attempts>=3){await q("UPDATE creation_videos SET state='failed',lease_token=NULL,lease_until=0,updated_at=? WHERE asset_id=?",[now,previous.asset_id]);return {perform:false,row:{...previous,state:'failed'}};}
    const active=(await q("SELECT owner,COUNT(*) AS n FROM creation_videos WHERE state='processing' AND lease_until>? GROUP BY owner",[now])).rows;
    if(active.reduce((sum,r)=>sum+Number(r.n),0)>=caps.globalActive||Number(active.find(r=>r.owner===owner)?.n??0)>=caps.ownerActive)throw fail('Video processing is busy','MEDIA_BUSY');
    const chargedBytes=bytes.length+VIDEO_MAX_OUTPUT_BYTES+VIDEO_POSTER_MAX_BYTES;
    for(const [scope,attempts,maxBytes] of [['global',caps.globalAttempts,caps.globalBytes],['owner:'+owner,caps.ownerAttempts,caps.ownerBytes]]){
     const used=(await q('SELECT * FROM creation_video_usage WHERE day=? AND scope=?',[time.day,scope])).rows[0];
     if(Number(used?.attempts??0)+1>attempts||Number(used?.bytes??0)+chargedBytes>maxBytes)throw fail('Video daily allowance reached','MEDIA_QUOTA');
     await q('INSERT INTO creation_video_usage(day,scope,attempts,bytes) VALUES(?,?,1,?) ON CONFLICT(day,scope) DO UPDATE SET attempts=creation_video_usage.attempts+1,bytes=creation_video_usage.bytes+excluded.bytes',[time.day,scope,chargedBytes]);
    }
    const assetId=previous?.asset_id??randomUUID(),token=randomUUID();
    if(previous)await q("UPDATE creation_videos SET state='processing',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE asset_id=?",[token,now+LEASE_MS,now,assetId]);
    else await q("INSERT INTO creation_videos(asset_id,owner,request_key,source_hash,source_bytes,source_type,policy_version,state,attempts,lease_token,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'processing',1,?,?,?,?)",[assetId,owner,requestId,sourceHash,bytes.length,contentType,VIDEO_POLICY_VERSION,token,now+LEASE_MS,now,now]);
    return {perform:true,assetId,token};
   },{lockKey:'creation-video-admission'});
   if(!admission.perform)return describe(admission.row);
   const {assetId,token}=admission;
   try{
    const video=await sanitize({bytes,contentType}),poster=video?.poster;
    if(video?.sanitized!==true||video.policyVersion!==VIDEO_POLICY_VERSION||video.contentType!=='video/mp4'||!Buffer.isBuffer(video.bytes)||video.bytes.length<24||video.bytes.length>VIDEO_MAX_OUTPUT_BYTES||video.bytes.subarray(4,8).toString('ascii')!=='ftyp'||hash(video.bytes)!==video.sha256||video.width!==1280||video.height!==720||!Number.isInteger(video.durationMs)||video.durationMs<1||video.durationMs>VIDEO_MAX_SECONDS*1000)throw fail('Video sanitizer result invalid');
    if(!poster||!Buffer.isBuffer(poster.bytes)||poster.bytes.length<24||poster.bytes.length>VIDEO_POSTER_MAX_BYTES||poster.contentType!=='image/png'||!poster.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||poster.bytes.readUInt32BE(16)!==640||poster.bytes.readUInt32BE(20)!==360||poster.width!==640||poster.height!==360||hash(poster.bytes)!==poster.sha256)throw fail('Video poster result invalid');
    const objectKey='creator-video/'+canonicalHash({owner,assetId,sha256:video.sha256,policy:VIDEO_POLICY_VERSION})+'.mp4',posterKey='creator-video/'+canonicalHash({owner,assetId,sha256:poster.sha256,policy:VIDEO_POLICY_VERSION})+'.png';
    const saved=await storage.put(objectKey,video),savedPoster=await storage.put(posterKey,{...poster,policyVersion:VIDEO_POLICY_VERSION});
    if(saved?.sha256!==video.sha256||saved.byteCount!==video.bytes.length||savedPoster?.sha256!==poster.sha256||savedPoster.byteCount!==poster.bytes.length)throw fail('Private video receipt differs');
    await q("UPDATE creation_videos SET state='ready',object_key=?,sha256=?,byte_count=?,duration_ms=?,poster_key=?,poster_hash=?,poster_bytes=?,lease_token=NULL,lease_until=0,updated_at=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) WHERE asset_id=? AND state='processing' AND lease_token=? AND lease_until>CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)",[objectKey,video.sha256,video.bytes.length,video.durationMs,posterKey,poster.sha256,poster.bytes.length,assetId,token]);
   }catch(e){await q("UPDATE creation_videos SET state='pending',lease_token=NULL,lease_until=0,updated_at=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) WHERE asset_id=? AND state='processing' AND lease_token=?",[assetId,token]);throw fail(e?.code==='MEDIA_BUSY'?'Video processing is busy':'Video processing did not complete. Retry the same upload.',e?.code==='MEDIA_BUSY'?'MEDIA_BUSY':'MEDIA_PENDING');}
   return describe(await owned(owner,assetId));
  },
  async status(owner,assetId){await assertPolicy();const row=await owned(owner,assetId);return row?describe(row):null;},
  async loadOwnedVideo({owner,assetId}){
   const row=await owned(owner,assetId);if(!row||row.state!=='ready')throw fail('Video unavailable');await assertPolicy();await privacy();
   const video=await storage.read(row.object_key),poster=await storage.read(row.poster_key);
   const valid=(value,digest,size,type)=>value&&value.policyVersion===VIDEO_POLICY_VERSION&&value.contentType===type&&value.bytes?.length===Number(size)&&value.sha256===digest&&hash(value.bytes)===digest;
   if(!valid(video,row.sha256,row.byte_count,'video/mp4')||!valid(poster,row.poster_hash,row.poster_bytes,'image/png'))throw fail('Video integrity check failed');
   return {...video,poster:{...poster,width:640,height:360},width:1280,height:720,durationMs:row.duration_ms,sanitized:true,owner,assetId,kind:'video'};
  },
 };
}
