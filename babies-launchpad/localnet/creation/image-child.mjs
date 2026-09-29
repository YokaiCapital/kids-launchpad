// No URLs, paths, secret environment, metadata passthrough or network fetches.
// Run in a separately resource-limited media service in hosted environments.
import sharp from 'sharp';
import {IMAGE_SHAPES,MAX_INPUT_BYTES,MAX_INPUT_PIXELS,MAX_OUTPUT_BYTES,validateImageInput} from './image-policy.mjs';
sharp.cache(false);sharp.concurrency(1);
try{
 const [kind,contentType]=process.argv.slice(2),parts=[];let total=0;
 for await(const chunk of process.stdin){total+=chunk.length;if(total>MAX_INPUT_BYTES)throw Error('Input limit');parts.push(chunk);}
 const bytes=Buffer.concat(parts);validateImageInput(bytes,contentType,kind);
 const image=sharp(bytes,{failOn:'warning',limitInputPixels:MAX_INPUT_PIXELS,limitInputChannels:4,unlimited:false});
 const m=await image.metadata(),shape=IMAGE_SHAPES[kind];
 if(!['png','jpeg'].includes(m.format)||(m.pages??1)!==1||!m.width||!m.height||m.width>8192||m.height>8192||m.width<32||m.height<32)throw Error('Unsupported dimensions');
 const rotated=[5,6,7,8].includes(m.orientation),width=rotated?m.height:m.width,height=rotated?m.width:m.height;
 if(width!==height*shape.ratio)throw Error('Crop artwork to the required aspect ratio before upload');
 // Decode to pixels and re-encode; never keep EXIF/XMP/ICC or source chunks.
 // Auto orientation precedes resizing. Transparency is retained for PNGs.
 const result=await image.autoOrient().resize(shape.width,shape.height,{fit:'inside',withoutEnlargement:true}).toColourspace('srgb').png({compressionLevel:6}).toBuffer();
 if(result.length>MAX_OUTPUT_BYTES)throw Error('Output limit');
 process.stdout.end(result);
}catch{process.exitCode=1;}
