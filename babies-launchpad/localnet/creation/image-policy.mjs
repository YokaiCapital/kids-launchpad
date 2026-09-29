export const IMAGE_POLICY_VERSION='raster-v1';
export const MAX_INPUT_BYTES=5*1024*1024,MAX_OUTPUT_BYTES=2_000_000,MAX_INPUT_PIXELS=16_000_000;
export const IMAGE_SHAPES=Object.freeze({pfp:{width:1024,height:1024,ratio:1},banner:{width:1800,height:600,ratio:3}});
export function validateImageInput(bytes,contentType,kind){
 if(!Buffer.isBuffer(bytes)||bytes.length<8||bytes.length>MAX_INPUT_BYTES||!Object.hasOwn(IMAGE_SHAPES,kind))throw Error('Invalid artwork input');
 const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg=bytes.subarray(0,3).equals(Buffer.from([255,216,255]));
 if(!(contentType==='image/png'&&png)&&!(contentType==='image/jpeg'&&jpg))throw Error('Use a PNG or JPEG image matching its declared type');
}
