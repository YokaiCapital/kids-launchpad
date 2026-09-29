// The IPFS content id (CIDv0) of a small file exactly as the default `ipfs add` (and the pinning provider with default
// options) computes it: one UnixFS file node in a dag-pb block, sha2-256, base58. Only a single chunk (at most 262,144
// bytes) is computed here; a larger file has a balanced DAG whose shape this module does not claim to reproduce. The
// metadata document of a coin is always a single chunk, so its CID is known the moment its canonical bytes are, before any
// provider is called; the provider's answer is later compared with it and a difference is an alert, never a silent switch.
// Vectors reproduced: the empty file, 'hello world', 'hello world' with a newline.
import {createHash} from 'node:crypto';
import {encodeBase58} from '../../shared/solana.mjs';
export const IPFS_CHUNK_BYTES=262144;
const varint=n=>{const out=[];while(n>=0x80){out.push((n&0x7f)|0x80);n=Math.floor(n/128);}out.push(n);return Buffer.from(out);};
const field=(number,wire,payload)=>Buffer.concat([varint((number<<3)|wire),...(wire===2?[varint(payload.length),payload]:[payload])]);
/** UnixFS Data message of a file: Type=File (field 1), Data (field 2, absent when empty), filesize (field 3). */
const unixfsFile=data=>Buffer.concat([field(1,0,varint(2)),...(data.length?[field(2,2,data)]:[]),field(3,0,varint(data.length))]);
/** dag-pb node with no links: Data (field 1). */
const dagPbNode=data=>field(1,2,data);
export function cidV0(bytes){
 if(!Buffer.isBuffer(bytes)&&!(bytes instanceof Uint8Array))throw Error('CID needs bytes');
 const data=Buffer.from(bytes);
 if(data.length>IPFS_CHUNK_BYTES)throw Error('CID computed for single-chunk files only (at most '+IPFS_CHUNK_BYTES+' bytes)');
 const node=dagPbNode(unixfsFile(data));
 return encodeBase58(Buffer.concat([Buffer.from([0x12,0x20]),createHash('sha256').update(node).digest()]));
}
