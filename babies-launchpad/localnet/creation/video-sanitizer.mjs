// Run on a secret-free media replica with an OS memory/CPU limit and no network
// egress. Protocol restrictions and process budgets are defense in depth, not an
// operating-system sandbox. Never run a hosted decoder in the signer container.
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {VIDEO_POLICY_VERSION,VIDEO_MAX_OUTPUT_BYTES,VIDEO_MAX_SECONDS,VIDEO_POSTER_MAX_BYTES,validateVideoInput} from './video-policy.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const invalid=()=>Error('Video must contain one playable video track, optional audio and at most two minutes');
function checkedProbe(result,{output=false}={}){
 const streams=result?.streams;if(!Array.isArray(streams)||streams.length<1||streams.length>2)throw invalid();
 const video=streams.filter(s=>s.codec_type==='video'),audio=streams.filter(s=>s.codec_type==='audio');
 if(video.length!==1||video.length+audio.length!==streams.length||audio.length>1)throw invalid();
 const v=video[0],seconds=Number(result.format?.duration);
 if(!Number.isFinite(seconds)||seconds<=0||seconds>VIDEO_MAX_SECONDS||!Number.isSafeInteger(v.width)||!Number.isSafeInteger(v.height)||v.width<16||v.height<16||v.width>4096||v.height>4096||v.width*v.height>8_847_360||v.disposition?.attached_pic)throw invalid();
 if(output&&(v.codec_name!=='h264'||v.pix_fmt!=='yuv420p'||v.width!==1280||v.height!==720||audio.some(a=>a.codec_name!=='aac')))throw invalid();
 return {seconds,audio:audio.length===1};
}
export function createVideoSanitizer({ffmpeg,ffprobe,maxActive=1,timeoutMs=90000}={}){
 if(!isAbsolute(ffmpeg??'')||!isAbsolute(ffprobe??'')||!Number.isInteger(maxActive)||maxActive<1||maxActive>2||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('Explicit video binaries and bounded worker configuration required');
 let active=0;
 return async function sanitize({bytes,contentType}){
  const demux=validateVideoInput(bytes,contentType);
  if(active>=maxActive)throw Object.assign(Error('Video processor is busy'),{code:'MEDIA_BUSY'});
  active++;let dir;const deadline=Date.now()+timeoutMs;
  try{
   dir=await mkdtemp(join(tmpdir(),'kids-video-'));
   const input=join(dir,'input'),output=join(dir,'output.mp4'),poster=join(dir,'poster.png');
   await writeFile(input,bytes,{mode:0o600,flag:'wx'});
   async function run(binary,args,maxBytes=65536){
    const remaining=deadline-Date.now();if(remaining<=0)throw Error('Video processing timed out');
    return new Promise((resolve,reject)=>{
     const p=spawn(binary,args,{cwd:dir,env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','ignore']});
     let failure=null,size=0;const parts=[];
     const fail=message=>{failure??=message;p.kill('SIGKILL');};
     const timer=setTimeout(()=>fail('Video processing timed out'),remaining);
     p.on('error',()=>{clearTimeout(timer);reject(Error('Video processor unavailable'));});
     p.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)fail('Video processor output exceeded its limit');else parts.push(chunk);});
     p.on('close',code=>{clearTimeout(timer);if(code!==0||failure)return reject(Error(failure??'Video could not be decoded safely'));resolve(Buffer.concat(parts));});
    });
   }
   const common=['-v','error','-max_alloc','67108864','-cpucount','2'];
   const inputArgs=(path,format)=>['-protocol_whitelist','file,pipe','-f',format,...(format==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[]),'-i',path];
   const probe=async(path,format)=>JSON.parse(await run(ffprobe,[...common,...inputArgs(path,format),'-show_entries','format=duration:stream=codec_type,codec_name,width,height,pix_fmt:stream_disposition=attached_pic','-of','json']));
   const before=checkedProbe(await probe(input,demux));
   await run(ffmpeg,[...common,'-nostdin','-n','-threads','2','-filter_threads','1',...inputArgs(input,demux),
    '-map','0:v:0','-map','0:a:0?','-sn','-dn','-map_metadata','-1','-map_chapters','-1',
    '-vf','scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x130e1d,setsar=1,fps=30',
    '-c:v','libx264','-preset','veryfast','-crf','24','-maxrate','1800k','-bufsize','3600k','-pix_fmt','yuv420p','-threads','2',
    '-c:a','aac','-b:a','96k','-ac','2','-ar','48000','-t',String(VIDEO_MAX_SECONDS+1),'-fs',String(VIDEO_MAX_OUTPUT_BYTES+65536),'-movflags','+faststart','-fflags','+bitexact','-flags:v','+bitexact',output]);
   const info=await stat(output);if(info.size<24||info.size>VIDEO_MAX_OUTPUT_BYTES)throw Error('Processed video exceeds 32 MiB');
   const after=checkedProbe(await probe(output,'mov'),{output:true});
   if(before.audio!==after.audio||Math.abs(before.seconds-after.seconds)>0.25)throw Error('Video duration changed during processing');
   await run(ffmpeg,[...common,'-nostdin','-n',...inputArgs(output,'mov'),'-map','0:v:0','-frames:v','1','-vf','scale=640:360','-map_metadata','-1','-threads','1','-fs',String(VIDEO_POSTER_MAX_BYTES+65536),poster]);
   if((await stat(poster)).size>VIDEO_POSTER_MAX_BYTES)throw Error('Video poster exceeds its limit');
   const clean=await readFile(output),png=await readFile(poster);
   if(png.length<24||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.readUInt32BE(16)!==640||png.readUInt32BE(20)!==360)throw invalid();
   return {bytes:clean,sha256:hash(clean),contentType:'video/mp4',width:1280,height:720,durationMs:Math.round(after.seconds*1000),sanitized:true,policyVersion:VIDEO_POLICY_VERSION,poster:{bytes:png,sha256:hash(png),contentType:'image/png',width:640,height:360}};
  }finally{if(dir)await rm(dir,{recursive:true,force:true});active--;}
 };
}
