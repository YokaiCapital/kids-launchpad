import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVideoSanitizer} from './video-sanitizer.mjs';
import {validateVideoInput,VIDEO_MAX_INPUT_BYTES} from './video-policy.mjs';
const exec=promisify(execFile),ffmpeg=process.env.KIDS_TEST_FFMPEG,ffprobe=process.env.KIDS_TEST_FFPROBE;
test('video admission rejects mismatched formats, unbounded workers and oversized uploads',()=>{
 assert.throws(()=>createVideoSanitizer({ffmpeg:'ffmpeg',ffprobe:'ffprobe'}));
 assert.throws(()=>validateVideoInput(Buffer.from('#EXTM3U\nhttps://invalid.test'), 'video/mp4'));
 assert.throws(()=>validateVideoInput(Buffer.alloc(VIDEO_MAX_INPUT_BYTES+1),'video/mp4'));
});
test('video transcode preserves audio/duration, pads to 16:9 and removes user metadata',{skip:!ffmpeg||!ffprobe},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kids-video-test-'));
 try{
  const path=join(dir,'sample.mp4');
  await exec(ffmpeg,['-v','error','-f','lavfi','-i','color=c=pink:s=128x128:r=12','-f','lavfi','-i','sine=frequency=440','-t','0.6','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-metadata','title=private title','-metadata','comment=private comment','-metadata','artist=private artist',path]);
  const bytes=await readFile(path),sanitize=createVideoSanitizer({ffmpeg,ffprobe});
  const working=sanitize({bytes,contentType:'video/mp4'});
  await assert.rejects(sanitize({bytes,contentType:'video/mp4'}),{code:'MEDIA_BUSY'});
  const result=await working;assert.equal(result.width,1280);assert.equal(result.height,720);assert.equal(result.contentType,'video/mp4');assert.ok(result.durationMs>=550&&result.durationMs<=850);assert.equal(result.poster.width,640);assert.equal(result.poster.height,360);
  const clean=join(dir,'clean.mp4');await writeFile(clean,result.bytes);
  const info=JSON.parse((await exec(ffprobe,['-v','error','-show_streams','-show_format','-of','json',clean])).stdout);
  assert.equal(info.streams[0].codec_name,'h264');assert.equal(info.streams[1].codec_name,'aac');assert.ok(!JSON.stringify(info).includes('private '));
  await assert.rejects(createVideoSanitizer({ffmpeg,ffprobe,timeoutMs:1})({bytes,contentType:'video/mp4'}),/timed out/);
  const truncated=bytes.subarray(0,Math.min(100,bytes.length));await assert.rejects(sanitize({bytes:truncated,contentType:'video/mp4'}));
  const webm=join(dir,'sample.webm');await exec(ffmpeg,['-v','error','-f','lavfi','-i','color=c=purple:s=320x180:r=12','-t','0.5','-c:v','libvpx-vp9',webm]);
  const silent=await sanitize({bytes:await readFile(webm),contentType:'video/webm'});assert.equal(silent.width,1280);assert.equal(silent.durationMs,500);
 }finally{await rm(dir,{recursive:true,force:true});}
});
