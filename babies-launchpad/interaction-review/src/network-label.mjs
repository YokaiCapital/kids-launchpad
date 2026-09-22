// Plain-word labels for whichever ledger the API reports. Built-time VITE_KIDS_NETWORK (not a secret) says which
// network this site build is meant for; the API's `network` field must agree or the page refuses to act.
export const SITE_NETWORK=import.meta.env?.VITE_KIDS_NETWORK||'localnet';
const LABELS={localnet:{name:'Localnet',ledger:'the test ledger',on:'on localnet',live:false},devnet:{name:'Devnet',ledger:'devnet',on:'on devnet',live:false},mainnet:{name:'Solana',ledger:'Solana',on:'on Solana',live:true}};
export const KNOWN_NETWORKS=Object.keys(LABELS);
export function netLabel(network){return LABELS[network]||LABELS.localnet;}
export function explorerTx(data,signature){return data?.explorerUrl&&signature?data.explorerUrl.replace(/\/$/,'')+'/tx/'+signature+(data.explorerCluster||''):null;}
export function explorerAccount(data,address){return data?.explorerUrl&&address?data.explorerUrl.replace(/\/$/,'')+'/account/'+address+(data.explorerCluster||''):null;}
