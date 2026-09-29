import {randomUUID} from 'node:crypto';
// All calls are dispatched AFTER AccountStore authentication, origin checks and (for writes) CSRF validation.
// A caller cannot choose a different owner in the request body.
import {createPublicLaunchAccess} from './public-launch-access.mjs';
import {validateProfile,parseUtcInput} from '../src/public/launch-draft.mjs';
import {safeMediaUrl} from '../src/public/media-hosts.mjs';
const FIELDS=['step','mode','name','symbol','description','xUrl','websiteUrl','videoCaption','presetId','start','startUtc'];
export function cleanDraft(input,owner){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Draft required');
 const out={version:1,creator:owner,devBeneficiary:owner,parents:[null,null],publicationConsent:input.publicationConsent===true};
 for(const field of FIELDS){const v=input[field];if(field==='step'){out.step=Number.isInteger(v)?Math.max(0,Math.min(3,v)):0;continue;}out[field]=typeof v==='string'?v:'';}
 if(!['standard','family'].includes(out.mode))throw Error('Unknown launch type');
 if(out.mode==='family')throw Error('New Family launches are not enabled yet');
 for(const field of ['pfp','banner','video']){
  const v=input[field];out[field]=null;
  if(v?.assetId){
   if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(v.assetId)||!/^[a-f0-9]{64}$/.test(v.sha256??''))throw Error('Upload '+field+' before saving');
   if(field==='video'&&!/^[a-f0-9]{64}$/.test(v.posterHash??''))throw Error('Upload video before saving');
   out[field]={assetId:v.assetId,sha256:v.sha256,...(field==='video'?{posterHash:v.posterHash}:{}),url:'/api/account/launches/'+(field==='video'?'video/':'artwork/')+encodeURIComponent(v.assetId)};continue;
  }
  if(v?.url){if(!/^https:\/\//.test(v.url)||v.url.length>2048||!safeMediaUrl(v.url,{kind:field==='video'?'video':'image'}))throw Error('Upload '+field+' before saving');out[field]={url:v.url,name:String(v.name||'').slice(0,120),size:Number.isSafeInteger(v.size)&&v.size>=0?v.size:0};}
 }
 if(out.presetId.length>128||out.startUtc.length>32||!['after-creation','scheduled'].includes(out.start))throw Error('Invalid draft terms');
 // Incomplete drafts are allowed; bounded fields/URLs are enforced even before the review step.
 if(new TextEncoder().encode(out.name).length>32||new TextEncoder().encode(out.symbol).length>10)throw Error('Name or ticker is too long');
 const errors=validateProfile(out);if(Object.keys(errors).length)throw Error(Object.values(errors)[0]);
 if(out.start==='scheduled'&&out.startUtc&&!parseUtcInput(out.startUtc))throw Error('Invalid UTC start time');
 return out;
}
export async function verifyOwnedArtwork(draft,owner,artwork,{required=false}={}){
 for(const field of ['pfp','banner']){
  const value=draft[field];if(!value){if(required&&field==='pfp')throw Error('Upload the coin picture before review');continue;}
  if(!value.assetId){if(required)throw Error('Upload '+field+' to private artwork storage before review');continue;}
  const asset=await artwork?.status(owner,value.assetId);
  if(!asset||asset.status!=='ready'||asset.kind!==field||asset.sha256!==value.sha256)throw Error('Upload '+field+' before saving');
 }
}
export async function verifyOwnedVideo(draft,owner,video,{required=false}={}){
 if(!draft.video)return;const value=draft.video;if(!value.assetId){if(required)throw Error('Upload video to private storage before review');return;}
 const asset=await video?.status(owner,value.assetId);if(!asset||asset.status!=='ready'||asset.sha256!==value.sha256||asset.posterHash!==value.posterHash)throw Error('Upload video before saving');
}
const conflictCodes=new Set(['REVISION_CONFLICT','IDEMPOTENCY_CONFLICT','QUOTE_EXPIRED','CREATION_STARTED','CAPACITY_WAIT']);
export function createPublicLaunchAccount({registry,video=null,actions=null,creation=null,publication=null,creatorFlow=null,provisioning=null,artwork=null,marketReader=null,activityReader=null,portfolioReader=null,creatorOperationsReader=null,trades=null,readPositions=null,access=createPublicLaunchAccess()}){
 const getRegistry=()=>typeof registry==='function'?registry():registry;
 return {canAccess:owner=>access.allows(owner),canUploadVideo:owner=>!!video&&access.allows(owner),async handle({method,path,owner,input={}}){
  if(!owner)return {status:401,body:{error:'Sign in with a wallet first'}};
  if(!access.allows(owner))return {status:403,body:{error:'Launch pilot unavailable for this wallet'}};
  const r=getRegistry();if(!r)return {status:503,body:{error:'Campaign registry unavailable'}};
  try{
   if(method==='GET'&&path==='/api/account/launches/drafts')return {status:200,body:{drafts:await r.drafts.list(owner)}};
   if(method==='POST'&&path==='/api/account/launches/drafts/save'){const draft=cleanDraft(input.draft,owner);await verifyOwnedArtwork(draft,owner,artwork);await verifyOwnedVideo(draft,owner,video);return {status:200,body:{draft:await r.drafts.save({creator:owner,id:input.id,revision:input.revision,body:draft})}};}
   if(method==='POST'&&path==='/api/account/launches/video/upload'){if(!video)return {status:503,body:{error:'Video uploads are not enabled'}};return {status:200,body:{video:await video.upload(owner,input)}};}
   if(method==='GET'&&/^\/api\/account\/launches\/video\/[A-Za-z0-9_.:-]{1,128}(?:\/poster)?$/.test(path)){if(!video)return {status:503,body:{error:'Video unavailable'}};const parts=path.split('/'),item=await video.loadOwnedVideo({owner,assetId:parts[5]});const result=parts[6]==='poster'?item.poster:item;return {status:200,binary:result.bytes,contentType:result.contentType};}
   if(method==='POST'&&path==='/api/account/launches/artwork/upload'){
    if(!artwork)return {status:503,body:{error:'Private artwork uploads are not enabled'}};
    return {status:200,body:{artwork:await artwork.upload(owner,input)}};
   }
   if(method==='GET'&&/^\/api\/account\/launches\/artwork\/[A-Za-z0-9_.:-]{1,128}$/.test(path)){
    if(!artwork)return {status:503,body:{error:'Private artwork is not enabled'}};
    const image=await artwork.loadOwnedImage({owner,assetId:path.split('/').at(-1)});
    return {status:200,binary:image.bytes,contentType:'image/png'};
   }
   if(['GET','POST'].includes(method)&&path==='/api/account/launches/positions')return {status:200,body:readPositions?await readPositions(owner,input):{owner,available:false,positions:{},balanceLamports:null}};
   if(method==='POST'&&path==='/api/account/launches/operations/read'){
    if(!creatorOperationsReader)return {status:503,body:{error:'Creator operations are not enabled'}};
    return {status:200,body:await creatorOperationsReader.read(owner,input)};
   }
   if(method==='POST'&&path==='/api/account/launches/portfolio/read'){
    if(!portfolioReader)return {status:503,body:{error:'Portfolio discovery is not enabled'}};
    return {status:200,body:await portfolioReader.read(owner,input)};
   }
   if(method==='POST'&&path==='/api/account/launches/activity/read'){
    if(!activityReader)return {status:503,body:{error:'Shared activity is not enabled'}};
    return {status:200,body:await activityReader.read(input)};
   }
   if(method==='POST'&&path==='/api/account/launches/market/read'){
    if(!marketReader)return {status:503,body:{error:'Shared market data is not enabled on this service'}};
    return {status:200,body:await marketReader.read(input)};
   }
   if(method==='POST'&&/^\/api\/account\/launches\/trade\/(prepare|submit|status|cancel|resume)$/.test(path)){
    if(!trades)return {status:503,body:{error:'Coin trading is not enabled on this service'}};
    return {status:200,body:await trades[path.split('/').at(-1)](owner,input)};
   }
   if(method==='POST'&&path==='/api/account/launches/creation/artwork'){
    if(!publication)return {status:503,body:{error:'Artwork preparation is unavailable'}};
    return {status:200,body:await publication.prepareDraft(owner,input)};
   }
   if(method==='POST'&&/^\/api\/account\/launches\/creation\/(quote|accept|prepare|status)$/.test(path)){
    if(!creation)return {status:503,body:{error:'Launch creation is not enabled on this service'}};
    return {status:200,body:await creation[path.split('/').at(-1)](owner,input)};
   }
   if(method==='POST'&&path==='/api/account/launches/creation/flow/report'){
    // The page reports a failed creator step (a wallet refusal, a changed transaction) so its cause is in the server log.
    const text=v=>typeof v==='string'?v:null;
    console.error(JSON.stringify({event:'creator-client-error',owner,requestId:text(input?.requestId)?.slice(0,128)??null,stage:text(input?.stage)?.slice(0,40)??null,message:text(input?.message)?.slice(0,300)??null,at:new Date().toISOString()}));
    return {status:200,body:{ok:true}};
   }
   if(method==='POST'&&/^\/api\/account\/launches\/creation\/flow\/(prepare|submit|status|resume|recover)$/.test(path)){
    if(!creatorFlow)return {status:503,body:{error:'Creator flow is not enabled on this service'}};
    return {status:200,body:await creatorFlow[path.split('/').at(-1)](owner,input)};
   }
   if(method==='POST'&&/^\/api\/account\/launches\/creation\/setup\/(prepare|submit|status|resume|recover)$/.test(path)){
    if(!provisioning)return {status:503,body:{error:'Creator setup is not enabled on this service'}};
    return {status:200,body:await provisioning[path.split('/').at(-1)](owner,input)};
   }
   if(method==='POST'&&/^\/api\/account\/launches\/(prepare|submit|status|cancel)$/.test(path)){
    if(!actions)return {status:503,body:{error:'Launch transactions are not enabled on this service'}};
    const action=path.split('/').at(-1);return {status:200,body:await actions[action](owner,input)};
   }
   return {status:404,body:{error:'Not found'}};
  }catch(e){if(e.code==='CAPACITY_WAIT')return {status:503,body:{error:'This read is temporarily busy. Try again shortly.'}};
   // Media outcomes carry their own plain message: busy (retry shortly), daily allowance, still processing, conflict.
   if(typeof e.code==='string'&&e.code.startsWith('MEDIA_'))return {status:e.code==='MEDIA_BUSY'?503:e.code==='MEDIA_QUOTA'?429:409,body:{error:e.message,code:e.code}};
   if(typeof e.code==='string'&&e.code.startsWith('PUBLICATION_'))return {status:e.code==='PUBLICATION_QUOTA'?429:409,body:{error:e.message,code:e.code}};
   // An unexpected failure is logged with a short reference that the creator sees, so its cause can be found.
   if(!e.code||!conflictCodes.has(e.code)){const ref=randomUUID().slice(0,8);console.error(JSON.stringify({event:'launch-request-failed',ref,path,owner,code:e.code??null,message:String(e?.message??e).slice(0,300),at:new Date().toISOString()}));e.ref=ref;}const conflicts={REVISION_CONFLICT:'This draft changed. Reload it before continuing.',IDEMPOTENCY_CONFLICT:'This request already belongs to different terms.',QUOTE_EXPIRED:'The setup quote expired. Refresh it before continuing.',CREATION_STARTED:'Creation already started for this draft. Resume the existing request.'};return {status:conflicts[e.code]?409:400,body:{error:e.publicMessage||conflicts[e.code]|| (path.endsWith('/drafts/save')&&/Draft|draft|Name|ticker|Name|launch type|Family|Upload|UTC|profile|Links|link|Description|caption/i.test(e.message)?e.message:'Launch request could not be completed'+(e.ref?' (reference '+e.ref+')':''))}};}
 }};
}
