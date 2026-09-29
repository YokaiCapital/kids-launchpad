// Pixel coordinates match the CSS preview. Normalized pan controls are accessible
// by keyboard as well as touch; no hidden automatic face/content cropping.
export function cropRect({width,height,kind,zoom=1,x=0.5,y=0.5}){
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<32||height<32||width>8192||height>8192||width*height>16000000||!['pfp','banner'].includes(kind)||!Number.isFinite(zoom)||zoom<1||zoom>3||![x,y].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error('Use an image up to 16 megapixels, at least 32 pixels on each side');
 const ratio=kind==='pfp'?1:3,cropWidth=Math.min(width,height*ratio)/zoom,cropHeight=cropWidth/ratio;
 const outWidth=Math.min(kind==='pfp'?1024:1800,Math.floor(cropWidth/ratio)*ratio),outHeight=outWidth/ratio;
 if(outHeight<32)throw Error('Zoom out to keep enough image detail');
 return {left:(width-cropWidth)*x,top:(height-cropHeight)*y,width:cropWidth,height:cropHeight,outWidth,outHeight};
}
export async function cropArtwork(bitmap,options){
 const rect=cropRect({width:bitmap.width,height:bitmap.height,...options});
 const canvas=document.createElement('canvas');canvas.width=rect.outWidth;canvas.height=rect.outHeight;
 const context=canvas.getContext('2d');if(!context)throw Error('Image preview is unavailable in this browser');
 context.drawImage(bitmap,rect.left,rect.top,rect.width,rect.height,0,0,rect.outWidth,rect.outHeight);
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
 if(!blob||blob.size>2_000_000)throw Error('This crop is too large. Choose a smaller or simpler image.');
 return blob;
}
