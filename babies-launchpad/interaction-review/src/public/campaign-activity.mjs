import {validatePublicEvent,ACTIVITY_FILTERS,hasMovement} from '../../../shared/public-activity.mjs';
export const ACTIVITY_LABELS=Object.freeze({'campaign-init':'Launch created',commit:'SOL committed',finalize:'Funding closed',refund:'SOL refunded',settle:'Allocation settled',ready:'Launch ready',launch:'Liquidity locked','claim-participant':'Tokens claimed','claim-dev':'Dev tokens claimed','fees-init':'Fee custody created','fees-collect':'LP fees collected','fees-operator':'Fee operator changed','fees-distribute':'SOL fees distributed','burn-child':'Coin fees burned','setup-return':'Unused setup SOL returned','authority-revoked':'Token authority revoked','program-attempt':'Program attempt failed'});
export function validateActivity(data,vm,filter){
 const fail=()=>{throw Error('Activity could not be verified for this coin');};
 if(!data||data.genesisHash!==vm.identity.genesisHash||data.programId!==vm.identity.programId||data.campaign!==vm.identity.campaign||data.commitment!=='finalized')fail();
 if(data.available===false){if(data.status!=='not-indexed')fail();return data;}
 if(data.available!==true||data.mint!==vm.chain.mint||data.coinDecimals!==vm.terms.supply.decimals||data.filter!==filter||!ACTIVITY_FILTERS.includes(filter)||!['live','partial','stale','indexing-error'].includes(data.status)||typeof data.freshness?.stale!=='boolean'||typeof data.coverage?.complete!=='boolean'||!Array.isArray(data.events)||data.events.length>8||data.nextCursor!=null&&(typeof data.nextCursor!=='string'||data.nextCursor.length>150||!/^[0-9A-Za-z:.]+$/.test(data.nextCursor)))fail();
 for(const e of data.events){try{validatePublicEvent(e);}catch{fail();}if(e.campaign!==vm.identity.campaign||e.commitment!=='finalized'||filter==='movements'&&(e.failed||!hasMovement(e))||filter==='failed'&&!e.failed)fail();}
 return data;
}
export async function readCampaignActivity({api,vm,owner,filter='movements',cursor=null,signal}){
 if(!owner)throw Error('Connect your pilot wallet');const session=await api('state',undefined,undefined,{retries:0,signal});if(session.owner!==owner||!session.csrf)throw Error('Wallet changed');
 return validateActivity(await api('launches/activity/read',{campaign:vm.identity.campaign,filter,cursor,limit:8},session.csrf,{retries:0,signal}),vm,filter);
}
