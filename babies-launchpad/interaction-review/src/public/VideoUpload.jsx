import {useEffect,useId,useRef,useState} from 'react';
import {UploadSimple,Warning} from '@phosphor-icons/react';
export function VideoUpload({value,onChange,onUpload,onBusyChange,maxBytes=100*1024*1024}){
 const id=useId(),attempt=useRef(null),controller=useRef(null),generation=useRef(0),input=useRef(null);
 const [working,setWorking]=useState(false),[error,setError]=useState(''),[name,setName]=useState('');
 useEffect(()=>{onBusyChange?.('video',working);return()=>onBusyChange?.('video',false);},[working,onBusyChange]);
 useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
 async function upload(){
  if(!attempt.current||!onUpload||controller.current)return;const mine=++generation.current;setWorking(true);setError('');const abort=new AbortController();controller.current=abort;
  try{const result=await onUpload({...attempt.current,signal:abort.signal});if(mine===generation.current){onChange(result);attempt.current=null;setName('');}}
  catch(e){if(mine===generation.current&&!abort.signal.aborted)setError(e.message||'Upload did not finish. Retry the same video.');}
  finally{if(mine===generation.current){controller.current=null;setWorking(false);}}
 }
 function pick(file){if(!file||working)return;if(!['video/mp4','video/webm'].includes(file.type)||file.size>maxBytes){setError('Choose an MP4 or WebM under '+Math.floor(maxBytes/1024/1024)+' MiB and two minutes.');return;}attempt.current={file,requestId:crypto.randomUUID()};setName(file.name);upload();}
 function cancel(){generation.current++;controller.current?.abort();controller.current=null;attempt.current=null;setWorking(false);setError('');setName('');if(input.current)input.current.value='';}
 return <section className="pl-field pl-upload" aria-label="Video upload">
  <div className="pl-field-row"><label htmlFor={id}>Video (optional)</label><span className="pl-count">16:9 · {Math.floor(maxBytes/1024/1024)} MiB · 2 minutes</span></div>
  {value?.url&&<video className="pl-private-video" src={value.url} poster={value.poster||value.url+'/poster'} controls playsInline preload="metadata" aria-label="Private video preview"/>}
  <div className="pl-upload-row"><label className="pl-file" htmlFor={id}><UploadSimple size={18} aria-hidden="true"/>{value?'Replace video':'Choose video'}<input ref={input} id={id} type="file" accept="video/mp4,video/webm" disabled={working||!onUpload} onChange={e=>pick(e.target.files?.[0])}/></label>
   {!working&&attempt.current&&<button type="button" onClick={upload}>Retry upload</button>}
   {(working||attempt.current)&&<button type="button" onClick={cancel}>Cancel upload</button>}
   {value&&!working&&<button type="button" onClick={()=>{cancel();onChange(null);}}>Remove video</button>}
  </div>
  <p className="pl-help-text" role="status">{working?'Uploading and processing '+name+'…':value?.assetId?'Saved privately to your wallet.':'Video is fitted to 16:9 without cropping. It stays private until you approve publication.'}</p>
  {error&&<p className="pl-error" role="alert"><Warning size={14} aria-hidden="true"/>{error}</p>}
 </section>;
}
