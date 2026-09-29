/** Cancel obsolete reads and coalesce identical reads. Financial sends never use this read-only session. */
export function createWalletReadSession(api){
 let flight=null;
 return {
  cancel(){flight?.controller.abort();flight=null;},
  read({owner,campaignIds,readDrafts=false}){
   if(typeof owner!=='string'||!Array.isArray(campaignIds)||campaignIds.length>24||campaignIds.some(id=>typeof id!=='string')||new Set(campaignIds).size!==campaignIds.length)throw Error('Invalid bounded wallet read');
   const key=JSON.stringify([owner,campaignIds,readDrafts]);if(flight?.key===key)return flight.promise;
   flight?.controller.abort();const controller=new AbortController(),entry={key,controller},options={signal:controller.signal};flight=entry;
   entry.promise=(async()=>{
    const session=await api('state',undefined,undefined,options);controller.signal.throwIfAborted();
    if(session.owner!==owner)throw Error('Signed-in wallet changed');
    const [data,saved]=await Promise.all([api('launches/positions',{campaignIds},session.csrf,options),readDrafts?api('launches/drafts',undefined,undefined,options):null]);controller.signal.throwIfAborted();
    if(data.owner!==owner||data.available!==true||!data.positions||typeof data.positions!=='object'||Array.isArray(data.positions)||Object.keys(data.positions).some(id=>!campaignIds.includes(id)))throw Error('Wallet read identity mismatch or unavailable');
    // An omitted campaign is explicitly unknown; it must never look like a verified zero.
    const positions=Object.fromEntries(campaignIds.map(id=>[id,data.positions[id]??{eligibility:'unknown'}]));
    if(saved&&(!Array.isArray(saved.drafts)||saved.drafts.some(d=>d.creator!==owner)))throw Error('Draft wallet identity mismatch');
    return {account:{...data,positions},drafts:saved?.drafts??null};
   })().catch(e=>{controller.abort();throw e;}).finally(()=>{if(flight===entry)flight=null;});return entry.promise;
  }
 };
}
