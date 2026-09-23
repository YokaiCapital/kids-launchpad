// Coin metadata at creation (owner, 23 September 2026: the first mainnet test coin had no name and no image). The image
// and the metadata document are pinned on Pinata (same provider as Pairz, KIDS_PINATA_JWT server-side) and a Metaplex
// token-metadata account is created in the same transaction that mints the supply, before the mint authority moves to the
// launch-authority PDA. The metadata is immutable. Test campaigns carry a test name and a test image; the real name and
// artwork are set in the campaign plan for the public launch.
import {readFileSync} from 'node:fs';import {extname} from 'node:path';
import {PublicKey,TransactionInstruction,SystemProgram} from '@solana/web3.js';
export const METADATA_PROGRAM=new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const LIMITS=Object.freeze({name:32,symbol:10,uri:200,description:600,imageBytes:2_000_000});
export const PINATA_GATEWAY='https://gateway.pinata.cloud/ipfs/';
export const LOCALNET_TOKEN=Object.freeze({name:'Shartcoin rehearsal',symbol:'SHARTT',description:'Private localnet rehearsal coin. Not the public launch.',image:null});
export const TEST_TOKEN=Object.freeze({name:'KIDS test coin',symbol:'KTEST',description:'Test launch on kids.fun. Not Shartcoin, not the public launch. Trading it has no purpose.',image:'interaction-review/public/assets/kids-test-pfp.png'});
export function metadataAddress(mint){return PublicKey.findProgramAddressSync([Buffer.from('metadata'),METADATA_PROGRAM.toBuffer(),new PublicKey(mint).toBuffer()],METADATA_PROGRAM)[0];}
/** Validates the branding fields of a campaign plan (or the defaults) and returns a frozen copy. */
export function tokenBranding(token){
 const t={...(token||{})};for(const [k,max] of [['name',LIMITS.name],['symbol',LIMITS.symbol],['description',LIMITS.description]]){if(typeof t[k]!=='string'||!t[k].trim()||Buffer.byteLength(t[k])>max)throw Error('Token '+k+' must be 1 to '+max+' bytes');}
 if(!/^[A-Z0-9]{2,10}$/.test(t.symbol))throw Error('Token symbol must be 2 to 10 capitals or digits');
 if(t.image!==null&&t.image!==undefined&&(typeof t.image!=='string'||!/\.(png|jpe?g)$/i.test(t.image)||t.image.includes('..')))throw Error('Token image must be a png or jpeg path inside the repository');
 return Object.freeze({name:t.name,symbol:t.symbol,description:t.description,image:t.image??null});
}
function borshString(s){const b=Buffer.from(s,'utf8');const len=Buffer.alloc(4);len.writeUInt32LE(b.length);return Buffer.concat([len,b]);}
/** Metaplex CreateMetadataAccountV3: immutable data, no creators, no collection, no uses. The update authority is the payer
 * (it signs anyway); with `isMutable=false` nothing about the data can change afterwards. */
export function createMetadataInstruction({mint,mintAuthority,payer,name,symbol,uri}){
 if(Buffer.byteLength(name)>LIMITS.name||Buffer.byteLength(symbol)>LIMITS.symbol||Buffer.byteLength(uri)>LIMITS.uri)throw Error('Metadata field too long');
 const data=Buffer.concat([Buffer.from([33]),borshString(name),borshString(symbol),borshString(uri),Buffer.from([0,0]) /* seller fee bps */,Buffer.from([0]) /* creators: none */,Buffer.from([0]) /* collection: none */,Buffer.from([0]) /* uses: none */,Buffer.from([0]) /* is_mutable: false */,Buffer.from([0]) /* collection details: none */]);
 return new TransactionInstruction({programId:METADATA_PROGRAM,keys:[
  {pubkey:metadataAddress(mint),isSigner:false,isWritable:true},{pubkey:new PublicKey(mint),isSigner:false,isWritable:false},{pubkey:new PublicKey(mintAuthority),isSigner:true,isWritable:false},
  {pubkey:new PublicKey(payer),isSigner:true,isWritable:true},{pubkey:new PublicKey(payer),isSigner:true,isWritable:false} /* update authority */,{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
 ],data});
}
/** Decodes what createMetadataInstruction wrote (used by the signer policy to bound the fields). */
export function decodeMetadataInstruction(data){
 if(data[0]!==33)return null;let o=1;const str=()=>{if(data.length<o+4)throw Error('short');const n=data.readUInt32LE(o);o+=4;if(data.length<o+n)throw Error('short');const s=data.subarray(o,o+n).toString('utf8');o+=n;return s;};
 try{const name=str(),symbol=str(),uri=str();const sellerFee=data.readUInt16LE(o);o+=2;const creators=data[o++],collection=data[o++],uses=data[o++],isMutable=data[o++],details=data[o++];if(o!==data.length)return null;return {name,symbol,uri,sellerFee,creators,collection,uses,isMutable:!!isMutable,details};}catch{return null;}
}
export function metadataDocument(token,imageUri,{website='https://kids.fun'}={}){
 return {name:token.name,symbol:token.symbol,description:token.description,image:imageUri,external_url:website,properties:{files:[{uri:imageUri,type:imageUri.endsWith('.png')?'image/png':'image/jpeg'}],category:'image'}};
}
const cidOf=body=>{const cid=body?.IpfsHash;if(typeof cid!=='string'||!/^[A-Za-z0-9]{20,}$/.test(cid))throw Error('Pinata did not return an IPFS CID');return cid;};
/** Pins the image and the metadata document. Never logs the token; a failed request stored nothing, a timeout may have. */
export async function pinTokenMetadata({jwt,token,imagePath,fetchImpl=globalThis.fetch,endpoint='https://api.pinata.cloud',timeoutMs=30000}){
 if(typeof jwt!=='string'||jwt.length<20)throw Error('KIDS_PINATA_JWT missing');
 const bytes=readFileSync(imagePath);if(bytes.length>LIMITS.imageBytes)throw Error('Token image above 2 MB');
 const ext=extname(imagePath).toLowerCase(),type=ext==='.png'?'image/png':'image/jpeg';
 const form=new FormData();form.append('file',new Blob([bytes],{type}),token.symbol.toLowerCase()+ext);form.append('pinataMetadata',JSON.stringify({name:token.symbol+'-image'}));
 const headers={authorization:'Bearer '+jwt};
 const img=await fetchImpl(endpoint+'/pinning/pinFileToIPFS',{method:'POST',headers,body:form,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
 if(!img.ok)throw Error('Pinata image upload failed ('+img.status+')');const imageCid=cidOf(await img.json()),imageUri=PINATA_GATEWAY+imageCid+ext;
 const doc=metadataDocument(token,imageUri);
 const meta=await fetchImpl(endpoint+'/pinning/pinJSONToIPFS',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({pinataMetadata:{name:token.symbol+'-metadata'},pinataContent:doc}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
 if(!meta.ok)throw Error('Pinata metadata upload failed ('+meta.status+')');const metadataCid=cidOf(await meta.json());
 return {imageCid,imageUri,metadataCid,metadataUri:PINATA_GATEWAY+metadataCid,document:doc};
}
