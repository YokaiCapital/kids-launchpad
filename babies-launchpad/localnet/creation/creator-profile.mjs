// Publish only creator-approved display fields, backed by immutable publication
// receipts. Private draft notes, object keys, packet bytes and quotas stay private.
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';import {campaignIdentity} from '../registry/registry.mjs';import {PINATA_GATEWAY} from '../token-metadata.mjs';import {validCid} from './pinata.mjs';
const denied=()=>Object.assign(Error('Creator profile publication could not be verified'),{code:'PROFILE_PUBLICATION_CONFLICT'});
function link(value,x=false){if(!value)return null;try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||value.length>2048||x&&!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname))throw denied();return u.href;}catch{throw denied();}}
export function publishedCreatorProfile({intent,accepted,receipts,bannerReceipts=[],allowPendingMedia=false}){
 const m=intent.mint,d=accepted?.draft,q=accepted?.quote;if(!d||canonicalHash(d)!==accepted.draftHash||q?.publicationConsent!==true||q.genesisHash!==m.genesisHash||q.programId!==m.programId||q.terms?.mode!=='standard'||d.name!==m.metadata.name||d.symbol!==m.metadata.symbol||typeof d.description!=='string'||Buffer.byteLength(d.description)>600)throw denied();
 const descriptor=canonicalHash({accepted,owner:m.creator,requestId:m.requestId,assetId:d.pfp?.assetId,imageHash:d.pfp?.sha256});
 const check=(r,hash)=>{if(!r||r.owner!==m.creator||r.request_id!==m.requestId||!['published','sealed'].includes(r.state)||r.descriptor_hash!==descriptor||r.input_hash!==hash||!validCid(r.cid))throw denied();return PINATA_GATEWAY+r.cid;};
 const image=check(receipts.find(r=>r.stage==='image'),d.pfp?.sha256),document=check(receipts.find(r=>r.stage==='document'),m.metadata.documentHash);if(document!==m.metadata.uri)throw denied();
 const optional=(stage,hash)=>{const receipt=bannerReceipts.find(r=>r.stage===stage);if(allowPendingMedia&&(!receipt||receipt.state==='publishing'))return null;return check(receipt,hash);};
 const banner=d.banner?optional('banner',d.banner.sha256):null;
 let video=d.video?optional('video',d.video.sha256):null,poster=d.video?optional('poster',d.video.posterHash):null;
 if(!video||!poster){video=null;poster=null;}
 if(typeof (d.videoCaption??'')!=='string'||(d.videoCaption??'').length>120)throw denied();
 return {name:d.name,symbol:d.symbol,description:d.description,media:{pfp:image,banner,video,poster,videoCaption:video?(d.videoCaption??''):''},links:{x:link(d.xUrl,true),website:link(d.websiteUrl)}};
}
export async function publishCreatorProfile({registry,id,intent,signature,allowPendingMedia=false}){
 campaignIdentity(id);const m=intent.mint;if(m.genesisHash!==id.genesisHash||m.programId!==id.programId||m.campaign!==id.campaign)throw denied();
 const q=(s,p=[])=>registry.query(s,p),request=(await q("SELECT body FROM creation_requests WHERE request_id=? AND owner=? AND state='accepted'",[m.requestId,m.creator])).rows[0];if(!request)throw denied();
 const profile=publishedCreatorProfile({intent,allowPendingMedia,accepted:JSON.parse(request.body),receipts:(await q('SELECT * FROM creation_publications WHERE request_id=?',[m.requestId])).rows,bannerReceipts:(await q('SELECT * FROM creation_media_publications WHERE request_id=?',[m.requestId])).rows});
 await q("INSERT INTO campaign_profiles(genesis_hash,program_id,campaign,revision,authorized_creator,authorization_ref,name,symbol,description,media_json,links_json,moderation_state,created_at) VALUES(?,?,?,1,?,?,?,?,?,?,?,'published',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) ON CONFLICT(genesis_hash,program_id,campaign,revision) DO NOTHING",[id.genesisHash,id.programId,id.campaign,m.creator,signature,profile.name,profile.symbol,profile.description,canonicalJson(profile.media),canonicalJson(profile.links)]);
 // Supplement only the original approved profile, never a later creator edit or a moderated record.
 await q("UPDATE campaign_profiles SET media_json=? WHERE genesis_hash=? AND program_id=? AND campaign=? AND revision=1 AND authorized_creator=? AND authorization_ref=? AND moderation_state='published' AND NOT EXISTS(SELECT 1 FROM campaign_profiles newer WHERE newer.genesis_hash=? AND newer.program_id=? AND newer.campaign=? AND newer.revision>1)",[canonicalJson(profile.media),id.genesisHash,id.programId,id.campaign,m.creator,signature,id.genesisHash,id.programId,id.campaign]);
}
export function createCreatorProfileReader(registry){
 return {async read(id){campaignIdentity(id);const row=(await registry.query('SELECT p.* FROM campaign_profiles p JOIN campaigns c ON c.genesis_hash=p.genesis_hash AND c.program_id=p.program_id AND c.campaign=p.campaign WHERE p.genesis_hash=? AND p.program_id=? AND p.campaign=? AND c.creator=p.authorized_creator ORDER BY p.revision DESC LIMIT 1',[id.genesisHash,id.programId,id.campaign])).rows[0];if(!row||row.moderation_state!=='published')return null;const media=JSON.parse(row.media_json),links=JSON.parse(row.links_json);return {name:row.name,symbol:row.symbol,description:row.description,media:{pfp:media.pfp??null,banner:media.banner??null,video:media.video??null,poster:media.poster??null,videoCaption:media.videoCaption??''},links:{x:links.x??null,website:links.website??null}};}};
}
