import { mkdirSync } from 'node:fs';
import { SqliteVanityMintInventory } from './vendor/packages/launcher-sdk/src/mint-inventory.js';
import { SqliteLaunchExecutionStore } from './vendor/packages/launcher-sdk/src/sqlite-execution-store.js';
import { runParallelMintRefill } from './vendor/mint-refill-parallel.js';
process.umask(0o077);
const key=process.env.KIDS_MINT_ENCRYPTION_KEY;
if (!/^[a-f0-9]{64}$/.test(key??'')) throw Error('KIDS inventory encryption key is required');
const dir=process.env.KIDS_MINT_DATA_DIR??'/data/kids';
mkdirSync(dir,{recursive:true,mode:0o700});
const records=new SqliteLaunchExecutionStore(`${dir}/executions.sqlite`);
const encryptionKey=Buffer.from(key,'hex');
const inventory=new SqliteVanityMintInventory({databasePath:`${dir}/inventory.sqlite`,executionStore:records,keyId:'kids-v1',encryptionKey,fallbackToOrdinaryMint:false});
encryptionKey.fill(0); delete process.env.KIDS_MINT_ENCRYPTION_KEY;
const abort=new AbortController();
process.once('SIGTERM',()=>abort.abort()); process.once('SIGINT',()=>abort.abort());
try {
 await runParallelMintRefill({inventory,signal:abort.signal,processes:Number(process.env.KIDS_MINT_PROCESSES??4),webParent:false,
 report:progress=>console.log(JSON.stringify({event:'kids-mint-reserve',suffix:'kids',...progress}))});
} finally {inventory.close();records.close();}
