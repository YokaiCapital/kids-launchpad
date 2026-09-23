import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Keypair,SystemProgram} from '@solana/web3.js';
import {createMetadataInstruction,decodeMetadataInstruction,metadataAddress,tokenBranding,pinTokenMetadata,METADATA_PROGRAM,TEST_TOKEN,LOCALNET_TOKEN} from '../token-metadata.mjs';
test('metadata instruction: immutable, no creators, payer is update authority, fields bounded',()=>{
 const mint=Keypair.generate().publicKey,payer=Keypair.generate().publicKey;
 const ix=createMetadataInstruction({mint,mintAuthority:payer,payer,name:'KIDS test coin',symbol:'KTEST',uri:'https://gateway.pinata.cloud/ipfs/bafyTest'});
 assert.ok(ix.programId.equals(METADATA_PROGRAM));assert.equal(ix.keys.length,6);
 assert.ok(ix.keys[0].pubkey.equals(metadataAddress(mint))&&ix.keys[0].isWritable);assert.ok(ix.keys[1].pubkey.equals(mint));
 assert.ok(ix.keys[2].pubkey.equals(payer)&&ix.keys[2].isSigner);assert.ok(ix.keys[3].pubkey.equals(payer)&&ix.keys[3].isSigner&&ix.keys[3].isWritable);assert.ok(ix.keys[4].pubkey.equals(payer));assert.ok(ix.keys[5].pubkey.equals(SystemProgram.programId));
 const d=decodeMetadataInstruction(ix.data);assert.deepEqual(d,{name:'KIDS test coin',symbol:'KTEST',uri:'https://gateway.pinata.cloud/ipfs/bafyTest',sellerFee:0,creators:0,collection:0,uses:0,isMutable:false,details:0});
 assert.throws(()=>createMetadataInstruction({mint,mintAuthority:payer,payer,name:'x'.repeat(33),symbol:'K',uri:'u'}),/too long/);
 assert.equal(decodeMetadataInstruction(Buffer.from([34,0])),null);assert.equal(decodeMetadataInstruction(Buffer.concat([ix.data,Buffer.from([1])])),null,'trailing bytes refused');
});
test('branding defaults validate; bad symbols and paths are refused',()=>{
 assert.equal(tokenBranding(TEST_TOKEN).symbol,'KTEST');assert.equal(tokenBranding(LOCALNET_TOKEN).image,null);
 assert.throws(()=>tokenBranding({...TEST_TOKEN,symbol:'test'}),/symbol/);assert.throws(()=>tokenBranding({...TEST_TOKEN,image:'../secret.png'}),/image/);assert.throws(()=>tokenBranding({...TEST_TOKEN,name:''}),/name/);
});
test('pinning: image then document, bearer header, gateway URIs, CID validated',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-meta-'));const img=join(dir,'pfp.png');writeFileSync(img,Buffer.from('89504e470d0a1a0a','hex'));
 const calls=[];const fetchImpl=async(url,init)=>{calls.push({url,auth:init.headers.authorization,body:init.body});return {ok:true,status:200,json:async()=>({IpfsHash:calls.length===1?'bafyImageCid1234567890abc':'bafyMetaCid1234567890abcd'})};};
 const out=await pinTokenMetadata({jwt:'x'.repeat(40),token:tokenBranding(TEST_TOKEN),imagePath:img,fetchImpl});
 assert.equal(calls[0].url,'https://api.pinata.cloud/pinning/pinFileToIPFS');assert.equal(calls[0].auth,'Bearer '+'x'.repeat(40));assert.ok(calls[0].body instanceof FormData);
 assert.equal(calls[1].url,'https://api.pinata.cloud/pinning/pinJSONToIPFS');const doc=JSON.parse(calls[1].body).pinataContent;assert.equal(doc.image,'https://gateway.pinata.cloud/ipfs/bafyImageCid1234567890abc.png');assert.equal(doc.symbol,'KTEST');
 assert.equal(out.metadataUri,'https://gateway.pinata.cloud/ipfs/bafyMetaCid1234567890abcd');
 await assert.rejects(pinTokenMetadata({jwt:'x'.repeat(40),token:tokenBranding(TEST_TOKEN),imagePath:img,fetchImpl:async()=>({ok:true,status:200,json:async()=>({IpfsHash:'bad cid'})})}),/CID/);
 await assert.rejects(pinTokenMetadata({jwt:'x'.repeat(40),token:tokenBranding(TEST_TOKEN),imagePath:img,fetchImpl:async()=>({ok:false,status:401,json:async()=>({})})}),/401/);
 await assert.rejects(pinTokenMetadata({jwt:'',token:tokenBranding(TEST_TOKEN),imagePath:img,fetchImpl}),/KIDS_PINATA_JWT/);
});
