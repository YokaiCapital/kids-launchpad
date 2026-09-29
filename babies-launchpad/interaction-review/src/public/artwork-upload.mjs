export async function uploadPrivateArtwork({blob,kind,requestId,csrf,signal,fetchImpl=fetch}){
 if(!(blob instanceof Blob)||blob.type!=='image/png'||blob.size>2_000_000||!['pfp','banner'].includes(kind)||!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId??''))throw Error('Invalid cropped artwork');
 const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),45000);
 try{
  const response=await fetchImpl('/api/account/launches/artwork/upload',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'image/png','x-kids-csrf':csrf,'x-kids-upload-id':requestId,'x-kids-artwork-kind':kind},body:blob,signal:signal?AbortSignal.any([signal,deadline.signal]):deadline.signal});
  const reader=response.body?.getReader();if(!reader)throw Error('Artwork response unavailable');const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384)throw Error('Artwork response unavailable');chunks.push(value);}}finally{await reader.cancel();}
  const data=JSON.parse(new TextDecoder().decode(await new Blob(chunks).arrayBuffer()));
  if(!response.ok)throw Error(data.error||'Upload could not finish. Retry the same crop.');
  const a=data.artwork;
  if(a?.status!=='ready')throw Error(a?.status==='failed'?'This upload could not be processed. Choose the image again.':'Artwork is still processing. Retry this upload shortly.');
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(a.assetId??'')||!/^[a-f0-9]{64}$/.test(a.sha256??'')||a.kind!==kind||a.contentType!=='image/png'||!Number.isSafeInteger(a.size)||a.size<24||a.size>2_000_000)throw Error('Artwork receipt is invalid');
  return {...a,url:'/api/account/launches/artwork/'+encodeURIComponent(a.assetId)};
 }catch(e){if(deadline.signal.aborted)throw Error('Upload status is unknown. Retry the same crop to check it.');throw e;}finally{clearTimeout(timer);}
}
