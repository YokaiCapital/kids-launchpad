// Creator wizard draft: pure state, validation and the review model (UI spec §4). Nothing here signs or submits.
// Limits are the spec's proposed product limits; the server must enforce the same validated byte limits.
import {formatUtc,formatLocal,percentOfBps,solAmount,supplySplit} from './campaign-adapter.mjs';

export const LIMITS={nameBytes:32,symbolBytes:10,descriptionChars:280,captionChars:120,pfpBytes:10*1024*1024,videoBytes:100*1024*1024,videoSeconds:120};
export const STEPS=[{key:'coin',title:'Coin',heading:'What are you launching?'},{key:'profile',title:'Profile',heading:'Give your coin an identity.'},{key:'terms',title:'Terms',heading:'Choose your launch size.'},{key:'review',title:'Review',heading:'Review your launch.'}];

export function utf8Bytes(text){return new TextEncoder().encode(String(text??'')).length;}

export function initialDraft(manifest,{creator=null}={}){
 // Only a preset the manifest marks as default is preselected; otherwise the creator chooses the launch size first
 // (28 September 2026: the first preset's caps showed before any choice was made).
 const preset=(manifest?.presets||[]).find(p=>p.default)||null;
 return {version:1,step:0,mode:'standard',name:'',symbol:'',parents:[null,null],creator,
  pfp:null,banner:null,description:'',xUrl:'',websiteUrl:'',video:null,videoCaption:'',publicationConsent:false,
  presetId:preset?.id||null,start:'after-creation',startUtc:'',devBeneficiary:creator||null};
}

/** X links: https, host x.com or twitter.com (with or without www), one path segment that looks like a handle. */
export function validateXUrl(value){
 const v=String(value||'').trim();if(!v)return null;
 let u;try{u=new URL(v);}catch{return 'Enter a full link starting with https://';}
 if(u.protocol!=='https:')return 'Links must start with https://';
 const host=u.hostname.replace(/^www\./,'');
 if(!['x.com','twitter.com'].includes(host))return 'Use a link on x.com';
 if(!/^\/[A-Za-z0-9_]{1,15}\/?$/.test(u.pathname)||u.search||u.hash)return 'Link to a profile, like https://x.com/yourcoin';
 return null;
}
export function validateHttpsUrl(value){
 const v=String(value||'').trim();if(!v)return null;
 let u;try{u=new URL(v);}catch{return 'Enter a full link starting with https://';}
 if(u.protocol!=='https:')return 'Links must start with https://';
 if(!u.hostname.includes('.')||u.username||u.password)return 'That link does not look like a website address';
 return null;
}

export function validateCoin(draft){
 const errors={};
 const name=String(draft.name||''),symbol=String(draft.symbol||'');
 if(!name.trim())errors.name='Give the coin a name';
 else if(utf8Bytes(name)>LIMITS.nameBytes)errors.name='Name is too long: '+utf8Bytes(name)+' of '+LIMITS.nameBytes+' bytes';
 if(!symbol.trim())errors.symbol='Give the coin a ticker';
 else if(/\s/.test(symbol))errors.symbol='Ticker cannot contain spaces';
 else if(utf8Bytes(symbol)>LIMITS.symbolBytes)errors.symbol='Ticker is too long: '+utf8Bytes(symbol)+' of '+LIMITS.symbolBytes+' bytes';
 if(draft.mode==='family'){
  const [a,b]=draft.parents||[];
  if(!a||!b)errors.parents='Choose two parent communities';
  else if(a.mint===b.mint)errors.parents='Choose two different parent mints';
  else if(!a.verified||!b.verified)errors.parents='Both parents must be verified mints';
  else if(a.unsupportedReason||b.unsupportedReason)errors.parents=a.unsupportedReason||b.unsupportedReason;
 }
 return errors;
}
export function validateProfile(draft){
 const errors={};
 if(utf8Bytes(draft.description)>600)errors.description='Shorten the description before launching.';
 else if(String(draft.description||'').length>LIMITS.descriptionChars)errors.description='Keep the introduction to '+LIMITS.descriptionChars+' characters';
 const x=validateXUrl(draft.xUrl);if(x)errors.xUrl=x;
 const w=validateHttpsUrl(draft.websiteUrl);if(w)errors.websiteUrl=w;
 if(String(draft.videoCaption||'').length>LIMITS.captionChars)errors.videoCaption='Keep the caption to '+LIMITS.captionChars+' characters';
 if(draft.pfp&&draft.pfp.error)errors.pfp=draft.pfp.error;
 if(draft.banner&&draft.banner.error)errors.banner=draft.banner.error;
 if(draft.video&&draft.video.error)errors.video=draft.video.error;
 return errors;
}
/** Parses 'YYYY-MM-DDTHH:MM' as UTC (the field is labelled UTC). Returns Unix seconds or null. */
export function parseUtcInput(text){
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(text||'').trim());if(!m)return null;
 const t=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5]);if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,16)!==m[0])return null;return Math.floor(t/1000);
}
export function validateTerms(draft,manifest,nowUnix){
 const errors={};
 if(!draft.presetId||!(manifest?.presets||[]).some(p=>p.id===draft.presetId))errors.preset='Choose a launch size';
 if(draft.start==='scheduled'){
  const at=parseUtcInput(draft.startUtc);
  if(at==null)errors.startUtc='Enter the opening time in UTC as YYYY-MM-DDTHH:MM';
  else if(at<=nowUnix)errors.startUtc='The opening time must be in the future';
 }
 return errors;
}
export function stepErrors(draft,manifest,nowUnix){return [validateCoin(draft),validateProfile(draft),validateTerms(draft,manifest,nowUnix),{}];}
export function canContinue(draft,manifest,nowUnix){return Object.keys(stepErrors(draft,manifest,nowUnix)[draft.step]||{}).length===0;}

/** Funding start, close and the separate launch deadline for the chosen start option. */
export function schedule(draft,manifest,nowUnix){
 const opensAt=draft.start==='scheduled'?parseUtcInput(draft.startUtc):null;
 const funding=manifest?.fundingSeconds??7200,window=manifest?.launchWindowSeconds??7200;
 const startUnix=opensAt??nowUnix;
 return {opensAtUnix:opensAt,startLabel:opensAt?formatUtc(opensAt):'When creation confirms',deadlineUnix:startUnix+funding,launchDeadlineUnix:startUnix+funding+window,fundingSeconds:funding,launchWindowSeconds:window,closeUtc:formatUtc(startUnix+funding),closeLocal:formatLocal(startUnix+funding),estimated:!opensAt};
}
export function selectedPreset(draft,manifest){return (manifest?.presets||[]).find(p=>p.id===draft.presetId)||null;}
export function draftTerms(draft,manifest){
 const preset=selectedPreset(draft,manifest);if(!preset)return null;
 const supply=manifest.supply[draft.mode]||manifest.supply.standard;
 return {softLamports:preset.softLamports,hardLamports:preset.hardLamports,supply:{...supply,totalBaseUnits:manifest.supply.totalBaseUnits,decimals:manifest.supply.decimals},vesting:manifest.vesting,fee:manifest.fee};
}
/** Everything the review step shows, in display form, plus the cost quote split into its three kinds (spec §4 step 4). */
export function reviewModel(draft,manifest,nowUnix){
 const preset=selectedPreset(draft,manifest),terms=draftTerms(draft,manifest),sched=schedule(draft,manifest,nowUnix);
 const split=terms?supplySplit(terms):null;
 const quote=manifest?.costQuote||{items:[]};
 const sum=kind=>quote.items.filter(i=>i.kind===kind).reduce((n,i)=>n+BigInt(i.lamports||'0'),0n);
 return {
  identity:{name:draft.name,symbol:draft.symbol,mode:draft.mode,parents:draft.mode==='family'?draft.parents.filter(Boolean):[]},
  caps:preset?{soft:solAmount(preset.softLamports),hard:solAmount(preset.hardLamports),label:preset.label}:null,
  schedule:sched,
  supply:split,
  fee:manifest?.fee?{label:'Trading fee: '+percentOfBps(manifest.fee.totalBps)+' total · network fees extra',tokenSide:manifest.fee.tokenSide,routing:manifest.fee.solRouting?.[draft.mode]||null}:null,
  addresses:{creator:draft.creator,devBeneficiary:draft.devBeneficiary||draft.creator,treasury:manifest?.treasury||null},
  quote:{validForSeconds:quote.validForSeconds??null,items:quote.items,refundable:solAmount(sum('refundable')),consumed:solAmount(sum('consumed')),charge:solAmount(sum('charge')),total:solAmount(sum('refundable')+sum('consumed')+sum('charge'))},
  sealingSentence:'Creating this launch fixes its financial terms, including its scheduled dates.',
 };
}

export function reduceDraft(draft,action){
 switch(action.type){
  case 'set':return {...draft,[action.field]:action.value,...(['name','symbol','description','pfp','banner','video','xUrl','websiteUrl'].includes(action.field)?{publicationConsent:false}:{})};
  case 'mode':return {...draft,mode:action.value,parents:action.value==='family'?draft.parents:[null,null]};
  case 'parent':{const parents=[...draft.parents];parents[action.index]=action.value;return {...draft,parents};}
  case 'step':return {...draft,step:Math.max(0,Math.min(STEPS.length-1,action.value))};
  case 'next':return {...draft,step:Math.min(STEPS.length-1,draft.step+1)};
  case 'back':return {...draft,step:Math.max(0,draft.step-1)};
  default:return draft;
 }
}
