// How the real-network API obtains operator signatures (architecture audit item 3: key isolation).
//   signer mode (production): KIDS_SIGNER_URL + KIDS_SIGNER_TOKEN + KIDS_SIGNER_PUBKEY; no operator key may exist in the
//                             API environment or on its volume. This is the only mode allowed on mainnet.
//   local mode (tests only):  KIDS_ALLOW_LOCAL_OPERATOR_KEY=1 with KIDS_OPERATOR_KEY_JSON on first boot.
export function resolveOperatorMode(env){
 const network=env.KIDS_NETWORK||'localnet';
 if(env.KIDS_SIGNER_URL){
  if(!env.KIDS_SIGNER_TOKEN||!env.KIDS_SIGNER_PUBKEY)return {mode:'invalid',reason:'KIDS_SIGNER_TOKEN and KIDS_SIGNER_PUBKEY are required with KIDS_SIGNER_URL'};
  if(env.KIDS_OPERATOR_KEY_JSON)return {mode:'invalid',reason:'KIDS_OPERATOR_KEY_JSON must be removed from the API service when a signer is configured'};
  return {mode:'signer',publicKey:env.KIDS_SIGNER_PUBKEY,wipeLocalKey:true};
 }
 if(network==='mainnet')return {mode:'invalid',reason:'mainnet requires the signer service (KIDS_SIGNER_URL); the API never holds the operator key'};
 if(env.KIDS_ALLOW_LOCAL_OPERATOR_KEY==='1')return {mode:'local',wipeLocalKey:false};
 return {mode:'invalid',reason:'set KIDS_SIGNER_URL (production) or KIDS_ALLOW_LOCAL_OPERATOR_KEY=1 (tests only)'};
}
