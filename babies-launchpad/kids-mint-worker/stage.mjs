import {cpSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const here=fileURLToPath(new URL('.',import.meta.url)),out=join(here,'.stage');
rmSync(out,{recursive:true,force:true});
mkdirSync(out,{recursive:true});
for(const name of ['vendor','worker.mjs','package.json','package-lock.json','Dockerfile','PROVENANCE.md'])cpSync(join(here,name),join(out,name),{recursive:true});
writeFileSync(join(out,'.railwayignore'),'node_modules/\n**/node_modules/\n');
console.log('Staged the self-contained KIDS worker.');
