// Program upgrade lineage. A campaign, journal or intent records the program binary hash it was created under. The
// program id and genesis never change; the binary may be upgraded by its authority. The manifest therefore keeps
// `lineage`: every hash that was ever deployed under this program id on this ledger, oldest first, with `sha256`
// the current one. Identity checks accept a recorded hash when it is the current hash or in the lineage; anything
// else is a different program and is refused as before (docs/ENGINEERING-RULES.md: bind every operation to its
// network, program, campaign, mint and signer; keep data across deployments).
export function acceptedProgramHash(manifest,sha){
 if(typeof sha!=='string'||!sha)return false;
 return sha===manifest?.sha256||(Array.isArray(manifest?.lineage)&&manifest.lineage.includes(sha));
}
/** The manifest to write after a deploy: a first deploy has no lineage; an upgrade appends the previous hash. */
export function nextProgramManifest(previous,current){
 if(!previous)return {...current,lineage:[]};
 if(previous.programId!==current.programId||previous.genesisHash!==current.genesisHash)throw Error('Persistent ledger identity changed; refusing reset');
 const lineage=[...(previous.lineage||[])];
 if(previous.sha256!==current.sha256&&!lineage.includes(previous.sha256))lineage.push(previous.sha256);
 return {...current,lineage};
}
