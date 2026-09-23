// Signer service (KIDS_ROLE=signer): its own Railway service and volume. The operator key arrives ONCE through the
// KIDS_SIGNER_KEY_JSON secret, is written to the volume (0600) and the variable should then be removed by the owner.
// Nothing else runs here: no API, no keepers, no RPC writes. Policy: localnet/signer-policy.mjs.
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
const dir='/data/signer';mkdirSync(dir,{recursive:true,mode:0o700});const keyFile=dir+'/operator-keypair.json';
if(!existsSync(keyFile)){const raw=process.env.KIDS_SIGNER_KEY_JSON;if(!raw)throw Error('KIDS_SIGNER_KEY_JSON is required on the first boot of the signer');const bytes=JSON.parse(raw);if(!Array.isArray(bytes)||bytes.length!==64)throw Error('Signer key must be a 64-byte array');writeFileSync(keyFile,JSON.stringify(bytes),{mode:0o600,flag:'wx'});console.log(JSON.stringify({event:'signer-key-stored',note:'remove KIDS_SIGNER_KEY_JSON from the service variables now'}));}
else if(process.env.KIDS_SIGNER_KEY_JSON)console.log(JSON.stringify({event:'signer-key-variable-still-present',note:'remove KIDS_SIGNER_KEY_JSON from the service variables'}));
delete process.env.KIDS_SIGNER_KEY_JSON;
const identities=JSON.parse(readFileSync(new URL('../MAINNET-IDENTITIES.json',import.meta.url),'utf8'));
const planPath=new URL('./campaign-plan.json',import.meta.url);const plan=existsSync(planPath)?JSON.parse(readFileSync(planPath,'utf8')):null;
const env={...process.env,KIDS_SIGNER_KEY_FILE:keyFile,KIDS_SIGNER_PROGRAM_ID:process.env.KIDS_SIGNER_PROGRAM_ID||identities.program?.programId,KIDS_SIGNER_CAMPAIGNS:[process.env.KIDS_SIGNER_CAMPAIGNS,plan?.campaign].filter(Boolean).join(','),KIDS_SIGNER_HOST:process.env.KIDS_SIGNER_HOST||'::',KIDS_NETWORK:process.env.KIDS_NETWORK||identities.network||'mainnet',KIDS_SIGNER_RECIPIENTS:[process.env.KIDS_SIGNER_RECIPIENTS,identities.treasuryWallet?.address,identities.devWallet?.address].filter(Boolean).join(','),KIDS_SIGNER_STATE_FILE:process.env.KIDS_SIGNER_STATE_FILE||keyFile.replace(/[^/]+$/,'signer-state.json'),KIDS_SIGNER_PORT:process.env.KIDS_SIGNER_PORT||process.env.PORT||'4176'};
const {startSignerService}=await import('../../localnet/signer-service.mjs');startSignerService(env);
