import {savedMint,shortMint,tokenAmount,thresholdRaw} from './mint.js';
export const parents = ['BONK','dogwifhat','POPCAT','MEW','PENGU','WEN','Fartcoin','Buttcoin','ALPHA','BETA','GAMMA','DELTA'];
const concepts = [
 ['Bonkhat','BHAT','BONK','dogwifhat','sprout','A tiny dog with a hat far too big for its head.'],
 ['Popwif','PWIF','POPCAT','dogwifhat','miso','One loud cat. One very questionable hat.'],
 ['Mewbonk','MBONK','MEW','BONK','nib','A cat raised by dogs. Zero survival instincts.'],
 ['Pengpop','PPOP','PENGU','POPCAT','fizz','A penguin who learned to pop instead of waddle.'],
 ['Wenhat','WHEN','WEN','dogwifhat','gloop','Always late. Always wearing the hat.'],
 ['Toot','TOOT','Fartcoin','BONK','pip','A small dog with a very loud entrance.'],
 ['Buttcat','BCAT','Buttcoin','POPCAT','miso','The internet’s least dignified cat.'],
 ['Snowmew','SMEW','PENGU','MEW','nib','A snow cat adopted by the penguin colony.'],
 ['Bonkpop','BPOP','BONK','POPCAT','fizz','Barks once. Pops twice.'],
 ['Wenpeng','WPENG','WEN','PENGU','sprout','Still waiting for its first flight.'],
 ['Mewhat','MHAT','MEW','dogwifhat','gloop','Nine lives. One hat.'],
 ['Poot','POOT','Fartcoin','PENGU','pip','A penguin with suspicious jet propulsion.'],
];
export const candidates = concepts.map(([name,ticker,a,b,art,description],i)=>({id:`K009-${String(i+1).padStart(3,'0')}`,name,ticker,parents:[a,b],art:`/assets/${art}.png`,description,votes:[250000,200000,175000,150000,125000,100000,75000,60000,45000,30000,25000,15000][i],index:i,hash:`concept-round-v2-${i+1}`}));
export function ballot({query='', parent='', sort='Discover', seed='round-009-session-1', boostId=null}) {
  const q = query.toLowerCase().trim();
  const hash = str => { let n = 2166136261; for (const c of str) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n >>> 0; };
  return candidates.filter(c => (!parent || c.parents.includes(parent)) && `${c.name} ${c.ticker} ${c.parents.join(' ')} ${c.id}`.toLowerCase().includes(q)).sort((a,b) => sort === 'Most voted' ? (b.votes+(b.id===boostId?25000:0))-(a.votes+(a.id===boostId?25000:0)) || a.id.localeCompare(b.id) : sort === 'New' ? b.index-a.index : hash(seed+a.id)-hash(seed+b.id) || a.id.localeCompare(b.id));
}
export const emptyDraft = { a:'Fartcoin', b:'Buttcoin', name:'', ticker:'', description:'', art:'', rights:false };
export function normalizeDraft(value) {
  const d = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = (key, max) => typeof d[key] === 'string' ? d[key].slice(0,max) : '';
  const art = text('art',2100000);
  const parentData={a:savedMint(d.parentData?.a),b:savedMint(d.parentData?.b)};
  const parentKey=key=>parents.includes(d[key])?d[key]:parentData[key]&&parentData[key].mint===d[key]?d[key]:(key==='a'?'ALPHA':'BETA');
  return {a:parentKey('a'),b:parentKey('b'),parentData,proposalId:typeof d.proposalId==='string'&&/^DEMO-P-\d+$/.test(d.proposalId)?d.proposalId:null,
    name:text('name',28), ticker:text('ticker',10).toUpperCase(), description:text('description',180),
    art: /^\/assets\/[a-z0-9-]+\.png$/.test(art) || /^data:image\/(png|webp);base64,[A-Za-z0-9+/=]+$/.test(art) ? art : '', rights:d.rights===true};
}
export function readDraft() { try { const saved=localStorage.getItem('kidfun-draft-v1');return saved?normalizeDraft(JSON.parse(saved)):{...emptyDraft}; } catch { return {...emptyDraft}; } }
export function draftError(d, stage=3) {
  if(!['a','b'].every(k=>parents.includes(d[k]) || d[k]&&savedMint(d.parentData?.[k])?.mint===d[k]) || d.a===d.b) return 'Choose two different parents. Your other fields are kept.';
  if(stage>=2 && (!d.name.trim() || !/^[A-Z0-9]{2,10}$/.test(d.ticker) || !d.description.trim() || !d.art)) return 'Add a name, 2–10 letter/number ticker, description and artwork.';
  if(stage>=3 && !d.rights) return 'Confirm that you own or have permission to use this artwork.';
  return '';
}
export function restoreVote(value) {
  const candidate=candidates.find(c=>c.id===value?.candidate?.id && c.hash===value?.candidate?.hash);
  return candidate && typeof value.receipt==='string' && /^DEMO-009-\d+$/.test(value.receipt) ? {candidate,receipt:value.receipt} : null;
}
export function recordVote(previous, candidate, {scenario='Normal',wallet=true,power=25000,now=Date.now()}={}) {
  if(scenario==='Offline') return {vote:previous,error:'Could not reach the ballot service. Your previous recorded demo vote is unchanged. Retry when ready.'};
  if(scenario==='Closed') return {vote:previous,error:'The round closed before acceptance. Your previous recorded demo vote is unchanged.'};
  if(!wallet || !power) return {vote:previous,error:'This demo wallet has no voting power.'};
  const canonical=candidates.find(c=>c.id===candidate?.id && c.hash===candidate?.hash);
  if(!canonical) return {vote:previous,error:'This proposal version is unavailable. Choose a candidate from the current ballot.'};
  return {vote:previous?.candidate.id===canonical.id ? previous : {candidate:canonical,receipt:`DEMO-009-${now}`},error:''};
}
export function restoreProposal(value) {
  if(!value || typeof value.id!=='string' || !/^DEMO-P-\d+$/.test(value.id) || !['Awaiting review','Changes requested','Approved for next round','Superseded'].includes(value.status)) return null;
  return {...normalizeDraft(value),id:value.id,status:value.status,version:Number.isSafeInteger(value.version)&&value.version>0?value.version:1,round:Number.isSafeInteger(value.round)&&value.round>=10?value.round:10,submittedAt:typeof value.submittedAt==='string'?value.submittedAt:null};
}

export const parentLabel=value=>parents.includes(value)?value:shortMint(value);
export function parentThreshold(d,key) {const info=savedMint(d.parentData?.[key]);return info?tokenAmount(thresholdRaw(info.supply),info.decimals):'500,000';}
export function readHistory() {
  try {const current=JSON.parse(localStorage.getItem('kidfun-proposals-v2')||'null');if(Array.isArray(current))return current.map(restoreProposal).filter(Boolean);
    const old=restoreProposal(JSON.parse(localStorage.getItem('kidfun-demo-proposal-v1')||'null'));return old?[old]:[];
  }catch{return [];}
}
export function submitVersion(records,draft,now=Date.now()) {
  const problem=draftError(draft);if(problem)throw Error(problem);
  const lineage=records.filter(p=>p.id===draft.proposalId);
  const version=Math.max(0,...lineage.map(p=>p.version))+1;
  let id=lineage.length?draft.proposalId:`DEMO-P-${now}`;
  if(!lineage.length)while(records.some(p=>p.id===id))id=`DEMO-P-${++now}`;
  const proposal={...normalizeDraft(draft),id,proposalId:id,version,status:'Awaiting review',submittedAt:new Date(now).toISOString()};
  return {proposal,records:[...records.map(p=>p.id===id&&p.status!=='Approved for next round'?{...p,status:'Superseded'}:p),proposal]};
}
export function reviewVersion(records,id,version,status) {
  if(!['Changes requested','Approved for next round'].includes(status))throw Error('Invalid review state');
  return records.map(p=>p.id===id&&p.version===version&&p.status==='Awaiting review'?{...p,status,...(status==='Approved for next round'?{round:Math.max(9,...records.filter(r=>r.id===id&&r.status==='Approved for next round').map(r=>r.round||10))+1}:{})}:p);
}
