// Binary upload avoids base64 expansion. Call ONLY after wallet, pilot and CSRF
// validation. A hosted edge must enforce its own connection/body rate limits too.
import {MAX_INPUT_BYTES} from '../../localnet/creation/image-policy.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
export async function readArtworkUpload(req,{timeoutMs=10000}={}){
 const contentType=req.headers['content-type'],requestId=req.headers['x-kids-upload-id'],kind=req.headers['x-kids-artwork-kind'];
 if(!['image/png','image/jpeg'].includes(contentType)||!['pfp','banner'].includes(kind)||typeof requestId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId))throw fail(400,'Choose a PNG or JPEG and a valid artwork upload');
 const length=req.headers['content-length'];
 if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>MAX_INPUT_BYTES))throw fail(413,'Choose artwork under 5 MiB');
 return new Promise((resolve,reject)=>{
  const chunks=[];let size=0;
  const finish=(error)=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',broken);req.off('aborted',broken);if(error){req.resume();reject(error);}else resolve({requestId,kind,contentType,bytes:Buffer.concat(chunks)});};
  const data=chunk=>{size+=chunk.length;if(size>MAX_INPUT_BYTES)finish(fail(413,'Choose artwork under 5 MiB'));else chunks.push(Buffer.from(chunk));};
  const end=()=>finish(length!==undefined&&Number(length)!==size?fail(400,'Artwork upload was incomplete'):null);
  const broken=()=>finish(fail(400,'Artwork upload was interrupted'));
  const timer=setTimeout(()=>finish(fail(408,'Artwork upload timed out')),timeoutMs);
  req.on('data',data);req.once('end',end);req.once('error',broken);req.once('aborted',broken);
 });
}
export function sendPrivateArtwork(res,result){
 if(result.status!==200||!Buffer.isBuffer(result.binary)||result.contentType!=='image/png')return false;
 res.writeHead(200,{'Content-Type':'image/png','Content-Length':result.binary.length,'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; sandbox"});res.end(result.binary);return true;
}
