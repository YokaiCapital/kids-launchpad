// The scope an accepted creation request is served under. This service's identity (ledger, program, treasury, operating
// payer) must always match; the policy and plan hashes are the ones the request was QUOTED with, pinned in its accepted body
// and, once the campaign exists, sealed on chain. A later preset change therefore never strands an accepted request, while
// NEW acceptance (public-creation.accept) keeps requiring the current policy and plan (28 September 2026, work package 0).
const HEX64=/^[a-f0-9]{64}$/;
export function acceptedScope(scope,quote){
 if(!scope||!quote||typeof quote!=='object')return null;
 if(quote.genesisHash!==scope.genesisHash||quote.programId!==scope.programId)return null;
 if(quote.treasury&&scope.treasury&&quote.treasury!==scope.treasury)return null;
 if(quote.operatingPayer&&scope.operatingPayer&&quote.operatingPayer!==scope.operatingPayer)return null;
 if(!HEX64.test(quote.policyHash??'')||!HEX64.test(quote.planHash??''))return null;
 return Object.freeze({...scope,policyHash:quote.policyHash,planHash:quote.planHash,acceptedPolicy:Object.freeze({policyHash:quote.policyHash,planHash:quote.planHash,current:quote.policyHash===scope.policyHash&&quote.planHash===scope.planHash})});
}
