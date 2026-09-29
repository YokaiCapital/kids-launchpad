import {useEffect,useRef,useState} from 'react';
import {lookupMint,shortMint,tokenAmount,thresholdRaw} from './mint';
export function ParentPicker({other,onChoose,offline}) {
  const [mode,setMode]=useState('Quick picks'),[query,setQuery]=useState(''),[result,setResult]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const request=useRef(null);
  useEffect(()=>()=>request.current?.abort(),[]);
  function change(value){request.current?.abort();setQuery(value);setResult(null);setError('');setBusy(false);}
  async function search(){
    request.current?.abort();const controller=new AbortController();request.current=controller;setBusy(true);setError('');setResult(null);
    try {if(offline)throw Error('Connection unavailable. Your current parents are kept. Retry after restoring the connection.');const mint=await lookupMint(query.trim(),controller.signal);if(!controller.signal.aborted)setResult(mint);}
    catch(e){if(!controller.signal.aborted)setError(e.message);}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }
  return <><div className="tabs">{['Mint address','Quick picks'].map(m=><button key={m} className={mode===m?'active':''} onClick={()=>{change('');setMode(m);}}>{m}</button>)}</div>
    {mode==='Mint address'?<><p>Verify a mint on the connected Solana localnet. No wallet required.</p><form onSubmit={e=>{e.preventDefault();search();}}><label>Solana mint address<input autoFocus value={query} onChange={e=>change(e.target.value)} placeholder="Paste the full mint address" autoComplete="off" spellCheck={false}/></label><button className="primary" disabled={busy||!query.trim()}>{busy?'Checking mint…':'Look up mint'}</button></form>
    {error&&<p className="warning" role="alert">{error}</p>}{result&&<div className="mint-result" aria-live="polite"><h3>Mint {shortMint(result.mint)}</h3><p className="mint-address">{result.mint}</p><dl><dt>Network</dt><dd>Solana localnet · finalized</dd><dt>Supply</dt><dd>{tokenAmount(result.supply,result.decimals)} tokens</dd><dt>0.05% minimum</dt><dd>{tokenAmount(thresholdRaw(result.supply),result.decimals)} tokens</dd><dt>Observed slot</dt><dd>{result.slot}</dd><dt>Mint / freeze authority</dt><dd>{result.mintAuthority?'Present':'Revoked'} / {result.freezeAuthority?'Present':'Revoked'}</dd></dl><p className="small muted">Account data checked, not an endorsement or proof of a token’s name. Eligibility uses the future published snapshot; supply can change.</p>{!result.supported&&<p className="warning">{result.reason}</p>}<button className="primary" disabled={!result.supported||other===result.mint} onClick={()=>onChoose(result.mint,result)}>{other===result.mint?'Already selected as the other parent':'Use this parent'}</button></div>}</>:<><p>Configured localnet parent tokens. Choose one or paste another localnet mint address.</p><label>Find a parent<input value={query} onChange={e=>change(e.target.value)} placeholder="Search Fartcoin, Buttcoin…"/></label><div className="parent-results">{['Fartcoin','Buttcoin'].filter(p=>p.toUpperCase().includes(query.trim().toUpperCase())).map(p=><button key={p} disabled={other===p} onClick={()=>onChoose(p,null)}><strong>{p}</strong><span>{other===p?'Already selected as the other parent':'Localnet token · Verified again at submission'}</span></button>)}</div></>}
  </>;
}
