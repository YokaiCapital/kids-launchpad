// Writes localnet/protocol-v3/test-vectors.txt: fixed compact-create bodies with the 800 sealed bytes the program must
// expand them to (mainnet platform treasury). The Rust test `compact_creation_matches_the_shared_vectors` checks every
// line from the program's side; `compact-create.test.mjs` checks the file is current. Run: node make-test-vectors.mjs
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {compactCreateBody,expandCompactBody,CREATE_V3_URI_PREFIX,CREATE_V3_MAX_WINDOW_SECONDS,CREATE_V3_MAX_SCHEDULE_SECONDS} from './client.mjs';
import {encodeTerms} from '../protocol-v2/policy.mjs';
import {keyHex} from '../protocol-v2/client.mjs';
const MAINNET_TREASURY='91eLwFTAxkcQLPSMxbzdSFkTyEwyRYcoZk64HMZj8vX';
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',CREATOR='JBjY3ETQWkJa79G1URqFsgzqxKqxWeNfNycccQLkGVgn';
// A fixed, valid key for the child mint (any 32 bytes; the expansion does not check the address).
const MINT=new PublicKey(createHash('sha256').update('kids compact-create vector mint').digest()).toBase58();
const cid46='QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',cid64='QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6ucoABCDEFGHJKLMNPQRST',cid1='Q';
const NOW=1790000000;
export const CASES=[
 {note:'opening 0 (the chain time), two-hour windows, tier 7, 46-character CID',now:NOW,fields:{genesisHash:GENESIS,nonce:'1',childMint:MINT,opensAt:'0',fundingDurationSeconds:7200,launchWindowSeconds:7200,softCapLamports:'50000000000',hardCapLamports:'100000000000',ammConfigIndex:7,metadataHash:'11'.repeat(32),metadataUri:CREATE_V3_URI_PREFIX+cid46}},
 {note:'scheduled exactly 30 days ahead, one-minute windows, tier 2',now:NOW,fields:{genesisHash:GENESIS,nonce:'77',childMint:MINT,opensAt:String(NOW+CREATE_V3_MAX_SCHEDULE_SECONDS),fundingDurationSeconds:60,launchWindowSeconds:60,softCapLamports:'1000000000',hardCapLamports:'1010000000',ammConfigIndex:2,metadataHash:'22'.repeat(32),metadataUri:CREATE_V3_URI_PREFIX+cid46}},
 {note:'longest CID (64 characters), both windows at the 30-day bound, opening one second ahead',now:NOW,fields:{genesisHash:GENESIS,nonce:'18446744073709551615',childMint:MINT,opensAt:String(NOW+1),fundingDurationSeconds:CREATE_V3_MAX_WINDOW_SECONDS,launchWindowSeconds:CREATE_V3_MAX_WINDOW_SECONDS,softCapLamports:'18446744073709551614',hardCapLamports:'18446744073709551615',ammConfigIndex:7,metadataHash:'ff'.repeat(32),metadataUri:CREATE_V3_URI_PREFIX+cid64}},
 {note:'one-character CID, opening 0 at a small chain time',now:1,fields:{genesisHash:GENESIS,nonce:'0',childMint:MINT,opensAt:'0',fundingDurationSeconds:1,launchWindowSeconds:1,softCapLamports:'1',hardCapLamports:'2',ammConfigIndex:2,metadataHash:'01'.repeat(32),metadataUri:CREATE_V3_URI_PREFIX+cid1}},
];
export function makeVectors(){
 const lines=['# creator_hex now body_hex sealed_hex (mainnet platform treasury); written by make-test-vectors.mjs, checked by tests.rs and compact-create.test.mjs'];
 for(const c of CASES){
  const body=compactCreateBody(c.fields),sealed=encodeTerms({...expandCompactBody(body,{creator:CREATOR,now:c.now}),treasury:keyHex(MAINNET_TREASURY)});
  lines.push('# '+c.note);lines.push([keyHex(CREATOR),String(c.now),body.toString('hex'),Buffer.from(sealed).toString('hex')].join(' '));
 }
 return lines.join('\n')+'\n';
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href)writeFileSync(fileURLToPath(new URL('./test-vectors.txt',import.meta.url)),makeVectors());
