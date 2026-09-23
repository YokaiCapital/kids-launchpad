// Operator tool: fix the next campaign's identity BEFORE the snapshot and before any transaction.
//   KIDS_NETWORK=mainnet KIDS_HELIUS_RPC_URL=… node localnet/plan-network-campaign.mjs [--soft-sol 1] [--hard-sol 5] [--hours 24]
//     [--name 'Shartcoin' --symbol SHART --description '…' --image interaction-review/public/assets/shart-pfp.png]
// Without branding flags the plan carries the TEST coin name and image (a test launch never shows the real artwork).
// Writes deployment/<network>/campaign-plan.json: nonce, creator (operator), program id, campaign address and terms.
// Refuses to overwrite a plan that already has snapshot evidence. Nothing is sent to the chain.
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';import {randomBytes} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {networkProfile} from './network.mjs';import {operatorKeypair} from './operator-key.mjs';import {campaignAddress} from './launch-escrow.mjs';import {PublicKey} from '@solana/web3.js';
import {activeCampaignTerms,campaignPlanPath,snapshotDirectory} from './provision-active-launch.mjs';import {tokenBranding,TEST_TOKEN} from './token-metadata.mjs';
const profile=networkProfile();if(profile.network==='localnet')throw Error('Localnet campaigns are provisioned directly');
const args=process.argv.slice(2),opt=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
const env={...process.env};if(opt('--soft-sol'))env.KIDS_ACTIVE_SOFT_CAP_SOL=opt('--soft-sol');if(opt('--hard-sol'))env.KIDS_ACTIVE_HARD_CAP_SOL=opt('--hard-sol');if(opt('--hours'))env.KIDS_ACTIVE_DEADLINE_SECONDS=String(Math.round(Number(opt('--hours'))*3600));
const terms=activeCampaignTerms(env);
const token=tokenBranding(opt('--name')||opt('--symbol')||opt('--image')?{name:opt('--name'),symbol:opt('--symbol'),description:opt('--description')||'',image:opt('--image')||null}:TEST_TOKEN);
const identities=JSON.parse(readFileSync(new URL('../deployment/MAINNET-IDENTITIES.json',import.meta.url),'utf8'));
const programId=process.env.KIDS_PROGRAM_ID||identities.program?.programId;if(!programId)throw Error('Program id unknown: record it in MAINNET-IDENTITIES.json or set KIDS_PROGRAM_ID');
const operator=await operatorKeypair();const path=campaignPlanPath(profile.network);
if(existsSync(path)){const old=JSON.parse(readFileSync(path,'utf8'));const dir=snapshotDirectory(profile.network)+'/'+old.campaign;if(existsSync(dir))throw Error('A plan with snapshot evidence exists ('+old.campaign+'); remove it deliberately before planning another campaign');}
const nonce=randomBytes(8).readBigUInt64LE(),campaign=campaignAddress(new PublicKey(programId),operator.publicKey,nonce).toBase58();
const plan={network:profile.network,programId,creator:operator.publicKey.toBase58(),nonce:nonce.toString(),campaign,terms:{soft:terms.soft,hard:terms.hard,deadlineSeconds:terms.deadlineSeconds},token,parents:identities.parents.map(p=>({role:p.role,mint:p.mint})),dev:identities.devWallet.address,treasury:identities.treasuryWallet.address,plannedAt:new Date().toISOString(),snapshotDirectory:'deployment/'+profile.network+'/snapshots/'+campaign};
mkdirSync(fileURLToPath(new URL('../deployment/'+profile.network+'/',import.meta.url)),{recursive:true});writeFileSync(path,JSON.stringify(plan,null,2)+'\n');
console.log(JSON.stringify(plan,null,2));console.log('Next: KIDS_HELIUS_RPC_URL=… node localnet/snapshot-parents-mainnet.mjs '+campaign+' '+plan.snapshotDirectory.replace('/'+campaign,''));
