// Accepted program builds. A program upgrade lands on chain between two service uploads, so the running service must
// recognise both the build it was uploaded against and the build it is about to be upgraded to. Every accepted build is
// recorded in deployment/MAINNET-IDENTITIES.json (`program.builds`), each with the features it introduces; the keeper
// plans only what the live build supports (a v1 program has no burn instruction, so coin-side fees are converted).
import {createHash} from 'node:crypto';
export const CURRENT_FEATURES=Object.freeze(['burn-child-fees','cpmm-config-allowlist']);
/** Every build the service accepts on chain: the recorded primary first, then the listed ones. */
export function acceptedBuilds(program={}){
 const out=[];const push=b=>{if(b?.sha256&&Number.isSafeInteger(b.binarySize)&&b.binarySize>0&&!out.some(o=>o.sha256===b.sha256))out.push({sha256:b.sha256,binarySize:b.binarySize,features:Object.freeze([...(b.features||[])])});};
 if(program.binarySha256)push({sha256:program.binarySha256,binarySize:program.binarySize,features:program.features||[]});
 for(const b of program.builds||[])push(b);
 return out;
}
/** The accepted build whose bytes are on chain (program-data body, header stripped), or null when none matches. */
export function matchBuild(body,builds){
 for(const build of builds){
  if(build.binarySize>body.length)continue;
  if(createHash('sha256').update(body.subarray(0,build.binarySize)).digest('hex')!==build.sha256)continue;
  if(body.subarray(build.binarySize).some(n=>n!==0))continue;
  return build;
 }
 return null;
}
/** Features of a program manifest: the recorded list, or on localnet (always the current source) every current feature. */
export function manifestFeatures(manifest,network=manifest?.network){
 if(Array.isArray(manifest?.features))return manifest.features;
 return network==='localnet'?[...CURRENT_FEATURES]:[];
}
