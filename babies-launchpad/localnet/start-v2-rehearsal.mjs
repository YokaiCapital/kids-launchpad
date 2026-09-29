// Localnet for programs/kids-launch-v2 rehearsals: a separate ledger and ports (RPC 19199) so the application's
// active escrow ledger (18999) and the lock-rehearsal ledger (19099) are never touched. The canonical Raydium CPMM,
// the lock program, the Metadata program, the CPMM create-pool fee receiver and the AMM config of tier 2 are cloned
// byte for byte from KIDS_V2_CLONE_URL (default: the local lock-rehearsal ledger, itself a mainnet clone; a mainnet
// RPC URL works too). The tier-2 config is loaded as it is on mainnet, creator_fee_rate 500 at offset 108 included:
// kids-launch-v2 does not read that field (a creator fee is a pool-level switch that plain `initialize` leaves off
// and the launch read-back checks), so the rehearsal proves the launch against the real config bytes.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {directory,bin} from './setup.mjs';
export const V2_RPC_URL='http://127.0.0.1:19199';
export const V2_LEDGER=directory+'/v2-ledger';
export const CLONED_PROGRAMS=['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C','LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE','metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'];
export const AMM_CONFIG_2='2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5';
export const CLONED_ACCOUNTS=['DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8',AMM_CONFIG_2];
const source=process.env.KIDS_V2_CLONE_URL||'http://127.0.0.1:19099';
const args=['--ledger',V2_LEDGER,'--rpc-port','19199','--faucet-port','19902','--gossip-port','19301','--dynamic-port-range','19302-19335','--bind-address','127.0.0.1','--quiet'];
if(!existsSync(V2_LEDGER+'/genesis.bin')&&!existsSync(V2_LEDGER+'/genesis.tar.bz2')){
 console.log(JSON.stringify({event:'v2-ledger-genesis',source,clonedPrograms:CLONED_PROGRAMS,clonedAccounts:CLONED_ACCOUNTS}));
 args.push('--url',source);
 for(const id of CLONED_PROGRAMS)args.push('--clone-upgradeable-program',id);
 for(const id of CLONED_ACCOUNTS)args.push('--clone',id);
}
const validator=spawn(bin+'/solana-test-validator',args,{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>validator.kill(signal));
validator.once('error',error=>{console.error(error.message);process.exitCode=1;});validator.once('exit',code=>{process.exitCode=code||0;});
