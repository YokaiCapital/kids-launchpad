import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createImageSanitizer} from './image-sanitizer.mjs';
import {MAX_INPUT_BYTES} from './image-policy.mjs';
const make=(width,height)=>sharp({create:{width,height,channels:4,background:{r:255,g:100,b:200,alpha:0.5}}});
test('private artwork decoder preserves shape/transparency while discarding metadata',async()=>{
 const source=await make(1200,1200).withMetadata({exif:{IFD0:{Artist:'Private camera owner',Copyright:'Private test metadata'}}}).png().toBuffer();
 assert.ok((await sharp(source).metadata()).exif);
 const sanitize=createImageSanitizer(),image=await sanitize({bytes:source,contentType:'image/png',kind:'pfp'}),meta=await sharp(image.bytes).metadata();
 assert.equal(image.width,1024);assert.equal(image.height,1024);assert.equal(meta.hasAlpha,true);
 for(const key of ['exif','icc','iptc','xmp'])assert.equal(meta[key],undefined);
 assert.ok(!image.bytes.includes(Buffer.from('Private camera owner')));
 const banner=await sanitize({bytes:await make(2100,700).png().toBuffer(),contentType:'image/png',kind:'banner'});
 assert.equal(banner.width,1800);assert.equal(banner.height,600);
 const oriented=await make(300,900).withMetadata({orientation:6}).jpeg().toBuffer();
 const rotated=await sanitize({bytes:oriented,contentType:'image/jpeg',kind:'banner'});assert.equal(rotated.width,900);assert.equal(rotated.height,300);
});
test('decoder rejects mismatched types, malformed pixels, bombs, animation and unsafe shapes',async()=>{
 const sanitize=createImageSanitizer(),valid=await make(64,64).png().toBuffer();
 await assert.rejects(sanitize({bytes:valid,contentType:'image/jpeg',kind:'pfp'}));
 await assert.rejects(sanitize({bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),contentType:'image/svg+xml',kind:'pfp'}));
 await assert.rejects(sanitize({bytes:Buffer.alloc(MAX_INPUT_BYTES+1),contentType:'image/png',kind:'pfp'}));
 for(const bytes of [valid.subarray(0,32),await make(64,128).png().toBuffer(),await make(4100,4100).png().toBuffer()])await assert.rejects(sanitize({bytes,contentType:'image/png',kind:'pfp'}));
 const gif=await make(64,64).gif().toBuffer();await assert.rejects(sanitize({bytes:gif,contentType:'image/gif',kind:'pfp'}));
});
test('decoder has no unbounded queue and kills timed-out children',async()=>{
 const bytes=await make(64,64).png().toBuffer(),input={bytes,contentType:'image/png',kind:'pfp'},sanitize=createImageSanitizer({maxActive:1});
 const first=sanitize(input);await assert.rejects(sanitize(input),{code:'MEDIA_BUSY'});await first;
 await assert.rejects(createImageSanitizer({timeoutMs:1})(input),/timed out/);
 await sanitize(input);
});
