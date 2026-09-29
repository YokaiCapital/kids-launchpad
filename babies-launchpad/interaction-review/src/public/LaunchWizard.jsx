import {useCallback,useEffect,useReducer,useRef,useState} from 'react';
import {initialDraft,reduceDraft,stepErrors,reviewModel,LIMITS} from './launch-draft.mjs';
import {ArtworkUpload} from './ArtworkUpload';
import {VideoUpload} from './VideoUpload';
import {LiveCoinPreview} from './LiveCoinPreview';
import {SupplySplit} from './SupplySplit';
import {solAmount} from './campaign-adapter.mjs';
export function LaunchWizard({manifest,creator=null,clock,onCreate,creating=false,onCancel,savedDraft=null,onSave,onUpload,onUploadVideo,onPrepublish=null,rehearsal=false,creationError=null}){
 const [draft,dispatch]=useReducer(reduceDraft,manifest,m=>savedDraft?.body||initialDraft(m,{creator}));
 const [saving,setSaving]=useState(false),[saveMessage,setSaveMessage]=useState(''),[attempted,setAttempted]=useState(false),[mediaBusy,setMediaBusy]=useState({}),[publication,setPublication]=useState(null);
 const [localStart,setLocalStart]=useState(()=>{if(!savedDraft?.body?.startUtc)return '';const d=new Date(savedDraft.body.startUtc+'Z');return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);});
 const saved=useRef({id:savedDraft?.id||crypto.randomUUID(),revision:savedDraft?.revision||0}),lastSaved=useRef(JSON.stringify(savedDraft?.body||null)),saveLock=useRef(false),failedSave=useRef(null),latest=useRef(draft);latest.current=draft;
 const uploading=Object.values(mediaBusy).some(Boolean),busy=creating||saving;
 const onMediaBusy=useCallback((kind,value)=>setMediaBusy(old=>old[kind]===value?old:{...old,[kind]:value}),[]);
 const set=(field,value)=>dispatch({type:'set',field,value});
 const errors=Object.assign({},...stepErrors(draft,manifest,clock()));if(!draft.pfp?.assetId)errors.pfp='Add a coin image.';if(draft.start==='scheduled'&&Date.parse(draft.startUtc+'Z')/1000<=clock()+180)errors.startUtc='Choose an opening time at least 3 minutes from now.';
 const review=reviewModel(draft,manifest,clock()),supply={...(manifest.supply[draft.mode]||manifest.supply.standard),totalBaseUnits:manifest.supply.totalBaseUnits,decimals:manifest.supply.decimals};
 useEffect(()=>{if(draft.creator!==creator)dispatch({type:'set',field:'creator',value:creator});},[creator]);
 async function save(body=latest.current){
  if(saveLock.current||!onSave||!creator)return null;saveLock.current=true;setSaving(true);
  try{const result=await onSave({...saved.current,draft:body});saved.current={id:result.id,revision:result.revision};lastSaved.current=JSON.stringify(body);failedSave.current=null;setSaveMessage('Saved');return result;}
  catch(e){failedSave.current=JSON.stringify(body);setSaveMessage('Could not save. Your changes are still here.');throw e;}
  finally{saveLock.current=false;setSaving(false);}
 }
 useEffect(()=>{
  if(!creator||uploading||creating||saving||!draft.name.trim()||[lastSaved.current,failedSave.current].includes(JSON.stringify(draft)))return;
  const timer=setTimeout(()=>save().catch(()=>{}),1000);return()=>clearTimeout(timer);
 },[draft,creator,uploading,creating,saving]);
 const publishKey=draft.publicationConsent&&Object.keys(errors).length===0&&lastSaved.current===JSON.stringify(draft)?saved.current.id+':'+saved.current.revision:null;
 useEffect(()=>{
  if(!publishKey||!onPrepublish)return;let active=true,timer;
  const prepare=async()=>{
   try{const result=await onPrepublish({...saved.current});if(!active)return;setPublication({key:publishKey,status:result.status});if(result.status==='pending')timer=setTimeout(prepare,1500);}
   catch{if(active)setPublication({key:publishKey,status:'attention'});}
  };
  void prepare();return()=>{active=false;clearTimeout(timer);};
 },[publishKey]);
 async function create(e){
  e.preventDefault();setAttempted(true);if(busy||uploading||Object.keys(errors).length||!draft.publicationConsent||!onCreate)return;
  try{const result=await save(draft);if(result)await onCreate(result);}catch(e){setSaveMessage(e.message);}
 }
 const field=(key,label,placeholder)=> <div className="pl-field"><label htmlFor={'launch-'+key}>{label}</label><input id={'launch-'+key} value={draft[key]} onChange={e=>set(key,e.target.value)} placeholder={placeholder} autoComplete="off" aria-invalid={attempted&&!!errors[key]||undefined} aria-describedby={attempted&&errors[key]?'launch-'+key+'-error':undefined}/>{attempted&&errors[key]&&<p id={'launch-'+key+'-error'} className="pl-error">{errors[key]}</p>}</div>;
 return <section className="pl pl-create-simple" aria-labelledby="launch-form-title">
  <div className="pl-head"><div><h1 id="launch-form-title">Create your coin</h1><p>Make it yours. One wallet approval to launch.</p></div><button type="button" className="pl-quiet" onClick={onCancel}>My launches</button></div>
  <div className="pl-create-grid"><form onSubmit={create} noValidate className="pl-create-form">
   <div className="pl-create-identity"><ArtworkUpload kind="pfp" label="Coin image" value={draft.pfp} onChange={value=>set('pfp',value)} onUpload={onUpload} onBusyChange={onMediaBusy} automatic/>
    <div>{field('name','Coin name','Name your coin')}{field('symbol','Ticker','e.g. KIDS')}</div></div>
   {attempted&&errors.pfp&&<p className="pl-error" role="alert">{errors.pfp}</p>}
   <div className="pl-field"><label htmlFor="launch-description">Description <span className="pl-muted">(optional)</span></label><textarea id="launch-description" value={draft.description} maxLength={LIMITS.descriptionChars} onChange={e=>set('description',e.target.value)} placeholder="A few words about your coin." rows={2}/>{attempted&&errors.description&&<p className="pl-error">{errors.description}</p>}</div>
   <details className="pl-create-options" open={attempted&&(!!errors.xUrl||!!errors.websiteUrl||!!errors.banner||!!errors.video)||undefined}><summary>Add socials, banner or video</summary><div className="pl-two">{field('xUrl','X profile','https://x.com/yourcoin')}{field('websiteUrl','Website','https://yourcoin.com')}</div><ArtworkUpload kind="banner" label="Banner (optional)" value={draft.banner} onChange={value=>set('banner',value)} onUpload={onUpload} onBusyChange={onMediaBusy} automatic/>{manifest.capabilities?.videoPublication&&<VideoUpload maxBytes={manifest.capabilities?.videoMaxInputBytes} value={draft.video} onChange={value=>set('video',value)} onUpload={onUploadVideo} onBusyChange={onMediaBusy}/>}</details>
   <div className="pl-field"><label htmlFor="launch-size">Launch size</label><select id="launch-size" value={draft.presetId||''} onChange={e=>set('presetId',e.target.value)}><option value="" disabled>Choose a launch size</option>{manifest.presets.map(p=><option key={p.id} value={p.id}>{p.pilotOnly?'Pilot':p.label.replace(/Default public preset/i,'Standard').replace(/Larger preset/i,'Larger')} · {solAmount(p.softLamports).compact}–{solAmount(p.hardLamports).compact} SOL</option>)}</select>{attempted&&errors.preset&&<p className="pl-error">{errors.preset}</p>}<p className="pl-help-text">Funding stays open for {manifest.fundingSeconds/3600||2} hours. If the minimum is not reached, contributors can claim a refund.</p></div>
   <details className="pl-create-options" open={attempted&&!!errors.startUtc||undefined}><summary>Schedule and allocation</summary><label className="pl-publication-consent"><input type="checkbox" checked={draft.start==='scheduled'} onChange={e=>set('start',e.target.checked?'scheduled':'after-creation')}/>Schedule the opening</label>{draft.start==='scheduled'&&<div className="pl-field"><label htmlFor="launch-time">Opening time ({Intl.DateTimeFormat().resolvedOptions().timeZone})</label><input id="launch-time" type="datetime-local" value={localStart} onChange={e=>{setLocalStart(e.target.value);const date=new Date(e.target.value);set('startUtc',Number.isFinite(date.getTime())?date.toISOString().slice(0,16):'');}}/>{attempted&&errors.startUtc&&<p className="pl-error">{errors.startUtc}</p>}</div>}<SupplySplit terms={{supply,vesting:manifest.vesting}}/><p className="pl-help-text">Financial terms are fixed at creation. Trading fee: {manifest.fee.totalBps/100}%. Claims and refunds do not expire.</p></details>
   <div className="pl-create-checkout"><div className="pl-create-total"><span>Creation cost</span><strong>{manifest.costQuote?review.quote.total.compact+' SOL':'Checking…'}</strong></div><p className="pl-help-text">Includes setup and operating reserves. Network fees are additional.</p>
    <details><summary>Cost breakdown</summary>{review.quote.items.map(item=><div className="pl-row" key={item.key}><span>{item.label}</span><strong>{solAmount(item.lamports||'0').compact} SOL</strong></div>)}</details>
    <label className="pl-publication-consent"><input type="checkbox" checked={draft.publicationConsent===true} onChange={e=>set('publicationConsent',e.target.checked)}/><span>{onPrepublish?'I approve permanent publication of these coin details and media. Prepare the image now.':'I approve publishing this coin’s name, ticker and media permanently.'}</span></label>
    {(creationError||attempted&&Object.keys(errors).length>0)&&<p role="alert" className="pl-error">{creationError||'Check the highlighted fields before launching.'}</p>}
    <button className="primary pl-create-submit" type="submit" disabled={busy||uploading||!onCreate||!manifest.costQuote||!draft.publicationConsent}>{creating?'Preparing your launch…':uploading?'Preparing artwork…':saving?'Saving…':'Create coin'}</button>
    {publishKey&&onPrepublish&&<p className="pl-help-text" role="status">{publication?.key===publishKey&&publication.status==='published'?'Artwork ready. One wallet approval to create.':publication?.status==='attention'?'Artwork preparation will retry when you create.':'Preparing your approved artwork… You can keep reviewing the form.'}</p>}
    <p className="pl-help-text" role="status">{saveMessage||(!creator?'Connect your wallet to create a coin.':'Your draft is saved automatically.')}</p>
   </div>
  </form><aside className="pl-create-preview" aria-label="Coin preview"><LiveCoinPreview draft={draft} manifest={manifest} clock={clock}/></aside></div>
 </section>;
}
