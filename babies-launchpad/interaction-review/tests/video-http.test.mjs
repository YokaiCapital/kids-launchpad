import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createVideoUploadReader,createVideoPlaybackAdmission,sendPrivateVideo} from '../server/video-http.mjs';
import {uploadPrivateVideo} from '../src/public/video-upload.mjs';
const req=headers=>{const stream=new PassThrough();stream.headers={'content-type':'video/mp4','x-kids-upload-id':'test-upload',...headers};return stream;};
test('video body admission is bounded until service completion; interruptions and invalid lengths release slots',async()=>{
 const read=createVideoUploadReader({timeoutMs:50}),a=req({'content-length':'4'}),pending=read(a);a.end('1234');const upload=await pending;
 await assert.rejects(read(req()),{status:503});assert.equal(upload.input.bytes.length,4);upload.release();upload.release();
 await assert.rejects(read(req({'content-length':String(100*1024*1024+1)})),{status:413});await assert.rejects(read(req({'content-type':'text/html'})),{status:400});
 const short=req({'content-length':'8'}),bad=assert.rejects(read(short),{status:400});short.end('1234');await bad;
 const abort=req(),aborted=assert.rejects(read(abort),{status:400});abort.emit('aborted');await aborted;abort.end();
 const slow=req();await assert.rejects(createVideoUploadReader({timeoutMs:1})(slow),{status:408});slow.end();
 const last=req(),ok=read(last);last.end('1234');(await ok).release();
});
test('private video playback supports bounded single ranges and no-store responses',()=>{
 const result={status:200,binary:Buffer.from('0123456789'),contentType:'video/mp4'};
 function response(range){let status,headers,body;const res={writeHead:(s,h)=>{status=s;headers=h;},end:b=>body=b};assert.equal(sendPrivateVideo(res,result,range),true);return {status,headers,body};}
 assert.equal(response().body.toString(),'0123456789');assert.equal(response('bytes=2-4').body.toString(),'234');assert.equal(response('bytes=-3').body.toString(),'789');assert.equal(response('bytes=8-').body.toString(),'89');assert.equal(response('bytes=1-99').headers['Content-Range'],'bytes 1-9/10');
 for(const invalid of ['bytes=20-','bytes=5-3','bytes=','bytes=-0','bytes=0-1,3-4','bytes=999999999999999999999-'])assert.equal(response(invalid).status,416);
 assert.equal(response().headers['Cache-Control'],'private, no-store');assert.equal(response().headers.Vary,'Cookie');
});
test('client video retries preserve request identity and only accept bounded processed receipts',async()=>{
 const calls=[],file=new Blob(['test'],{type:'video/mp4'}),v={assetId:'owned-video',kind:'video',status:'ready',sha256:'a'.repeat(64),posterHash:'b'.repeat(64),contentType:'video/mp4',size:1024,width:1280,height:720,durationMs:500};
 let receipt=v;const fetchImpl=async(url,options)=>{calls.push({url,options});return Response.json({video:receipt});},input={file,requestId:'same-request',csrf:'test-csrf',fetchImpl};
 assert.equal((await uploadPrivateVideo(input)).url,'/api/account/launches/video/owned-video');await uploadPrivateVideo(input);assert.equal(calls[0].options.body,calls[1].options.body);assert.equal(calls[1].options.headers['x-kids-upload-id'],'same-request');
 for(const patch of [{status:'processing'},{durationMs:120001},{posterHash:'bad'},{width:1080},{size:34*1024*1024}]){receipt={...v,...patch};await assert.rejects(uploadPrivateVideo(input));}
});

test('playback retains memory admission until both loading and the response complete',()=>{
 const admit=createVideoPlaybackAdmission({maxActive:1}),res=new EventEmitter();res.destroy=()=>res.emit('close');const loaded=admit(res);
 res.emit('close');assert.throws(()=>admit(new EventEmitter()),e=>e.status===503);loaded();loaded();
 const next=new EventEmitter();next.destroy=()=>next.emit('close');const done=admit(next);done();assert.throws(()=>admit(new EventEmitter()),e=>e.status===503);next.emit('finish');const last=new EventEmitter();last.destroy=()=>last.emit('close');const finish=admit(last);finish();last.emit('finish');
});
