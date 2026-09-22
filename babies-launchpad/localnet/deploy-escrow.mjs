import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {directory,key,bin} from './setup.mjs';
import {readLocalConfig} from '../interaction-review/server/local-config.mjs';
import {rpc} from '../shared/solana.mjs';
const config=readLocalConfig();if(config.network!=='localnet'||config.rpcUrl!=='http://127.0.0.1:18999'||await rpc(config.rpcUrl,'getGenesisHash')!==config.genesisHash)throw Error('Escrow deployment is localnet only');
const program=key('escrow-program-key'),source=fileURLToPath(new URL('../programs/commitment-escrow/Cargo.toml',import.meta.url)),out=directory+'/escrow-build';mkdirSync(out,{recursive:true});
execFileSync(bin+'/cargo-build-sbf',['--manifest-path',source,'--sbf-out-dir',out],{stdio:'inherit'});
const binary=out+'/kids_commitment_escrow.so',hash=createHash('sha256').update(readFileSync(binary)).digest('hex'),manifest=directory+'/escrow-program.json';
if(await rpc(config.rpcUrl,'getAccountInfo',[program.address]).then(x=>x.value)){
 if(!existsSync(manifest)||JSON.parse(readFileSync(manifest)).sha256!==hash)throw Error('Existing immutable program differs or lacks a manifest; do not overwrite deployment identity');
}else execFileSync(bin+'/solana',['program','deploy',binary,'--program-id','escrow-program-key.json','--keypair','admin.json','--url',config.rpcUrl,'--final'],{cwd:directory,stdio:'inherit'});
writeFileSync(manifest,JSON.stringify({programId:program.address,genesisHash:config.genesisHash,sha256:hash,source:'programs/commitment-escrow/src/lib.rs',upgradeAuthority:null},null,2)+'\n',{mode:0o600});
console.log('Immutable localnet escrow deployed: '+program.address);
