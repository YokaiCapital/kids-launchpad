import {isAddress,parseCampaignId} from '../../localnet/registry/registry.mjs';
/** Authenticated discovery only. The same bounded wallet read verifies current
 * amounts after discovery; database membership is never transaction approval. */
export function createPublicPortfolioReader({store,genesisHash,programId}){
 if(!store?.discover||!isAddress(genesisHash)||!isAddress(programId))throw Error('Scoped portfolio discovery required');
 return {async read(owner,{cursor=null}={}){
  if(!isAddress(owner)||cursor!==null&&(typeof cursor!=='string'||!/^\d{1,15}$/.test(cursor)||Number(cursor)<1))throw Error('Invalid portfolio cursor');
  const result=await store.discover({genesisHash,programId,owner,before:cursor===null?null:Number(cursor),limit:20});
  if(!Array.isArray(result.campaignIds)||result.campaignIds.length>20||result.campaignIds.some(id=>{const c=parseCampaignId(id);return !c||c.genesisHash!==genesisHash||c.programId!==programId;}))throw Error('Portfolio discovery scope mismatch');
  return {...result,owner,nextCursor:result.nextCursor===null?null:String(result.nextCursor)};
 }};
}
