// Downloads public program/account state; all rehearsal transactions stay local.
// Separate ledger/ports preserve the application's active escrow and its genesis.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {directory,bin} from './setup.mjs';
const ledger=directory+'/lock-rehearsal-ledger';
const args=['--ledger',ledger,'--rpc-port','19099','--faucet-port','19901','--gossip-port','19101','--dynamic-port-range','19102-19135','--bind-address','127.0.0.1','--quiet'];
if(!existsSync(ledger+'/genesis.bin')&&!existsSync(ledger+'/genesis.tar.bz2')){
 args.push('--url','https://api.mainnet-beta.solana.com');
 for(const id of ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C','LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE','metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'])args.push('--clone-upgradeable-program',id);
 for(const id of ['2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5','DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8'])args.push('--clone',id);
}
const validator=spawn(bin+'/solana-test-validator',args,{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>validator.kill(signal));
validator.once('error',error=>{console.error(error.message);process.exitCode=1;});validator.once('exit',code=>{process.exitCode=code||0;});
