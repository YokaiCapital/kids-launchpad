import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {IMAGE_POLICY_VERSION,MAX_OUTPUT_BYTES,validateImageInput} from './image-policy.mjs';
const child=fileURLToPath(new URL('./image-child.mjs',import.meta.url));
export function createImageSanitizer({maxActive=2,timeoutMs=15000}={}){
 if(!Number.isInteger(maxActive)||maxActive<1||maxActive>8||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>20000)throw Error('Bounded image worker configuration required');
 let active=0;
 return async function sanitize({bytes,contentType,kind}){
  validateImageInput(bytes,contentType,kind);
  if(active>=maxActive)throw Object.assign(Error('Image worker is busy'),{code:'MEDIA_BUSY'});
  active++;
  try{return await new Promise((resolve,reject)=>{
   // Explicit environment: do not pass wallet, database, pinning or bucket keys.
   const proc=spawn(process.execPath,['--max-old-space-size=128',child,kind,contentType],{env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C',VIPS_CONCURRENCY:'1'},stdio:['pipe','pipe','ignore']});
   const chunks=[];let count=0,failure=null;
   const fail=message=>{failure??=message;proc.kill('SIGKILL');};
   const timer=setTimeout(()=>fail('Image processing timed out'),timeoutMs);
   proc.on('error',()=>{clearTimeout(timer);reject(Error('Image processor unavailable'));});
   proc.stdout.on('data',chunk=>{count+=chunk.length;if(count>MAX_OUTPUT_BYTES)fail('Processed image is too large');else chunks.push(chunk);});
   proc.stdin.on('error',()=>fail('Image could not be processed'));
   proc.on('close',code=>{
    clearTimeout(timer);if(failure||code!==0)return reject(Error(failure??'Invalid image or aspect ratio: use a square PFP or 3:1 banner'));
    const result=Buffer.concat(chunks);
    if(result.length<24||!result.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return reject(Error('Invalid processed image'));
    resolve({bytes:result,contentType:'image/png',width:result.readUInt32BE(16),height:result.readUInt32BE(20),sha256:createHash('sha256').update(result).digest('hex'),sanitized:true,policyVersion:IMAGE_POLICY_VERSION});
   });
   proc.stdin.end(bytes);
  });}finally{active--;}
 };
}
