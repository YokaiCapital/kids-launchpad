// Explicit localnet composition for the private creator rehearsal. Callers supply
// the existing encrypted inventory and a bounded metadata provider. No env flag
// enables this on hosted services; no key material crosses this interface.
import {createMintLeases} from '../mints/leases.mjs';
import {createPreparationService} from './preparation.mjs';
import {createMintPlanService} from './mint-plan.mjs';
import {createMintApprovalJournal} from './mint-approval.mjs';
import {createMintRecovery} from './mint-recovery.mjs';
import {createMintWalletService} from './mint-wallet.mjs';
import {createMintExecutor} from './mint-execution.mjs';
import {createProvisionPlanService} from './provision-plan.mjs';
import {createProvisionExecutor} from './provision-execution.mjs';
import {createProvisionRecovery} from './provision-recovery.mjs';
import {createProvisionWalletService} from './provision-wallet.mjs';
import {createProvisionRegistrar} from './provision-registration.mjs';
import {createCreatorFlow} from './creator-flow.mjs';
import {createOperatingProofReader} from './operating-proofs.mjs';
import {createOperatingLedger} from './operating-ledger.mjs';
import {createOperatingReserveService,loadOperatingFundingPacket} from './operating-reserve.mjs';
import {creationMode,creationRpc} from './scope.mjs';
export function createLocalCreatorServices({registry,connection,config,inventory,publisher}){
 if(!creationMode(config?.mode)||config.programVersion!==3||typeof inventory?.assetMintSigner!=='function')throw Error('Local v3 creator composition needs the existing asset signer');
 // Funding-first accounting (29 September 2026): the same inventory reserves the fee-NFT key beside the mint at plan time
 // and co-signs the creator's opening packet with both keys (single host: the inventory is this process's). The custody
 // route is composed whenever the inventory has it, so an accepted version-3 opening is still signed and recovered after
 // the admission flag (config.fundingFirst, new rounds only) is turned off; the flag never changes a sealed plan.
 const custodyCapable=['fundingFirstOpeningSigner','reserveFundingFirstKeys','fundingFirstCustody'].every(m=>typeof inventory[m]==='function');
 if(config.fundingFirst===true&&!custodyCapable)throw Error('Funding-first creation needs the custody-capable mint inventory');
 const mintLeases=createMintLeases({registry,inventory});
 const preparation=createPreparationService({registry,connection,config,mintLeases});
 const mintPlans=createMintPlanService({registry,connection,config,publisher,...(custodyCapable?{custody:{reserve:(binding,scope)=>inventory.reserveFundingFirstKeys(binding,scope),view:mint=>inventory.fundingFirstCustody(mint)}}:{})});
 const mintApprovals=createMintApprovalJournal({registry,connection,config,mintLeases,loadIntent:mintPlans.load});
 const mintRecovery=createMintRecovery({registry,connection,config,plans:mintPlans,approvals:mintApprovals});
 const mintWallet=createMintWalletService({registry,connection,config,plans:mintPlans,approvals:mintApprovals,recovery:mintRecovery});
 const mintExecutor=createMintExecutor({registry,connection,config,mintLeases,approvals:mintApprovals,loadIntent:mintPlans.load});
 const provisionPlans=createProvisionPlanService({registry,connection,config,mintPlans,mintApprovals});
 const provisionExecutor=createProvisionExecutor({registry,connection,config,loadIntent:provisionPlans.load});
 const provisionRecovery=createProvisionRecovery({registry,connection,config,plans:provisionPlans,executor:provisionExecutor});
 const provisionWallet=createProvisionWalletService({registry,connection,config,plans:provisionPlans,executor:provisionExecutor,recovery:provisionRecovery});
 const registrar=createProvisionRegistrar({registry,config,loadIntent:provisionPlans.load,executor:provisionExecutor,publisher,loadMintIntent:mintPlans.load,mintApprovals});
 // Creator operating reserve (option 1): credited through the same operating ledger and finalized-proof reader the
 // keepers use, from the creator's own durable packet. These services never reconcile or hold keeper spends.
 let operatingReserve=null;
 if(config.operatingPayer&&config.operatingReserveLamports){
  const never=async()=>{throw Error('Creator services never reconcile keeper spends');};
  const proofs=createOperatingProofReader({connection,genesisHash:config.genesisHash,loadFundingPacket:loadOperatingFundingPacket(registry),loadSpendPacket:never});
  const ledger=createOperatingLedger({registry,verifyFunding:proofs.verifyFunding,verifyOutcome:never});
  operatingReserve=createOperatingReserveService({registry,connection,config,ledger,loadCampaign:async(owner,requestId)=>{const m=await mintPlans.load(requestId);if(m.creator!==owner)return null;return registry.campaigns.get({genesisHash:config.genesisHash,programId:config.programId,campaign:m.campaign});}});
 }
 // The signing route is the sealed plan's: a version-3 (funding-first) intent is co-signed by the custody's opening signer
 // (creator, mint, fee NFT), every other by the asset signer (creator, mint). Both rebuild the packet through the same
 // approval journal, and the inventory's own intent binding refuses the wrong route for a mint either way.
 const assetSigner=inventory.assetMintSigner(input=>mintApprovals.authorize(input)),openingSigner=custodyCapable?inventory.fundingFirstOpeningSigner(input=>mintApprovals.authorize(input)):null;
 const signReservedMint=async input=>{
  const requestId=typeof input?.draftId==='string'&&input.draftId.startsWith('asset:')?input.draftId.slice(6):null;
  const version=requestId?(await mintPlans.load(requestId)).version:null;
  if(version===3){if(!openingSigner)throw Error('Funding-first opening signer is not configured');return openingSigner(input);}
  return assetSigner(input);
 };
 const flow=createCreatorFlow({registry,config,preparation,mintPlans,mintApprovals,mintWallet,mintExecutor,signReservedMint,provisionPlans,provisionWallet,registrar,operatingReserve});
 return {flow,preparation,mintPlans,mintApprovals,mintWallet,mintExecutor,mintRecovery,provisionPlans,provisionExecutor,provisionWallet,provisionRecovery,registrar,operatingReserve,signReservedMint,custodyCapable};
}
