// One network profile for the whole server: which ledger the process talks to, how manifests label it, and what
// public links exist. KIDS_NETWORK selects it (default localnet). Devnet and mainnet take their RPC URL from
// KIDS_HELIUS_RPC_URL (server-side only, never written to any manifest, journal or log: manifests carry `rpcLabel`).
export const MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROFILES={
 localnet:{network:'localnet',rpcLabel:'http://127.0.0.1:19099',genesisHash:null,explorerUrl:null,explorerCluster:'',label:'Localnet',live:false},
 devnet:{network:'devnet',rpcLabel:'devnet-helius',genesisHash:DEVNET_GENESIS,explorerUrl:'https://solscan.io',explorerCluster:'?cluster=devnet',label:'Devnet',live:false},
 mainnet:{network:'mainnet',rpcLabel:'mainnet-helius',genesisHash:MAINNET_GENESIS,explorerUrl:'https://solscan.io',explorerCluster:'',label:'Solana',live:true}
};
export const NETWORKS=Object.keys(PROFILES);
export function networkProfile(env=process.env){
 const name=env.KIDS_NETWORK||'localnet';const base=PROFILES[name];if(!base)throw Error('KIDS_NETWORK must be one of '+NETWORKS.join(', '));
 if(name==='localnet')return {...base,rpcUrl:base.rpcLabel};
 const rpcUrl=env.KIDS_HELIUS_RPC_URL;if(typeof rpcUrl!=='string'||!/^https:\/\//.test(rpcUrl))throw Error('KIDS_HELIUS_RPC_URL (https, server-side) is required for '+name);
 return {...base,rpcUrl};
}
/** Explorer link for a signature or address, or null on a private ledger. */
export function explorerLink(profile,kind,value){if(!profile.explorerUrl||!value)return null;return profile.explorerUrl+'/'+(kind==='tx'?'tx':kind==='token'?'token':'account')+'/'+value+profile.explorerCluster;}
export const scopeFor=(profile,active=true)=>active?'active-'+profile.network:profile.network+'-rehearsal';
