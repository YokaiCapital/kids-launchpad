import {VIDEO_MAX_INPUT_BYTES} from '../../localnet/creation/video-policy.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
export function createVideoPlaybackAdmission({maxActive=2,timeoutMs=30000}={}){
 if(!Number.isInteger(maxActive)||maxActive<1||maxActive>4||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('Bounded playback admission required');let active=0;
 return res=>{
  if(active>=maxActive)throw fail(503,'Video playback is busy. Retry shortly.');active++;
  let loaded=false,ended=false,released=false;
  const release=()=>{if(!released&&loaded&&ended){released=true;active--;clearTimeout(timer);res.off('finish',end);res.off('close',end);}};
  const end=()=>{ended=true;release();};
  const timer=setTimeout(()=>res.destroy(),timeoutMs);res.once('finish',end);res.once('close',end);
  // A disconnected client must not free the slot while storage is still loading.
  return ()=>{loaded=true;ended||=res.writableFinished||res.destroyed;release();};
 };
}
// Reserve before buffering, retain until the service finishes. Hosted replicas
// also need edge body/connection limits and a dedicated media process budget.
export function createVideoUploadReader({maxActive=1,timeoutMs=30000}={}){
 if(!Number.isInteger(maxActive)||maxActive<1||maxActive>2||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('Bounded video upload admission required');let active=0;
 return async function read(req){
  if(active>=maxActive)throw fail(503,'Video upload is busy. Retry shortly.');
  const contentType=req.headers['content-type'],requestId=req.headers['x-kids-upload-id'],length=req.headers['content-length'];
  if(!['video/mp4','video/webm'].includes(contentType)||typeof requestId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId))throw fail(400,'Choose an MP4 or WebM and a valid upload');
  if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>VIDEO_MAX_INPUT_BYTES))throw fail(413,'Choose a video under 100 MiB');
  active++;let released=false;const release=()=>{if(!released){released=true;active--;}};
  try{return await new Promise((resolve,reject)=>{
   const chunks=[];let size=0,finished=false;
   const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',broken);req.off('aborted',broken);if(error){req.resume();reject(error);}else resolve({input:{requestId,contentType,bytes:Buffer.concat(chunks)},release});};
   const data=chunk=>{size+=chunk.length;if(size>VIDEO_MAX_INPUT_BYTES)finish(fail(413,'Choose a video under 100 MiB'));else chunks.push(Buffer.from(chunk));};
   const end=()=>finish(length!==undefined&&Number(length)!==size?fail(400,'Video upload was incomplete'):null),broken=()=>finish(fail(400,'Video upload was interrupted'));
   const timer=setTimeout(()=>finish(fail(408,'Video upload timed out')),timeoutMs);req.on('data',data);req.once('end',end);req.once('error',broken);req.once('aborted',broken);
  });}catch(e){release();throw e;}
 };
}
export function sendPrivateVideo(res,result,range){
 if(result.status!==200||!Buffer.isBuffer(result.binary)||result.contentType!=='video/mp4')return false;
 const bytes=result.binary,headers={'Content-Type':'video/mp4','Cache-Control':'private, no-store','Vary':'Cookie','Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
 let start=0,end=bytes.length-1;
 if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(match&&(match[1]||match[2])){if(match[1]){start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;}else start=Math.max(0,bytes.length-Number(match[2]));}else start=Infinity;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=bytes.length){res.writeHead(416,{...headers,'Content-Range':'bytes */'+bytes.length,'Content-Length':0});res.end();return true;}
  headers['Content-Range']=`bytes ${start}-${end}/${bytes.length}`;
 }
 res.writeHead(range?206:200,{...headers,'Content-Length':end-start+1});res.end(bytes.subarray(start,end+1));return true;
}
