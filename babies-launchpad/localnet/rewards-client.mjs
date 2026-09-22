// Load the existing KIDS source unchanged except resolving its imports locally.
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
export * from '@solana/web3.js';
export * as token from '@solana/spl-token';
function moduleURL(name,replacements={}) {
 let code=stripTypeScriptTypes(readFileSync(new URL('../shared/'+name+'.ts',import.meta.url),'utf8'));
 for(const spec of ['@solana/web3.js','@solana/spl-token','@noble/hashes/sha3.js'])code=code.replaceAll("'"+spec+"'",JSON.stringify(import.meta.resolve(spec)));
 for(const [key,value] of Object.entries(replacements))code=code.replaceAll("'"+key+"'",JSON.stringify(value));
 return 'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
}
const merkleURL=moduleURL('community-merkle');
export const merkle=await import(merkleURL);
export const rewards=await import(moduleURL('rewards-distributor',{'./community-merkle.js':merkleURL}));
