// API-side release verification for a hosted public-launch deployment. Dark unless
// KIDS_RELEASE_MANIFEST is set; then the API proves the manifest against the provider
// RPC and the shared registry before it serves anything, and refuses to start otherwise.
import {readFileSync} from 'node:fs';
import {Connection} from '@solana/web3.js';
import {loadReleaseManifest,verifyReleaseManifest} from './release-manifest.mjs';
import {endpointUrl} from '../jobs/service.mjs';
export async function verifyApiRelease({env=process.env,registryImport=null,connectionFactory=url=>new Connection(url,'finalized'),presetsBytes=null,waitMs=15000,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(!env.KIDS_RELEASE_MANIFEST)return {configured:false};
 if(!env.KIDS_RPC_URL)throw Error('KIDS_RPC_URL is required with KIDS_RELEASE_MANIFEST');
 endpointUrl(env.KIDS_RPC_URL,{mode:'hosted',role:'RPC'});
 const manifest=loadReleaseManifest(env.KIDS_RELEASE_MANIFEST);
 // The registry import opens the shared registry on its first run; wait a bounded time for it.
 const deadline=now()+waitMs;let registry=registryImport?.registry??null;
 while(!registry&&now()<deadline){await sleep(250);registry=registryImport?.registry??null;}
 if(!registry)throw Error('Release verification needs the shared registry to be open');
 const bytes=presetsBytes??readFileSync(new URL('../../'+manifest.presets.file,import.meta.url));
 const result=await verifyReleaseManifest(manifest,{connection:connectionFactory(env.KIDS_RPC_URL),presetsBytes:bytes,registrySchemaVersion:await registry.schemaVersion()});
 return {configured:true,network:manifest.network,genesisHash:manifest.genesisHash,programId:manifest.programId,binarySha256:manifest.binarySha256,registrySchemaVersion:manifest.registrySchemaVersion,checks:result.checks};
}
