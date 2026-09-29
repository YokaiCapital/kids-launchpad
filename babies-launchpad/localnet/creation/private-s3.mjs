// Owned artwork is read through authenticated application handlers, never public
// object URLs or presigned GETs. Only sanitized images/video enter this bucket.
import {S3Client,GetObjectCommand,PutObjectCommand,GetPublicAccessBlockCommand,GetBucketPolicyStatusCommand} from '@aws-sdk/client-s3';
import {createHash} from 'node:crypto';
import {MAX_OUTPUT_BYTES,IMAGE_POLICY_VERSION} from './image-policy.mjs';
import {VIDEO_MAX_OUTPUT_BYTES,VIDEO_POSTER_MAX_BYTES,VIDEO_POLICY_VERSION} from './video-policy.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function objectPolicy(key){
 if(/^creator-artwork\/[a-f0-9]{64}\.png$/.test(key??''))return {type:'image/png',version:IMAGE_POLICY_VERSION,max:MAX_OUTPUT_BYTES};
 if(/^creator-video\/[a-f0-9]{64}\.(mp4|png)$/.test(key??''))return key.endsWith('.mp4')?{type:'video/mp4',version:VIDEO_POLICY_VERSION,max:VIDEO_MAX_OUTPUT_BYTES}:{type:'image/png',version:VIDEO_POLICY_VERSION,max:VIDEO_POSTER_MAX_BYTES};
 throw Error('Invalid private artwork key');
}
const matches=(bytes,type)=>type==='video/mp4'?bytes.subarray(4,8).toString('ascii')==='ftyp':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
const missing=e=>e?.name==='NoSuchKey'||e?.$metadata?.httpStatusCode===404;
const conflict=()=>Object.assign(Error('Stored artwork differs from its immutable descriptor'),{code:'MEDIA_STORAGE_CONFLICT'});
export function createPrivateS3Store({bucket,region,client=null,timeoutMs=10000}){
 if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket??'')||!/^([a-z]{2}-){1,2}[a-z]+-\d$/.test(region??'')||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error('Explicit private bucket, region and bounded transport required');
 const s3=client??new S3Client({region,maxAttempts:1,followRegionRedirects:false});
 async function operation(fn){const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeoutMs);try{return await fn(command=>s3.send(command,{abortSignal:abort.signal}));}finally{clearTimeout(timer);}}
 const validate=objectPolicy;
 async function read(key){
  const policy=validate(key);
  return operation(async send=>{
   let response;try{response=await send(new GetObjectCommand({Bucket:bucket,Key:key}));}catch(e){if(missing(e))return null;throw Error('Private artwork unavailable');}
   const body=response.Body,parts=[];let size=0;
   try{
    if(response.ContentType!==policy.type||!Number.isSafeInteger(response.ContentLength)||response.ContentLength<24||response.ContentLength>policy.max||!body)throw conflict();
    for await(const chunk of body){size+=chunk.length;if(size>policy.max)throw conflict();parts.push(Buffer.from(chunk));}
    const bytes=Buffer.concat(parts),sha256=hash(bytes);
    if(size!==response.ContentLength||response.Metadata?.sha256!==sha256||response.Metadata?.policy!==policy.version||!matches(bytes,policy.type))throw conflict();
    return {bytes,sha256,contentType:policy.type,policyVersion:policy.version};
   }finally{body?.destroy?.();}
  });
 }
 return {
  storageId:hash(Buffer.from('aws-s3:'+region+':'+bucket)),
  async verifyPrivacy(){
   // Required at readiness, then periodically. Any unknown result fails closed.
   return operation(async send=>{
    const r=await send(new GetPublicAccessBlockCommand({Bucket:bucket}));
    if(!['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets'].every(k=>r.PublicAccessBlockConfiguration?.[k]===true))throw Error('Artwork bucket must block all public access');
    let status;try{status=await send(new GetBucketPolicyStatusCommand({Bucket:bucket}));}catch(e){if(e?.name!=='NoSuchBucketPolicy')throw Error('Bucket policy status unavailable');}
    if(status&&status.PolicyStatus?.IsPublic!==false)throw Error('Artwork bucket policy is not private');
    return true;
   });
  },
  read,
  async put(key,{bytes,sha256,policyVersion}){
   const policy=validate(key);if(!Buffer.isBuffer(bytes)||bytes.length<24||bytes.length>policy.max||hash(bytes)!==sha256||policyVersion!==policy.version||!matches(bytes,policy.type))throw conflict();
   try{await operation(send=>send(new PutObjectCommand({Bucket:bucket,Key:key,Body:bytes,ContentLength:bytes.length,ContentType:policy.type,CacheControl:'private, no-store',ServerSideEncryption:'AES256',IfNoneMatch:'*',Metadata:{sha256,policy:policyVersion}})));}
   catch(e){if(e?.name!=='PreconditionFailed'&&e?.$metadata?.httpStatusCode!==412)throw Error('Artwork storage outcome unresolved');}
   // Reconcile a previous conditional write and verify bytes, not only metadata.
   const saved=await read(key);if(!saved||saved.sha256!==sha256||!saved.bytes.equals(bytes))throw conflict();
   return {sha256,byteCount:bytes.length};
  },
  close(){s3.destroy?.();},
 };
}
