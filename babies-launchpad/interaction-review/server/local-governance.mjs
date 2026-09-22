import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openLocalProtocol} from '../../protocol/server.mjs';
import {hash} from '../../protocol/core.mjs';
import {rpc} from '../../shared/solana.mjs';
const dir=fileURLToPath(new URL('../../localnet/.runtime/governance/',import.meta.url));
let instance;
export function governance(){if(!instance)instance=openLocalProtocol(dir).protocol;return instance;}
export function publicRounds(){const p=governance();return p.read().rounds.map(r=>({...r,snapshot:{hash:r.snapshot.hash,slot:r.snapshot.slot,denominatorRaw:r.snapshot.denominatorRaw,source:r.snapshot.source},tally:p.tally(r.id)}));}
export async function openLocalRound({config,records,id,durationMinutes}){
 if(!Number.isInteger(durationMinutes)||durationMinutes<1||durationMinutes>10080)throw Error('Round length must be 1–10,080 minutes');
 if(!/^[A-Za-z0-9-]{1,40}$/.test(id))throw Error('Use a short round ID with letters, numbers and hyphens');
 const p=governance();if(p.read().rounds.some(r=>!r.result&&r.closesAt>Date.now()))throw Error('Another voting round is still open');if(p.read().rounds.some(r=>r.id===id))throw Error('Round ID already exists');
 const genesis=await rpc(config.rpcUrl,'getGenesisHash');if(genesis!==config.genesisHash)throw Error('Localnet genesis changed');
 const result=await rpc(config.rpcUrl,'getProgramAccounts',['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',{encoding:'jsonParsed',commitment:'finalized',withContext:true,filters:[{dataSize:165},{memcmp:{offset:0,bytes:config.mints.KIDS}}]}]);
 const accounts=result.value.map(row=>({address:row.pubkey,...row.account.data.parsed.info})).filter(a=>a.owner!==config.admin&&a.state!=='frozen'&&BigInt(a.tokenAmount.amount)>0n).map(a=>({address:a.address,owner:a.owner,amountRaw:a.tokenAmount.amount}));
 if(!accounts.length)throw Error('No circulating KIDS holders at the finalized snapshot');
 const now=Date.now();
 p.transaction(s=>{
  for(const record of records){
   const id='wallet-'+record.owner+'-'+record.id;
   if(s.proposals.some(x=>x.id===id&&x.version===record.version))continue;
   const terms=p.terms({name:record.name,ticker:record.ticker,description:record.description.slice(0,180),parents:[record.a,record.b],artSha256:createHash('sha256').update(record.art).digest('hex'),rights:record.rights});
   const proposal={id,version:record.version,owner:record.owner,terms,submittedAt:Date.parse(record.submittedAt),reviewedAt:now,status:'approved',reviews:[{decision:'approved',reason:'VALID',actor:config.admin,at:now}],source:'authenticated-wallet-submission'};
   proposal.hash=hash({id:proposal.id,version:proposal.version,owner:proposal.owner,terms});s.proposals.push(proposal);
  }
  p.event(s,'account-proposals-imported',{actor:config.admin,count:records.length});return null;
 });
 p.localnetGenesis=genesis;
 return p.openRound({id,opensAt:now+1000,freezeAt:now,closesAt:now+durationMinutes*60000,snapshot:{source:'solana-localnet-rpc',genesisHash:genesis,mint:config.mints.KIDS,commitment:'finalized',slot:result.context.slot,accounts}});
}
