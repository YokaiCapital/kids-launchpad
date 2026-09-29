// Test fixtures for the funding-first creation path: the finalized opening accounts a version-3 intent leaves on the ledger
// (record with the sealed terms and the accounting marker, extension, both reservations, the funded authority, the two
// reserved addresses still absent), and test-only vanity mint keypairs ending in 'kids' (kids-vanity-keys.json: throwaway
// keys ground for these tests, never funded, never used on any public ledger).
import {readFileSync,existsSync} from 'node:fs';
import {Keypair,PublicKey,SystemProgram} from '@solana/web3.js';
import {expectedSealedTerms} from '../../creation/mint-packet.mjs';
import {CAMPAIGN_MAGIC} from '../../protocol-v2/client.mjs';
import {CAMPAIGN_LEN,termsHash} from '../../protocol-v2/policy.mjs';
import {displayHash,EXT_LEN,RESERVATION_LEN,OFF_ACCOUNTING_VERSION,ACCOUNTING_VERSION_FUNDING_FIRST} from '../../protocol-v3/client.mjs';
/** The seven finalized accounts of a landed opening, in mintResultAddresses order, at the given chain opening time. */
export function openingEvidence(intent,opensAt,over={}){
 const expected=expectedSealedTerms(intent,opensAt),campaign=new PublicKey(intent.campaign),program=new PublicKey(intent.programId);
 const record=Buffer.alloc(CAMPAIGN_LEN);CAMPAIGN_MAGIC.copy(record);expected.copy(record,8);termsHash(expected).copy(record,808);record[OFF_ACCOUNTING_VERSION]=ACCOUNTING_VERSION_FUNDING_FIRST;
 const ext=Buffer.alloc(EXT_LEN);Buffer.from('KIDSEXT2').copy(ext);campaign.toBuffer().copy(ext,8);termsHash(expected).copy(ext,40);new PublicKey(intent.mint).toBuffer().copy(ext,72);new PublicKey(intent.fundingFirst.feeNft).toBuffer().copy(ext,104);Buffer.from(displayHash({name:intent.metadata.name,symbol:intent.metadata.symbol,uri:intent.metadata.uri}),'hex').copy(ext,136);ext[168]=ACCOUNTING_VERSION_FUNDING_FIRST;
 const reservation=k=>{const b=Buffer.alloc(RESERVATION_LEN);Buffer.from('KIDSRSV2').copy(b);campaign.toBuffer().copy(b,8);new PublicKey(k).toBuffer().copy(b,40);return b;};
 const owned=data=>({owner:program,executable:false,lamports:1000000,data});
 const value=[owned(record),owned(ext),owned(reservation(intent.mint)),owned(reservation(intent.fundingFirst.feeNft)),{owner:SystemProgram.programId,executable:false,lamports:Number(intent.launch.authorityBudgetLamports),data:Buffer.alloc(0)},null,null];
 return {record,ext,expected,response:{context:{slot:10},value:Object.assign(value,over)}};
}
/** True when the test-only vanity keys file is present (the end-to-end suites skip without it, like without PostgreSQL). */
export function kidsVanityKeysAvailable(){return existsSync(new URL('./kids-vanity-keys.json',import.meta.url));}
/** Test-only mint keypairs whose addresses end in 'kids' (the inventory's vanity rule). */
export function kidsVanityKeypairs(count){
 const keys=JSON.parse(readFileSync(new URL('./kids-vanity-keys.json',import.meta.url),'utf8'));
 if(!Array.isArray(keys)||keys.length<count)throw Error('Not enough test vanity keys');
 return keys.slice(0,count).map(secret=>{const kp=Keypair.fromSecretKey(Uint8Array.from(secret));if(!kp.publicKey.toBase58().endsWith('kids'))throw Error('Test vanity key does not end in kids');return kp;});
}
