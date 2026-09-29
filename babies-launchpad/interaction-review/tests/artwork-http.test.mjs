import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {readArtworkUpload} from '../server/artwork-http.mjs';
import {MAX_INPUT_BYTES} from '../../localnet/creation/image-policy.mjs';
const req=(extra={})=>{const r=new PassThrough();r.headers={'content-type':'image/png','x-kids-upload-id':'one','x-kids-artwork-kind':'pfp',...extra};return r;};
test('binary artwork transport is byte/deadline bounded including chunked uploads',async()=>{
 const ok=req({'content-length':'4'}),read=readArtworkUpload(ok);ok.end(Buffer.from([1,2,3,4]));assert.equal((await read).bytes.length,4);
 await assert.rejects(readArtworkUpload(req({'content-length':String(MAX_INPUT_BYTES+1)})),{status:413});
 await assert.rejects(readArtworkUpload(req({'content-type':'image/svg+xml'})),{status:400});
 const huge=req(),tooLarge=assert.rejects(readArtworkUpload(huge),{status:413});huge.end(Buffer.alloc(MAX_INPUT_BYTES+1));await tooLarge;
 const short=req({'content-length':'8'}),shorter=assert.rejects(readArtworkUpload(short),{status:400});short.end('1234');await shorter;
 const slow=req();await assert.rejects(readArtworkUpload(slow,{timeoutMs:2}),{status:408});slow.end();
 const broken=req(),interrupted=assert.rejects(readArtworkUpload(broken),{status:400});broken.emit('aborted');await interrupted;broken.end();
});
