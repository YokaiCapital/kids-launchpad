import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mintHasKidsSuffix} from './vendor/mint-refill-core.js';
import {SqliteVanityMintInventory} from './vendor/packages/launcher-sdk/src/mint-inventory.js';
import {SqliteLaunchExecutionStore} from './vendor/packages/launcher-sdk/src/sqlite-execution-store.js';
import {runParallelMintRefill} from './vendor/mint-refill-parallel.js';
const require=createRequire(new URL('./package.json',import.meta.url));
const bs58=require('bs58').default;
for(let i=0;i<100;i++) {
 const address=bs58.encode(randomBytes(32));
 const bytes=bs58.decode(address.slice(0,-4)+'kids');
 if(bytes.length===32) assert.equal(mintHasKidsSuffix(bytes),true);
 assert.equal(mintHasKidsSuffix(bs58.decode(address)),address.endsWith('kids'));
}
const dir=mkdtempSync(join(tmpdir(),'kids-worker-test-')), key=randomBytes(32), records=new SqliteLaunchExecutionStore(join(dir,'executions.sqlite'));
let inventory;
try {
 inventory=new SqliteVanityMintInventory({databasePath:join(dir,'inventory.sqlite'),executionStore:records,keyId:'test',encryptionKey:key,fallbackToOrdinaryMint:false});
 const abort=new AbortController();let progress;
 setTimeout(()=>abort.abort(),1500);
 await runParallelMintRefill({inventory,signal:abort.signal,processes:1,webParent:false,report:value=>{progress=value;}});
 assert.equal(progress.state,'refilling');assert.equal(progress.processes,1);
 inventory.close();inventory=undefined;
 assert.throws(()=>new SqliteVanityMintInventory({databasePath:join(dir,'inventory.sqlite'),executionStore:records,keyId:'test',encryptionKey:randomBytes(32)}),/encryption key|failed authentication/);
 console.log('PASS: exact kids suffix matcher, existing pool startup, encrypted inventory rejects wrong key.');
}finally{inventory?.close();records.close();key.fill(0);rmSync(dir,{recursive:true,force:true});}
