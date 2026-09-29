// Private media objects on the service's own volume for the hosted creator flow. Objects are the sanitized image or
// video records the artwork and video services produce; keys are validated, files are 0600 in a 0700 directory, and
// privacy is re-verified from the directory mode. No public URL ever points here: publication goes through Pinata.
import {mkdirSync,statSync,readFileSync,writeFileSync,renameSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
// Keys: the flat form, or exactly the two object shapes the artwork and video services produce (their one slash is
// mapped to a marker no other key can contain).
const key=/^(?:[A-Za-z0-9_.:-]{1,160}|creator-artwork\/[a-f0-9]{64}\.png|creator-video\/[a-f0-9]{64}\.(?:mp4|png))$/;
export function createFileObjectStore({dir}){
 if(typeof dir!=='string'||!dir)throw Error('Media store directory required');
 mkdirSync(dir,{recursive:true,mode:0o700});
 const root=realpathSync(dir),storageId=createHash('sha256').update('kids-media-store-v1:'+root).digest('hex');
 const file=k=>{if(!key.test(k))throw Error('Invalid media object key');return join(root,k.replace(/\//g,'%2F').replace(/[:.]/g,'_')+'.json');};
 // Only the top-level `bytes` field holds binary data; it is stored as base64 explicitly (JSON.stringify would first
 // turn a Buffer into its own object form, which no replacer sees as bytes).
 const encode=object=>JSON.stringify({...object,bytes:Buffer.from(object.bytes).toString('base64')});
 const decode=text=>{const object=JSON.parse(text);if(typeof object?.bytes!=='string')throw Error('Media object is corrupt');return {...object,bytes:Buffer.from(object.bytes,'base64')};};
 return {
  storageId,
  async verifyPrivacy(){const mode=statSync(root).mode&0o777;return mode===0o700;},
  async put(k,object){
   if(!object||typeof object!=='object')throw Error('Media object required');
   const bytes=object.bytes;if(!(bytes instanceof Uint8Array))throw Error('Media object needs bytes');
   const sha256=createHash('sha256').update(bytes).digest('hex');
   if(object.sha256&&object.sha256!==sha256)throw Error('Media object hash differs from its bytes');
   const target=file(k),temp=target+'.tmp-'+process.pid;
   writeFileSync(temp,encode({...object,sha256}),{mode:0o600});renameSync(temp,target);
   return {sha256,byteCount:bytes.length};
  },
  async read(k){const target=file(k);if(!existsSync(target))return null;const object=decode(readFileSync(target,'utf8'));if(object?.bytes&&createHash('sha256').update(object.bytes).digest('hex')!==object.sha256)throw Error('Media object is corrupt');return object;},
 };
}
