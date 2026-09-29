// Launch readiness of a creator-flow campaign's metadata: both receipts (image, document) must be pinned and content-verified
// ('published') before the token is created with its URI. A sealed receipt names the final URI, which is identity, not
// availability, so it does not launch. A campaign without a creator-flow preparation is not tracked here: its URI was
// verified at registration by the older path, and there is nothing to wait for.
import {PINATA_GATEWAY} from '../token-metadata.mjs';
import {validCid} from './pinata.mjs';
export function createPublicationReadiness(registry){
 if(typeof registry?.query!=='function')throw Error('Publication readiness needs the registry');
 return {async read(id){
  for(const k of ['genesisHash','programId','campaign'])if(typeof id?.[k]!=='string'||!id[k])throw Error('Publication readiness needs the campaign identity');
  const prep=(await registry.query('SELECT request_id FROM creation_preparations WHERE genesis_hash=? AND program_id=? AND campaign=?',[id.genesisHash,id.programId,id.campaign])).rows[0];
  if(!prep)return {tracked:false,ready:true,requestId:null,image:null,document:null,uri:null,attention:false,pending:[]};
  const rows=(await registry.query('SELECT stage,state,cid FROM creation_publications WHERE request_id=?',[prep.request_id])).rows;
  const state=stage=>rows.find(r=>r.stage===stage)?.state??'missing',image=state('image'),document=state('document'),doc=rows.find(r=>r.stage==='document');
  const pending=['image','document'].filter(stage=>state(stage)!=='published');
  return {tracked:true,requestId:prep.request_id,ready:pending.length===0,image,document,uri:doc&&validCid(doc.cid)?PINATA_GATEWAY+doc.cid:null,attention:[image,document].includes('attention'),pending};
 }};
}
