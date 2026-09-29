// Where creator media (picture, banner, video, poster, parent logo) may load from on the public pages. Links are https-only
// already; media adds a host allow-list so a record cannot make every viewer's browser call an arbitrary host (privacy
// leak, mixed content, bandwidth abuse). Anything outside the list renders the placeholder.
//   * the site's own origin: relative paths (/assets/...) and the deployed hosts (kids.fun and its Vercel alias, see
//     deployment/README.md);
//   * Creator-approved sanitized images are pinned to the existing Pinata gateway.
//     Permit only that exact host and content-address path for sanitized media.
//   * data: URLs of image types only (the local fixtures use inline SVG pictures); never for video.
export const SITE_HOSTS=Object.freeze(['kids.fun','www.kids.fun','kids-fun-flax.vercel.app']);
export const MEDIA_HOSTS=Object.freeze([...SITE_HOSTS,'gateway.pinata.cloud']);
export const IMAGE_DATA_TYPES=Object.freeze(['image/png','image/jpeg','image/webp','image/gif','image/svg+xml']);
export const MAX_DATA_URL_CHARS=262144;
const MAX_URL_CHARS=2048;
const hostAllowed=host=>MEDIA_HOSTS.includes(String(host||'').toLowerCase());
/**
 * One rule for every media field. Returns the URL to render or null (placeholder):
 *   kind 'image' (pfp, banner, poster, logo): same-origin path, https on an allowed host, or a data: image;
 *   kind 'video': same-origin path or https on an allowed host only.
 */
export function safeMediaUrl(value,{kind='image'}={}){
 if(value==null)return null;const s=String(value).trim();if(!s)return null;
 if(/^data:/i.test(s)){
  if(kind!=='image'||s.length>MAX_DATA_URL_CHARS)return null;
  const m=/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[^,]*)?,/i.exec(s);
  return m&&IMAGE_DATA_TYPES.includes(m[1].toLowerCase())?s:null;
 }
 if(s.length>MAX_URL_CHARS||/[\s\\]/.test(s))return null;
 if(s.startsWith('/')){
  if(s.startsWith('//'))return null;
  try{const u=new URL(s,'https://'+SITE_HOSTS[0]);return u.pathname+u.search;}catch{return null;}
 }
 let u;try{u=new URL(s);}catch{return null;}
 if(u.protocol!=='https:'||u.username||u.password||!hostAllowed(u.hostname))return null;
 if(u.hostname==='gateway.pinata.cloud'&&(!/^\/ipfs\/[A-Za-z0-9]{20,120}$/.test(u.pathname)||u.search||u.hash))return null;
 return u.href;
}
/** Content-Security-Policy directives for the flagged build (img-src and media-src only; see vite.config.mjs). */
export function mediaCspDirectives(){
 const hosts=MEDIA_HOSTS.map(h=>'https://'+h).join(' ');
 return "img-src 'self' data: blob: "+hosts+"; media-src 'self' blob: "+MEDIA_HOSTS.map(h=>'https://'+h).join(' ');
}
