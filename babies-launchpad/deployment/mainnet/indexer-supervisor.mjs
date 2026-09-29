// Public-launch indexing service (KIDS_ROLE=indexer): market, fee, activity and position projections per campaign,
// configured by KIDS_MARKET_WORKER_CONFIG (no secrets) plus KIDS_REGISTRY_URL, KIDS_RPC_URL and KIDS_RELEASE_MANIFEST.
for(const name of Object.keys(process.env))if(/^KIDS_(?:OPERATOR_KEY|SIGNER_KEY|SIGNER_TOKEN)/.test(name))throw Error(name+' must not be set on the indexer');
const {main}=await import('../../localnet/market/public-service.mjs');
await main(process.env);
