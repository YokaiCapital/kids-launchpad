// Deployment roles have disjoint job classes. They must also have independent service slots
// and RPC/signer admission budgets; priority in one shared executor is not isolation.
export const WORKER_LANES=Object.freeze({
 provisioning:Object.freeze(['provisioning','metadata','fee-setup','fee-activate']),
 lifecycle:Object.freeze(['launch','settlement','lifecycle-control']),
 recovery:Object.freeze(['claims','refunds','reconcile','operating-return']),
 accounting:Object.freeze(['operating-reconcile','operating-refill']),
 harvest:Object.freeze(['fee-harvest']),
 economics:Object.freeze(['distribution','token-burn','buyback']),
 indexing:Object.freeze(['campaign-index','market-index','fee-index','activity-index','position-index']),
 backfill:Object.freeze(['market-backfill','activity-backfill']),
 maintenance:Object.freeze(['auth-cleanup'])
});
export function laneClasses(lane){
 if(!Object.hasOwn(WORKER_LANES,lane))throw Error('Unknown worker lane');
 return WORKER_LANES[lane];
}
