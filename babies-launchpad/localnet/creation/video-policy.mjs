export const VIDEO_POLICY_VERSION='video-h264-v1';
export const VIDEO_MAX_INPUT_BYTES=100*1024*1024;
export const VIDEO_MAX_OUTPUT_BYTES=32*1024*1024;
export const VIDEO_MAX_SECONDS=120;
export const VIDEO_POSTER_MAX_BYTES=2_000_000;
export function validateVideoInput(bytes,contentType){
 if(!Buffer.isBuffer(bytes)||bytes.length<12||bytes.length>VIDEO_MAX_INPUT_BYTES)throw Error('Choose a video under 100 MiB');
 const mp4=bytes.subarray(4,8).toString('ascii')==='ftyp',webm=bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
 if(!(contentType==='video/mp4'&&mp4)&&!(contentType==='video/webm'&&webm))throw Error('Choose an MP4 or WebM matching its declared type');
 return contentType==='video/mp4'?'mov':'matroska,webm';
}
