// Local rehearsal review endpoint composition. Funding/provisioning are separately
// qualified; accepting a quote cannot trigger signing or debit the creator.
import {PublicKey} from '@solana/web3.js';
import {createCreationStore} from '../../localnet/creation/store.mjs';
import {quoteAuthorityFunding} from '../../localnet/creation/setup-funding.mjs';
import {readCreationCosts} from '../../localnet/creation/live-costs.mjs';
import {REGISTRY_SCHEMA_VERSION} from '../../localnet/registry/registry.mjs';
import {canonicalHash} from '../../localnet/registry/canonical.mjs';
import {validatePresets,presetTerms,presetsHash} from '../../localnet/registry/presets.mjs';
import {validateCoin,parseUtcInput} from '../src/public/launch-draft.mjs';
import {cleanDraft,verifyOwnedArtwork,verifyOwnedVideo} from './public-launch-account.mjs';
import {creationMode,creationRpc} from '../../localnet/creation/scope.mjs';
const key=/^[A-Za-z0-9_.:-]{1,128}$/;
/** What the creator's wallet must hold before a quote is issued: the setup costs plus the operating reserve. */
export function creationFunding({costs,reserveLamports=null,balanceLamports}){
 const setup=BigInt(costs.totalLamports),reserve=reserveLamports==null?0n:BigInt(reserveLamports),needed=setup+reserve,balance=BigInt(balanceLamports);
 const sol=n=>(Number(n)/1e9).toFixed(3);
 return {neededLamports:String(needed),balanceLamports:String(balance),shortfallLamports:String(balance>=needed?0n:needed-balance),message:balance>=needed?null:'Your wallet holds '+sol(balance)+' SOL; creating needs about '+sol(needed)+' SOL (setup costs plus the operating reserve). Add funds and try again.'};
}
export function createPublicCreationReview({registry,connection,config,manifest,setupPlan,readCosts=readCreationCosts,preparation=null,artwork=null,video=null}){
 if(!creationMode(config?.mode))throw Error('Creation review is localnet-only');
 const u=new URL(config.rpcUrl);if(!creationRpc(u,config.mode)||connection.rpcEndpoint!==config.rpcUrl)throw Error('Creation review needs the configured loopback RPC');
 const genesisHash=new PublicKey(config.genesisHash).toBase58(),programId=new PublicKey(config.programId).toBase58();
 const treasury=config.programVersion===3?new PublicKey(config.treasury).toBase58():null;
 if(validatePresets(manifest).length)throw Error('Invalid creation manifest');
 // Capture server-owned inputs; a later mutation must not change an issued quote.
 manifest=structuredClone(manifest);setupPlan=structuredClone(setupPlan);
 if(!setupPlan||!key.test(setupPlan.version||'')||!setupPlan.counts)throw Error('Server setup plan required');
 const policyHash=presetsHash(manifest),planHash=canonicalHash(setupPlan),store=createCreationStore(registry);
 async function ready(){if(await registry.schemaVersion()!==REGISTRY_SCHEMA_VERSION)throw Error('Creation schema unavailable');if(await connection.getGenesisHash()!==genesisHash)throw Error('Creation ledger changed');}
 async function quote(owner,{draftId,revision,requestId}){
  new PublicKey(owner);if(!key.test(draftId||'')||!key.test(requestId||'')||!Number.isSafeInteger(revision)||revision<1)throw Error('Saved draft revision and request ID required');
  await ready();
  const descriptorHash=canonicalHash({genesisHash,programId,draftId,revision,policyHash,planHash,...(treasury?{treasury}:{})});
  const prior=await store.find(owner,requestId);
  if(prior){if(prior.descriptorHash!==descriptorHash)throw Object.assign(Error('Quote request changed'),{code:'IDEMPOTENCY_CONFLICT'});return prior;}
  const saved=await registry.drafts.get(owner,draftId);
  if(!saved||saved.revision!==revision)throw Object.assign(Error('Draft revision changed'),{code:'REVISION_CONFLICT'});
  if(saved.status!=='draft')throw Error('Creation already started');
  const draft=cleanDraft(saved.body,owner),errors=validateCoin(draft);
  if(Object.keys(errors).length)throw Error('Complete the coin details before review');
  if(!draft.pfp?.url)throw Error('Upload the coin picture before review');
  if(config.programVersion===3){
   await verifyOwnedArtwork(draft,owner,artwork,{required:true});
   await verifyOwnedVideo(draft,owner,video,{required:true});
   if(!draft.publicationConsent)throw Error('Approve permanent public artwork and metadata publication before review');
  }
  // The pilot-only preset is offered only while the composition is wallet-restricted (a pilot creator is pinned).
  const selection=presetTerms(manifest,{mode:'standard',capPresetId:draft.presetId,pilot:!!config.pilotCreator});
  if(selection.terms.feePolicy.creatorFeeEnabled!==false)throw Error('Unsupported creator fee policy');
  const costs=await readCosts({connection,genesisHash,owner,ammConfig:selection.terms.feePolicy.ammConfig,counts:setupPlan.counts,priorityFeeLamports:setupPlan.priorityFeeLamports,marginBps:setupPlan.marginBps});
  if(costs.coverage!=='bounded-setup-only'||costs.evidence?.genesisHash!==genesisHash||costs.evidence.ammConfig!==selection.terms.feePolicy.ammConfig||BigInt(costs.evidence.tradeFeeRate)!==BigInt(selection.terms.feePolicy.tradeFeeBps)*100n)throw Error('Cost evidence differs from reviewed policy');
  if(draft.start==='scheduled'&&(parseUtcInput(draft.startUtc)??0)<=Number(costs.evidence.chainTimeUnix)+180)throw Error('Scheduled start needs time for review and setup');
  if(typeof connection.getBalance==='function'){const funding=creationFunding({costs:costs.costs,reserveLamports:selection.terms.operating?.reserveLamports??null,balanceLamports:await connection.getBalance(new PublicKey(owner),'confirmed')});if(funding.message)throw Object.assign(Error(funding.message),{publicMessage:funding.message});}
  const authorityFunding=config.programVersion===3?quoteAuthorityFunding(costs.costs):null;
  const operatingPayer=config.operatingPayer??treasury??null;
  const body={version:1,authorityFunding,genesisHash,programId,policyHash,planHash,...(treasury?{treasury}:{}),...(operatingPayer?{operatingPayer}:{}),operatingReserveLamports:selection.terms.operating?.reserveLamports??null,terms:selection.terms,setupPlan,costs:costs.costs,evidence:costs.evidence,coverage:costs.coverage,platformCreationChargeLamports:selection.terms.platformCreationChargeLamports,fundingEnabled:false,publicationConsent:config.programVersion===3&&draft.publicationConsent===true};
  return store.issue({owner,draftId,revision,draftHash:canonicalHash(saved.body),requestKey:requestId,descriptorHash,body});
 }
 // Identity (ledger, program, treasury, operating payer) must always match. The policy and plan hashes must match to ACCEPT a
 // quote; an already accepted request continues and is read under the terms it was quoted with (they are pinned in its
 // accepted body and, once created, sealed on chain), so a later preset change never strands it (28 September 2026).
 const identity=q=>q?.body?.genesisHash===genesisHash&&q.body.programId===programId&&(!treasury||q.body.treasury===treasury)&&(!config.operatingPayer||q.body.operatingPayer===config.operatingPayer);
 const scoped=q=>identity(q)&&q.body.policyHash===policyHash&&q.body.planHash===planHash;
 const stale=()=>Object.assign(Error('This quote is from before a settings change. Get a new quote.'),{code:'QUOTE_STALE',publicMessage:'This quote is from before a settings change. Get a new quote.'});
 return {quote,async accept(owner,{quoteId}){await ready();const q=await store.get(owner,quoteId);if(!q||!identity(q))throw Error('Reviewed quote is not available for this configuration');if(!scoped(q))throw stale();return store.accept({owner,quoteId});},
  async prepare(owner,input){await ready();if(!preparation)throw Error('Creation preparation is not enabled');const r=await store.status(owner,input.draftId);if(!r||!identity({body:r.body.quote}))throw Error('Reviewed quote is not available for this configuration');return preparation.prepare(owner,input);},
  async status(owner,{draftId}){await ready();const r=await store.status(owner,draftId);return r&&identity({body:r.body.quote})?{...r,preparation:preparation?await preparation.status(owner,{draftId}):null}:null;}};
}
