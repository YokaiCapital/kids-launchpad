import {useEffect,useId,useRef,useState} from 'react';
import {UploadSimple,Warning,X} from '@phosphor-icons/react';
import {cropRect,cropArtwork} from './artwork-crop.mjs';
export function ArtworkUpload({kind,label,value,onChange,onUpload,onBusyChange,automatic=false}){
 const id=useId(),[crop,setCrop]=useState(null),[zoom,setZoom]=useState(1),[x,setX]=useState(0.5),[y,setY]=useState(0.5),[phase,setPhase]=useState('idle'),[error,setError]=useState('');
 const generation=useRef(0),source=useRef(null),attempt=useRef(null),controller=useRef(null),fileInput=useRef(null),uploading=useRef(false);
 const busy=phase==='reading'||phase==='uploading'||!!crop;
 useEffect(()=>{onBusyChange?.(kind,busy);return()=>onBusyChange?.(kind,false);},[kind,busy,onBusyChange]);
 function dispose(){controller.current?.abort();controller.current=null;if(source.current){source.current.bitmap.close();URL.revokeObjectURL(source.current.url);source.current=null;}attempt.current=null;}
 useEffect(()=>()=>{generation.current++;dispose();},[]);
 function cancel(){generation.current++;uploading.current=false;dispose();setCrop(null);setPhase('idle');setError('');if(fileInput.current)fileInput.current.value='';}
 async function pick(file){
  if(!file||!onUpload)return;const mine=++generation.current;dispose();setCrop(null);setError('');setPhase('reading');
  try{
   if(!['image/png','image/jpeg'].includes(file.type)||file.size>5*1024*1024)throw Error('Choose a PNG or JPEG under 5 MiB.');
   const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
   if(generation.current!==mine){bitmap.close();return;}
   try{cropRect({width:bitmap.width,height:bitmap.height,kind});}catch(e){bitmap.close();throw e;}
   const next={bitmap,url:URL.createObjectURL(file),name:file.name};source.current=next;setCrop(next);setZoom(1);setX(0.5);setY(0.5);setPhase('crop');if(automatic)await upload({zoom:1,x:0.5,y:0.5});
  }catch(e){if(generation.current===mine){setError(e.message);setPhase('idle');}}
 }
 async function upload(cropOptions=null){
  if(!source.current||uploading.current)return;uploading.current=true;const mine=generation.current;setPhase('uploading');setError('');
  try{
   // Retry exactly the prior upload identity/bytes after an ambiguous response.
   attempt.current??={requestId:crypto.randomUUID(),blob:await cropArtwork(source.current.bitmap,{kind,...(cropOptions&&typeof cropOptions.zoom==='number'?cropOptions:{zoom,x,y})})};
   if(generation.current!==mine)return;
   controller.current=new AbortController();
   // The server processes a bounded number of images at once; when it says busy, the same crop is sent again after a
   // short pause (same upload id and bytes, so nothing is duplicated) before the creator is asked to retry.
   let result;for(let tries=0;;tries++){try{result=await onUpload({...attempt.current,kind,signal:controller.current.signal});break;}catch(e){if(tries>=3||!/busy/i.test(e?.message||'')||controller.current.signal.aborted)throw e;await new Promise(r=>setTimeout(r,1500*(tries+1)));if(generation.current!==mine)return;}}
   if(generation.current!==mine)return;
   onChange({...result,name:source.current.name});dispose();setCrop(null);setPhase('ready');
  }catch(e){if(generation.current===mine){setError(e.message||'Upload could not finish. Retry without changing the crop.');setPhase('retry');}}finally{if(generation.current===mine)uploading.current=false;}
 }
 const rect=crop?cropRect({width:crop.bitmap.width,height:crop.bitmap.height,kind,zoom,x,y}):null;
 const maxZoom=crop?Math.min(3,Math.floor(Math.min(crop.bitmap.width/(kind==='banner'?3:1),crop.bitmap.height)/32*20)/20):3;
 const adjust=(setter,v)=>{attempt.current=null;setPhase('crop');setError('');setter(Number(v));};
 return <section className={'pl-field pl-upload pl-artwork '+(kind==='banner'?'is-banner':'')} aria-label={label}>
  <div className="pl-field-row"><label className="pl-label" htmlFor={id} style={{margin:0}}>{label}</label><span className="pl-count">{kind==='banner'?'3:1':'Square'} · PNG / JPEG</span></div>
  {crop?<>
   <div className={'pl-crop-frame '+(kind==='banner'?'is-banner':'')} aria-label={label+' crop preview'}>
    <img src={crop.url} alt="Selected crop" style={{width:crop.bitmap.width/rect.width*100+'%',height:crop.bitmap.height/rect.height*100+'%',left:-rect.left/rect.width*100+'%',top:-rect.top/rect.height*100+'%'}}/>
   </div>
   <div className="pl-crop-controls"><label>Zoom<input aria-label={label+' zoom'} type="range" min="1" max={maxZoom} step="0.05" value={zoom} disabled={phase==='uploading'} onChange={e=>adjust(setZoom,e.target.value)}/></label>
    <label>Left / right<input aria-label={label+' horizontal position'} type="range" min="0" max="1" step="0.01" value={x} disabled={phase==='uploading'} onChange={e=>adjust(setX,e.target.value)}/></label>
    <label>Up / down<input aria-label={label+' vertical position'} type="range" min="0" max="1" step="0.01" value={y} disabled={phase==='uploading'} onChange={e=>adjust(setY,e.target.value)}/></label></div>
   <div className="pl-upload-row"><button type="button" className="primary" disabled={phase==='uploading'} onClick={upload}>{phase==='uploading'?'Uploading and checking…':phase==='retry'?'Retry upload':'Use this crop'}</button><button type="button" className="pl-quiet" onClick={cancel}>Cancel</button></div>
  </>:<>
   {value?.url&&<img className="pl-upload-preview" src={value.url} alt={label+' preview'} width={kind==='pfp'?96:undefined} height={kind==='pfp'?96:undefined}/>}
   <div className="pl-upload-row"><label className="pl-file" htmlFor={id}><UploadSimple size={18} aria-hidden="true"/>{phase==='reading'?'Reading image…':value?'Replace':'Choose image'}<input id={id} ref={fileInput} type="file" accept="image/png,image/jpeg" disabled={!onUpload||phase==='reading'} onChange={e=>pick(e.target.files?.[0])}/></label>
    {value&&<button type="button" className="pl-btn-sm pl-quiet" onClick={()=>{cancel();onChange(null);}} aria-label={'Remove '+label}><X size={14} aria-hidden="true"/> Remove</button>}</div>
  </>}
  <p className="pl-help-text" role="status">{!onUpload?'Private artwork uploads are not enabled yet.':value?.assetId&&!crop?'Saved privately to your wallet.':automatic?'Auto-cropped. Private until you approve publication.':'Adjust the crop, then upload. Files stay private until you approve publication.'}</p>
  {error&&<p className="pl-error" role="alert"><Warning size={14} aria-hidden="true"/>{error}</p>}
 </section>;
}
