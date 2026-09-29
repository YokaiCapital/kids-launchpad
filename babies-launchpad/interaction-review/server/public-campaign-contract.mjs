// Versioned bridge between registry/chain projections and the public UI. Never infer a live balance from a cap.
import {LEGACY_POLICY} from '../../localnet/registry/read-adapters.mjs';
import {presetsHash} from '../../localnet/registry/presets.mjs';
export const PUBLIC_CONTRACT_VERSION=1;
const amount=v=>v==null?null:String(v);
const time=v=>v==null?null:typeof v==='number'?v:Number.isFinite(Date.parse(v))?Math.floor(Date.parse(v)/1000):null;
const phases={scheduled:'scheduled',open:'open','awaiting-launch':'settling',launched:'live',failed:'refund'};
const key=v=>v?.toBase58?.()??v??null;
export function campaignViewModel(row,{live=null,profile=null,now=Date.now}={}){
 const policy=LEGACY_POLICY[row.legacyAdapterVersion];
 const verified=live?.available===true,terms=verified?live.terms||{}:{},totals=verified?live.totals||{}:{};
 const sealed=row.terms||{},split=terms.splitBps||sealed.splitBps||policy?.supplySplitBps||{};
 const genesisHash=row.genesisHash,programId=row.programId,campaign=row.campaign;
 return {
  contractVersion:PUBLIC_CONTRACT_VERSION,identity:{genesisHash,programId,campaign},
  slug:row.slug,legacyVersion:row.legacyAdapterVersion,mode:row.mode,
  name:profile?.name||row.name||'',symbol:profile?.symbol||row.symbol||'',description:profile?.description||'',
  creator:key(terms.creator)||row.creator,devBeneficiary:key(terms.dev)||row.dev,treasury:key(terms.treasury)||row.treasury,
  media:profile?.media||{},links:profile?.links||{},parents:profile?.parents||[],
  phase:verified?(phases[live.phase]||live.phase||'unavailable'):'unavailable',
  terms:{version:String(row.campaignVersion),hash:row.termsHash,
   softLamports:amount(terms.softCapLamports??row.softCapLamports),hardLamports:amount(terms.hardCapLamports??row.hardCapLamports),
   opensAtUnix:terms.opensAtUnix??time(row.opensAt),deadlineUnix:terms.deadlineUnix??row.deadlineUnix,
   launchDeadlineUnix:terms.launchDeadlineUnix??row.launchDeadlineUnix,
   supply:{totalBaseUnits:amount(terms.supplyRaw??row.supplyRaw),decimals:terms.decimals??sealed.decimals??null,
    participantsBps:split.participants??null,liquidityBps:split.liquidity??null,parentsBps:split.parentA==null?null:split.parentA+(split.parentB||0),devBps:split.dev??null},
   vesting:{immediateBps:terms.vesting?.instantBps??policy?.devVesting.immediateBps??null,vestedBps:terms.vesting?.linearBps??policy?.devVesting.linearBps??null,months:terms.vesting?.months??policy?.devVesting.vestingMonths??null},
   fee:{totalBps:terms.tradeFeeBps??null,creatorFeeEnabled:terms.creatorFeeEnabled??null,tokenSide:'burn',solRouting:terms.feeWeights||policy?.solFeeRouting||null,poolConfig:key(terms.ammConfig)},
   lock:{program:key(terms.lockProgram)},upgradeAuthority:terms.upgradeAuthority??null},
  totals:{committedLamports:amount(totals.totalLamports),acceptedLamports:amount(totals.settledAcceptedLamports),
   refundableLamports:amount(totals.refundableLamports),receiptCount:amount(totals.receiptCount),settledReceiptCount:amount(totals.settledReceiptCount)},
  chain:{mint:key(terms.mint)||row.mint,pool:verified?live.pool:row.pool,escrow:campaign,lock:live?.lock||null},
  market:live?.market||null,createdAtUnix:time(row.createdAt),
  source:{slot:verified?live.source?.slot:null,commitment:verified?live.source?.commitment:null,
   fetchedAtUnix:verified?Math.floor((Number.isFinite(Date.parse(live.readAt))?Date.parse(live.readAt):now())/1000):null,chainTimeUnix:verified?live.source?.chainTimeUnix:null},
  availability:{available:verified,reason:verified?null:live?.reason||'Live campaign data is unavailable. No balance is assumed.'},
 };
}

export function publicPresetManifest(manifest,{capabilities={},treasury=null,supply=null,pilot=false}={}){
 const agreed=manifest.agreed||{},fee=agreed.feePolicy||{},dev=agreed.devSupply||{};
 const policies={};
 for(const [name,mode] of Object.entries(manifest.modes||{})){
  const s=mode.supplySplitBps||{};
  policies[name]={participantsBps:s.participants,liquidityBps:s.liquidity,parentsBps:(s.parentA||0)+(s.parentB||0),devBps:s.dev};
 }
 return {version:manifest.policyVersion,hash:presetsHash(manifest),status:manifest.status,
  capabilities:{create:false,commit:false,claim:false,...capabilities,family:false},
  modes:{standard:{supported:true},family:{supported:false,reason:'New Family launches are not enabled yet. Existing Family claims remain available.'}},
  treasury,supply:{...policies,totalBaseUnits:supply?.totalBaseUnits??null,decimals:supply?.decimals??null},
  // Only the pilot's own preset is preselected, and only for the pilot wallet; everyone else chooses a launch size first.
  presets:(manifest.capPresets||[]).filter(p=>!p.pilotOnly||pilot===true).map(p=>({id:p.id,label:p.label,softLamports:p.softCapLamports,hardLamports:p.hardCapLamports,default:p.pilotOnly===true&&pilot===true,...(p.pilotOnly?{pilotOnly:true}:{})})),
  fundingSeconds:manifest.schedule?.fundingDurationSeconds,launchWindowSeconds:manifest.schedule?.launchWindowSeconds,
  minimumCommitmentLamports:manifest.agreed?.funding?.minimumCommitmentLamports??null,
  operating:manifest.agreed?.operating?{reserveLamports:manifest.agreed.operating.reserveLamports,floorLamports:manifest.agreed.operating.floorLamports,refillBps:manifest.agreed.operating.refillBps,returnUnusedOnRefund:manifest.agreed.operating.returnUnusedOnRefund}:null,
  vesting:{immediateBps:dev.immediateBps,vestedBps:dev.linearBps,months:dev.vestingMonths},
  fee:{totalBps:fee.tradeFeeBps,tokenSide:'burn',solRouting:Object.fromEntries(Object.entries(manifest.modes||{}).map(([name,p])=>[name,p.solFeeRouting]))},
  parents:[],costQuote:null,
 };
}
