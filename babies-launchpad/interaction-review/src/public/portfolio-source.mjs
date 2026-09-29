import {loadCampaign} from './campaign-source.mjs';
const fullId=/^[1-9A-HJ-NP-Za-km-z]{32,44}:[1-9A-HJ-NP-Za-km-z]{32,44}:[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export async function loadPortfolioPage({owner,cursor=null,signal},api,load=loadCampaign){
 const session=await api('state',undefined,undefined,{signal});signal?.throwIfAborted();if(session.owner!==owner)throw Error('Portfolio wallet changed');
 const result=await api('launches/portfolio/read',{cursor},session.csrf,{signal});signal?.throwIfAborted();
 const c=result.coverage;if(result.owner!==owner||!Array.isArray(result.campaignIds)||result.campaignIds.length>20||new Set(result.campaignIds).size!==result.campaignIds.length||result.campaignIds.some(id=>!fullId.test(id))||result.nextCursor!==null&&(typeof result.nextCursor!=='string'||!/^\d{1,15}$/.test(result.nextCursor))||!c||['campaigns','indexed','fresh'].some(k=>!Number.isSafeInteger(c[k])||c[k]<0)||c.fresh>c.indexed||c.indexed>c.campaigns||c.complete!==(c.campaigns===c.fresh)||c.includes!=='launch-receipts-and-creator-allocations'||c.tokenHoldingsIndexed!==false)throw Error('Portfolio discovery could not be verified');
 const campaigns=[],failures=[];for(let i=0;i<result.campaignIds.length;i+=4){signal?.throwIfAborted();await Promise.all(result.campaignIds.slice(i,i+4).map(async id=>{try{const vm=await load(id,{signal});if(!vm||vm.id!==id)throw Error('Launch record unavailable');campaigns.push(vm);}catch(e){signal?.throwIfAborted();failures.push(e.message);}}));}
 campaigns.sort((a,b)=>result.campaignIds.indexOf(a.id)-result.campaignIds.indexOf(b.id));
 return {campaigns,nextCursor:result.nextCursor,coverage:c,failures,fixture:false,chainTimeUnix:null,fetchedAtUnix:Math.floor(Date.now()/1000)};
}
