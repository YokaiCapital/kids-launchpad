// Pinata endpoints and staged accounting contract. Credentials stay
// server-side. A provider timeout is ambiguous: callers must journal before POST.
import {createHash} from 'node:crypto';
import {canonicalHash} from '../registry/canonical.mjs';
import {PINATA_GATEWAY} from '../token-metadata.mjs';
import {VIDEO_MAX_OUTPUT_BYTES} from './video-policy.mjs';
export const contentHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const validCid=cid=>typeof cid==='string'&&(/^[Q][m][1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)||/^b[a-z2-7]{20,90}$/.test(cid));
const failure=()=>Object.assign(Error('Metadata provider unavailable; publication needs reconciliation'),{code:'PUBLICATION_UNCERTAIN'});
// A sealed receipt names the content id the exact bytes must have (creation/ipfs-cid.mjs); a provider that answers another id
// is a deterministic contradiction, not an outage: the caller alerts and never adopts the provider's id in its place.
const mismatch=(stage,cid)=>Object.assign(Error('Metadata provider pinned '+(validCid(cid)?cid:'an invalid content id')+' where the sealed content id is '+stage.cid),{code:'PUBLICATION_CID_MISMATCH',sealedCid:stage.cid,providerCid:validCid(cid)?cid:null});

export function createPinataProvider({jwt,fetchImpl=globalThis.fetch,timeoutMs=20000}){
 if(typeof jwt!=='string'||jwt.length<20||/[\r\n]/.test(jwt))throw Error('Server-side Pinata credential required');
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw Error('Bounded Pinata timeout required');
 async function request(url,options,maxBytes,json=true){
  try{
   const response=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
   if(!response.ok)throw failure();
   if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw failure();}
   const reader=response.body?.getReader();if(!reader)throw failure();
   const chunks=[];let size=0;
   try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw failure();chunks.push(value);}}
   catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=Buffer.concat(chunks);return json?JSON.parse(bytes.toString('utf8')):bytes;
  }catch{throw failure();} // Never expose JWT, provider URL or provider response body.
 }
 const keys=stage=>({kidsOperation:stage.operationId,kidsContentSha256:stage.inputHash});
 const checked=stage=>{
  if(!/^[a-f0-9]{64}$/.test(stage?.operationId||'')||!/^[a-f0-9]{64}$/.test(stage.inputHash||'')||!['image','document','banner','video','poster'].includes(stage.stage))throw Error('Invalid publication stage');
  if(stage.cid!==undefined&&!validCid(stage.cid))throw Error('Invalid sealed content id');
 };
 async function verify(stage,cid){
  checked(stage);if(!validCid(cid))throw failure();
  const body=await request(PINATA_GATEWAY+cid,{method:'GET'},stage.stage==='video'?VIDEO_MAX_OUTPUT_BYTES:stage.stage!=='document'?2_000_000:16384,stage.stage==='document');
  const hash=stage.stage!=='document'?contentHash(body):canonicalHash(body);
  if(hash!==stage.inputHash)throw failure();
  return {cid,uri:PINATA_GATEWAY+cid,inputHash:hash};
 }
 return {
  verify,
  async publish(stage){
   checked(stage);const metadata={name:'kids-'+stage.operationId,keyvalues:keys(stage)},form=new FormData();
   if(stage.stage!=='document'){
    if(!Buffer.isBuffer(stage.bytes)||stage.bytes.length>(stage.stage==='video'?VIDEO_MAX_OUTPUT_BYTES:2_000_000)||contentHash(stage.bytes)!==stage.inputHash||!(stage.stage==='video'?stage.contentType==='video/mp4':['image/png','image/jpeg'].includes(stage.contentType)))throw Error('Invalid image publication');
    form.append('file',new Blob([stage.bytes],{type:stage.contentType}),'coin.'+(stage.stage==='video'?'mp4':stage.contentType==='image/png'?'png':'jpg'));
   }else{
    // The document is pinned as an exact file of its canonical bytes, never re-serialized by the provider, so the content
    // id of those bytes is computable here first (ipfs-cid.mjs) and a sealed receipt can hold the provider to it.
    if(!Buffer.isBuffer(stage.bytes)||stage.bytes.length>16384||canonicalHash(stage.document)!==stage.inputHash)throw Error('Invalid metadata publication');
    let parsed=null;try{parsed=JSON.parse(stage.bytes.toString('utf8'));}catch{parsed=null;}
    if(parsed===null||canonicalHash(parsed)!==stage.inputHash)throw Error('Invalid metadata publication');
    form.append('file',new Blob([stage.bytes],{type:'application/json'}),'metadata.json');
   }
   form.append('pinataMetadata',JSON.stringify(metadata));form.append('pinataOptions',JSON.stringify({cidVersion:0}));
   const result=await request('https://api.pinata.cloud/pinning/pinFileToIPFS',{method:'POST',headers:{authorization:'Bearer '+jwt},body:form},16384);
   if(stage.cid!==undefined&&result?.IpfsHash!==stage.cid)throw mismatch(stage,result?.IpfsHash);
   // Resolve and compare the actual immutable content before marking it published (at the sealed id when there is one).
   return verify(stage,stage.cid??result.IpfsHash);
  },
  async recover(stage){
   checked(stage);
   const query=new URLSearchParams({status:'pinned',pageLimit:'2',pageOffset:'0',includeCount:'true','metadata[keyvalues]':JSON.stringify({kidsOperation:{value:stage.operationId,op:'eq'}})});
   const result=await request('https://api.pinata.cloud/data/pinList?'+query,{method:'GET',headers:{authorization:'Bearer '+jwt}},16384);
   if(!Array.isArray(result.rows)||result.rows.length>1||(result.count!==undefined&&result.count!==result.rows.length))throw failure();
   if(!result.rows.length)return null; // Absence is NOT permission to POST again.
   const row=result.rows[0];if(row.date_unpinned||row.metadata?.keyvalues?.kidsOperation!==stage.operationId||row.metadata?.keyvalues?.kidsContentSha256!==stage.inputHash)throw failure();
   if(stage.cid!==undefined&&row.ipfs_pin_hash!==stage.cid)throw mismatch(stage,row.ipfs_pin_hash);
   return verify(stage,stage.cid??row.ipfs_pin_hash);
  },
 };
}
