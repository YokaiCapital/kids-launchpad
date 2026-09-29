import {createCampaignOperator} from '../operator-lifecycle.mjs';
/** Admit only the finalized, funded, sealed Standard creation owned by this pilot. */
export function createCreationActivation({registry,connection,release,owner,operator=null}){
 operator??=createCampaignOperator({registry,connection,manifest:release});
 return async function activate(snapshot){
  if(snapshot.stage!=='complete'||snapshot.state!=='funded'||snapshot.creationMode!=='single'||!snapshot.operatingReserve?.signature)throw Error('Creation is not funded');
  const id={genesisHash:release.genesisHash,programId:release.programId,campaign:snapshot.campaign};
  const campaign=await registry.campaigns.get(id);
  if(!campaign||campaign.creator!==owner||campaign.campaignVersion!==3||campaign.mode!=='standard'||campaign.treasury!==release.treasury||campaign.terms?.creationSignature!==snapshot.signatures.launch||snapshot.operatingReserve.signature!==snapshot.signatures.launch)throw Error('Creation activation binding differs');
  return registry.transaction(async()=>{
   const existing=(await registry.query('SELECT initial_capability_id FROM standard_lifecycles WHERE genesis_hash=? AND program_id=? AND campaign=?',[id.genesisHash,id.programId,id.campaign])).rows[0];
   if(existing)return {scheduled:true};
   const observation=await operator.status(snapshot.campaign);
   if(observation.chain.creator!==owner||BigInt(observation.budget.availableLamports)<20000000n)throw Error('Creation activation funding unavailable');
   const cap=await registry.capabilities.latest(id);
   if(cap&&(cap.kind!=='keeper'||cap.revokedAt||Date.parse(cap.expiresAt)<=Date.now()))throw Error('Existing capability needs operator review');
   if(!cap)await operator.grantKeeper(snapshot.campaign);
   return operator.schedule(snapshot.campaign);
  },{lockKey:'creation-activation:'+snapshot.campaign});
 };
}
