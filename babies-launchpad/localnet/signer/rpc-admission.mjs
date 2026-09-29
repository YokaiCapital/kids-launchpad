// One explicit shared RPC allocation for signer evidence, separate from worker
// submission and interactive pools. This never changes signing/spend limits.
import {createAdmissionGuard,admittedConnection} from '../jobs/admission.mjs';
import {waitForRpcAdmission} from '../rpc-transport.mjs';
export function createSignerRpcChannel({registry,connection,resource,ratePerSecond,burst}){
 if(!Number.isInteger(ratePerSecond)||ratePerSecond<1||ratePerSecond>1000||!Number.isInteger(burst)||burst<1||burst>1000)throw Error('Explicit bounded signer RPC policy required');
 const policy={ratePerSecond,burst,lanes:{signer:{ratePerSecond,burst}}};
 const guard=createAdmissionGuard({registry,resource,lane:'signer',policy});
 const admit=()=>waitForRpcAdmission(guard,{waitMs:1000});
 return {admit,connection:admittedConnection(connection,admit)};
}
