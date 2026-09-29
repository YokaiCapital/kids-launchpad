import {useId} from 'react';
import {Warning} from '@phosphor-icons/react';
import {LIMITS} from './launch-draft.mjs';
import {ArtworkUpload} from './ArtworkUpload';
import {VideoUpload} from './VideoUpload';
/** Step 2 (spec §4): PFP, 3:1 banner, 280-character introduction, validated HTTPS links, optional 16:9 video and caption. */
export function ProfileStep({draft,dispatch,errors,show,onUpload,onBusyChange,videoEnabled=false,onUploadVideo}){
 const id=useId();
 const set=(field,value)=>dispatch({type:'set',field,value});
 const desc=draft.description.length,cap=draft.videoCaption.length;
 return <div className="pl-step">
  <h2>Give your coin an identity.</h2>
  <p className="pl-lead">Square picture, 3:1 banner, a short introduction. Everything here becomes public when you create the launch.</p>
  <div className="pl-two">
   <ArtworkUpload kind="pfp" label="Profile picture" value={draft.pfp} onChange={v=>set('pfp',v)} onUpload={onUpload} onBusyChange={onBusyChange}/>
   <ArtworkUpload kind="banner" label="Banner" value={draft.banner} onChange={v=>set('banner',v)} onUpload={onUpload} onBusyChange={onBusyChange}/>
  </div>
  <div className="pl-field"><div className="pl-field-row"><label htmlFor={id+'-desc'}>Short introduction</label><span className={'pl-count'+(desc>LIMITS.descriptionChars?' is-over':'')}>{desc} / {LIMITS.descriptionChars}</span></div><textarea id={id+'-desc'} value={draft.description} onChange={e=>set('description',e.target.value)} placeholder="What is this coin, and who is it for?" aria-invalid={show&&!!errors.description||undefined} aria-describedby={id+'-desc-h'}/>{show&&errors.description?<p className="pl-error" id={id+'-desc-h'}><Warning size={14} aria-hidden="true"/>{errors.description}</p>:<p className="pl-help-text" id={id+'-desc-h'}>Longer context belongs in creator updates after launch.</p>}</div>
  <div className="pl-two">
   <div className="pl-field"><label htmlFor={id+'-x'}>X profile <span className="pl-muted" style={{textTransform:'none',fontWeight:500}}>(optional)</span></label><input id={id+'-x'} type="url" inputMode="url" value={draft.xUrl} onChange={e=>set('xUrl',e.target.value)} placeholder="https://x.com/yourcoin" aria-invalid={show&&!!errors.xUrl||undefined} aria-describedby={id+'-x-h'} autoComplete="off" spellCheck="false"/>{show&&errors.xUrl&&<p className="pl-error" id={id+'-x-h'}><Warning size={14} aria-hidden="true"/>{errors.xUrl}</p>}</div>
   <div className="pl-field"><label htmlFor={id+'-web'}>Website <span className="pl-muted" style={{textTransform:'none',fontWeight:500}}>(optional)</span></label><input id={id+'-web'} type="url" inputMode="url" value={draft.websiteUrl} onChange={e=>set('websiteUrl',e.target.value)} placeholder="https://yourcoin.example" aria-invalid={show&&!!errors.websiteUrl||undefined} aria-describedby={id+'-web-h'} autoComplete="off" spellCheck="false"/>{show&&errors.websiteUrl&&<p className="pl-error" id={id+'-web-h'}><Warning size={14} aria-hidden="true"/>{errors.websiteUrl}</p>}</div>
  </div>
  {videoEnabled&&<VideoUpload value={draft.video} onChange={v=>set('video',v)} onUpload={onUploadVideo} onBusyChange={onBusyChange}/>}
  {videoEnabled&&draft.video&&!draft.video.error&&<div className="pl-field"><div className="pl-field-row"><label htmlFor={id+'-cap'}>Video caption</label><span className={'pl-count'+(cap>LIMITS.captionChars?' is-over':'')}>{cap} / {LIMITS.captionChars}</span></div><input id={id+'-cap'} value={draft.videoCaption} onChange={e=>set('videoCaption',e.target.value)} placeholder="One short sentence." aria-invalid={show&&!!errors.videoCaption||undefined}/>{show&&errors.videoCaption&&<p className="pl-error"><Warning size={14} aria-hidden="true"/>{errors.videoCaption}</p>}</div>}
  {!videoEnabled&&draft.video&&<p className="pl-error">Video publication is not enabled for this launch. <button type="button" onClick={()=>{set('video',null);set('videoCaption','');}}>Remove saved video</button></p>}
  <p className="pl-help-text">Uploads are published to a public content store when you create the launch. They are not private after that.</p>
 </div>;
}
