// Version-3 policy signer service (KIDS_ROLE=signer-v3): its own Railway service and volume, private network only.
// The signer key arrives ONCE through the KIDS_SIGNER_KEY_JSON secret, is written to the volume (0600) and the variable
// should then be removed by the owner. Everything else (registry, RPC, release manifest, token, config) comes from the
// environment; the process proves the release before it listens. Never prints a key or an RPC URL.
import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
const dir=process.env.KIDS_SIGNER_V3_DIR||'/data/signer-v3';mkdirSync(dir,{recursive:true,mode:0o700});
const keyFile=process.env.KIDS_SIGNER_KEY_FILE||dir+'/signer-keypair.json';
if(!existsSync(keyFile)){
 const raw=process.env.KIDS_SIGNER_KEY_JSON;if(!raw)throw Error('KIDS_SIGNER_KEY_JSON is required on the first boot of the version-3 signer');
 const bytes=JSON.parse(raw);if(!Array.isArray(bytes)||bytes.length!==64)throw Error('Signer key must be a 64-byte array');
 writeFileSync(keyFile,JSON.stringify(bytes),{mode:0o600});console.log(JSON.stringify({event:'signer-v3-key-stored'}));
}else if(process.env.KIDS_SIGNER_KEY_JSON)console.log(JSON.stringify({event:'signer-key-variable-still-present',note:'remove KIDS_SIGNER_KEY_JSON from the service variables'}));
delete process.env.KIDS_SIGNER_KEY_JSON;
const env={...process.env,KIDS_SIGNER_KEY_FILE:keyFile,KIDS_SIGNER_STATE_FILE:process.env.KIDS_SIGNER_STATE_FILE||dir+'/signer-state.json'};
delete env.KIDS_SIGNER_KEY_JSON;
const {main}=await import('../../localnet/signer/main.mjs');
await main(env);
