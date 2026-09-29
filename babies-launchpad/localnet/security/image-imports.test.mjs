// The hosted image installs one dependency tree (localnet/node_modules) and links it at the application root, so every
// server-side module outside localnet resolves its packages there. This test keeps that promise: each bare package
// imported by code the image runs must be a localnet dependency (the pilot API crashed on 28 September 2026 when
// interaction-review/server imported @solana/web3.js that only interaction-review's own tree had).
import test from 'node:test';import assert from 'node:assert/strict';
import {readdirSync,readFileSync,statSync,existsSync} from 'node:fs';import {join} from 'node:path';
const root=new URL('../../',import.meta.url).pathname;
const dirs=['interaction-review/server','interaction-review/staging','interaction-review/deployment','deployment/mainnet','shared','localnet'];
function* files(dir){for(const name of readdirSync(dir)){const p=join(dir,name);if(name==='node_modules'||name.startsWith('.runtime')||name==='test'||name==='fixtures')continue;const s=statSync(p);if(s.isDirectory())yield* files(p);else if(name.endsWith('.mjs')&&!name.endsWith('.test.mjs'))yield p;}}
const pattern=/(?:^|\n)\s*import\s[^'"\n]*?from\s*['"]([^'".\/][^'"]*)['"]|import\(\s*['"]([^'".\/][^'"]*)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'".\/][^'"]*)['"]/g;
test('every bare package imported by image-run code is a localnet dependency',()=>{
 const localnet=JSON.parse(readFileSync(join(root,'localnet/package.json'),'utf8')),declared=new Set(Object.keys(localnet.dependencies||{}));
 const problems=[];
 for(const dir of dirs)for(const file of files(join(root,dir))){
  const source=readFileSync(file,'utf8');
  for(const m of source.matchAll(pattern)){
   const spec=m[1]||m[2]||m[3];if(!spec||spec.startsWith('node:'))continue;
   const pkg=spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0];
   if(!declared.has(pkg)&&!existsSync(join(root,'localnet/node_modules',pkg)))problems.push(pkg+' from '+file.slice(root.length));
  }
 }
 assert.deepEqual(problems,[],'packages the image cannot resolve');
 assert.ok(declared.has('@solana/web3.js')&&declared.has('pg'),'the image tree carries the shared packages');
});
