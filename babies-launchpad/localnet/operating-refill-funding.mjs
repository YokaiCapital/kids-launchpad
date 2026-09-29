// Operator tool for option 1 refills (owner decision 27 September 2026). The treasury key never touches a worker: this
// tool freezes what the coins' fee share entitles their operating budgets to into one funding, prints the exact transfer
// the treasury's owner sends, and credits the budgets only from that finalized transaction. Never signs, never sends.
//
//   node localnet/operating-refill-funding.mjs status  --registry <postgres url> [--schema <search_path>] --genesis <hash> --program <id> --payer <address> --treasury <address> [--policy creator-funded-v1]
//   node localnet/operating-refill-funding.mjs prepare --registry ... (same scope)            -> one funding with amount, destination and memo
//   node localnet/operating-refill-funding.mjs credit  --registry ... --rpc <url> --funding <id> --signature <sig>
//   node localnet/operating-refill-funding.mjs void    --registry ... --funding <id>
import {Connection,PublicKey} from '@solana/web3.js';
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {PostgresRegistry} from './registry/registry.mjs';
import {prepareRefillFunding,creditRefillFunding,voidRefillFunding} from './jobs/operating-refill.mjs';
export function parseArgs(argv){
 const out={command:argv[0]};
 for(let i=1;i<argv.length;i++){const a=argv[i];if(!a.startsWith('--'))throw Error('Unexpected argument '+a);const v=argv[i+1];if(v===undefined||v.startsWith('--'))throw Error('Missing value for '+a);out[a.slice(2)]=v;i++;}
 return out;
}
const address=x=>{const k=new PublicKey(x).toBase58();if(k!==x)throw Error('Invalid address '+x);return k;};
export async function refillStatus({registry,genesisHash,programId,payer,policy}){
 const rows=(await registry.query("SELECT campaign,due_lamports,funded_lamports,treasury_paid_accounted,pending_funding_id FROM operating_refills WHERE genesis_hash=? AND program_id=? AND payer=? AND policy=? ORDER BY campaign",[genesisHash,programId,payer,policy])).rows;
 const fundings=(await registry.query("SELECT funding_id,state,total_lamports,signature,created_at FROM operating_refill_fundings WHERE genesis_hash=? AND program_id=? AND payer=? AND policy=? ORDER BY created_at DESC LIMIT 20",[genesisHash,programId,payer,policy])).rows;
 return {campaigns:rows.map(r=>({campaign:r.campaign,dueLamports:r.due_lamports,fundedLamports:r.funded_lamports,treasuryPaidAccounted:r.treasury_paid_accounted,pendingFundingId:r.pending_funding_id})),dueTotalLamports:String(rows.filter(r=>!r.pending_funding_id).reduce((n,r)=>n+BigInt(r.due_lamports),0n)),fundings:fundings.map(f=>({fundingId:f.funding_id,state:f.state,totalLamports:f.total_lamports,signature:f.signature,createdAt:f.created_at}))};
}
export function transferInstructionsText(funding){
 const sol=(Number(funding.totalLamports)/1e9).toFixed(9).replace(/0+$/,'').replace(/\.$/,'');
 return ['Refill funding '+funding.fundingId,'Send exactly '+funding.totalLamports+' lamports ('+sol+' SOL) from the treasury '+funding.treasury+' to the keeper payer '+funding.payer+' with this memo (exact text):',funding.memo,'Example with the Solana CLI and the treasury keypair file:','solana transfer '+funding.payer+' '+sol+' --from <treasury keypair> --allow-unfunded-recipient --with-memo "'+funding.memo+'" --url <rpc>','Then credit the budgets: node localnet/operating-refill-funding.mjs credit --funding '+funding.fundingId+' --signature <signature> ...'].join('\n');
}
export async function main(argv,{stdout=process.stdout}={}){
 const a=parseArgs(argv);
 if(!['status','prepare','credit','void'].includes(a.command))throw Error('Usage: status | prepare | credit | void');
 if(!/^postgres(ql)?:\/\//.test(a.registry??''))throw Error('--registry must be a PostgreSQL URL');
 const pool=new pg.Pool({connectionString:a.registry,max:2,...(a.schema?{options:'-c search_path='+a.schema}:{})}),registry=new PostgresRegistry({pool});
 try{
  if(a.command==='void'){const r=await voidRefillFunding({registry,fundingId:a.funding});stdout.write(JSON.stringify(r,null,2)+'\n');return r;}
  if(a.command==='credit'){
   if(!a.rpc)throw Error('--rpc required to read the finalized transaction');
   const r=await creditRefillFunding({registry,connection:new Connection(a.rpc,'finalized'),fundingId:a.funding,signature:a.signature});stdout.write(JSON.stringify(r,null,2)+'\n');return r;
  }
  const scope={registry,genesisHash:address(a.genesis),programId:address(a.program),payer:address(a.payer),policy:a.policy??'creator-funded-v1'};
  if(a.command==='status'){const r=await refillStatus(scope);stdout.write(JSON.stringify(r,null,2)+'\n');return r;}
  const funding=await prepareRefillFunding({...scope,treasury:address(a.treasury)});
  if(!funding){stdout.write('Nothing is due for this payer.\n');return null;}
  stdout.write(transferInstructionsText(funding)+'\n');return funding;
 }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exit(1);});
