// Public-launch worker service (KIDS_ROLE=worker): one lane per service, configured by KIDS_WORKER_CONFIG (no secrets)
// plus KIDS_REGISTRY_URL, KIDS_RPC_URL, KIDS_RELEASE_MANIFEST and, except for the accounting lane, KIDS_SIGNER_TOKEN.
// The worker proves the release manifest before leasing any job (localnet/jobs/service.mjs, hosted mode).
for(const name of Object.keys(process.env))if(/^KIDS_(?:OPERATOR_KEY|SIGNER_KEY)/.test(name))throw Error(name+' must not be set on a worker');
const {main}=await import('../../localnet/jobs/service.mjs');
await main(process.env);
