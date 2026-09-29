export async function uploadPrivateVideo({file,requestId,csrf,signal,fetchImpl=fetch}){
 if(!(file instanceof Blob)||!['video/mp4','video/webm'].includes(file.type)||file.size>100*1024*1024||!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId??''))throw Error('Choose an MP4 or WebM under 100 MiB');
 const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),150000);
 try{
  const response=await fetchImpl('/api/account/launches/video/upload',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':file.type,'x-kids-csrf':csrf,'x-kids-upload-id':requestId},body:file,signal:signal?AbortSignal.any([signal,deadline.signal]):deadline.signal});
  const reader=response.body?.getReader();if(!reader)throw Error('Video response unavailable');const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384)throw Error('Video response unavailable');chunks.push(value);}}finally{await reader.cancel();}
  const data=JSON.parse(new TextDecoder().decode(await new Blob(chunks).arrayBuffer()));if(!response.ok)throw Error(data.error||'Upload could not finish. Retry the same video.');
  const v=data.video;if(v?.status!=='ready')throw Error(v?.status==='failed'?'Video processing failed. Choose the video again.':'Video is still processing. Retry the same upload shortly.');
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(v.assetId??'')||!/^[a-f0-9]{64}$/.test(v.sha256??'')||!/^[a-f0-9]{64}$/.test(v.posterHash??'')||v.kind!=='video'||v.contentType!=='video/mp4'||v.width!==1280||v.height!==720||!Number.isSafeInteger(v.size)||v.size<24||v.size>32*1024*1024||!Number.isSafeInteger(v.durationMs)||v.durationMs<1||v.durationMs>120000)throw Error('Video receipt is invalid');
  const url='/api/account/launches/video/'+encodeURIComponent(v.assetId);return {...v,url,poster:url+'/poster'};
 }catch(e){if(deadline.signal.aborted)throw Error('Upload status is unknown. Retry the same video to check it.');throw e;}finally{clearTimeout(timer);}
}
