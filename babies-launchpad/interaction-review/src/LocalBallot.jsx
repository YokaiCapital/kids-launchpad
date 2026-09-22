import {getSelectedWallet} from './wallet-connection.mjs';
import {useEffect,useState} from 'react';
import {accountApi} from './Account';
export function LocalBallot({identity,onSignIn}){
 const [rounds,setRounds]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[receipt,setReceipt]=useState(null);
 const refresh=()=>accountApi('rounds').then(setRounds).catch(e=>setError(e.message));
 useEffect(()=>{refresh();const timer=setInterval(refresh,15000);return()=>clearInterval(timer);},[]);
 async function vote(round,proposalHash){
  if(!identity?.owner)return onSignIn();setBusy(true);setError('');
  try{
   const challenge=await accountApi('vote/challenge',{round,proposalHash},identity.csrf);
   const local=Object.values(identity.localIdentities||{}).includes(identity.owner);let signature;
   if(!local){const provider=getSelectedWallet();if(!provider?.signMessage)throw Error('Wallet message signing is unavailable');const signed=await provider.signMessage(new TextEncoder().encode(challenge.signingText),'utf8');signature=btoa(String.fromCharCode(...signed.signature));}
   const result=await accountApi('vote/accept',{id:challenge.id,signature,local},identity.csrf);setReceipt(result);await refresh();
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 if(!rounds.length&&!error)return null;
 return <section className="local-ballots"><h2>Localnet voting</h2>{rounds.slice().reverse().map(round=><article key={round.id}><div className="updates-heading"><h3>{round.id}</h3><span>{round.result?.status||'Closes '+new Date(round.closesAt).toLocaleString()}</span></div><p className="small muted">Finalized KIDS snapshot · Slot {round.snapshot.slot} · {Number(BigInt(round.tally.turnoutRaw)/1000000n).toLocaleString()} KIDS voted</p><div className="proposal-grid">{round.candidates.map(c=><div className="proposal-card" key={c.hash}><h3>{c.terms.name}</h3><p>${c.terms.ticker}</p><p>{c.terms.description}</p><strong>{Number(BigInt(round.tally.totals.find(t=>t.proposalHash===c.hash)?.powerRaw||'0')/1000000n).toLocaleString()} votes</strong><button disabled={busy||!!round.result||Date.now()>=round.closesAt||Date.now()<round.opensAt} onClick={()=>vote(round.id,c.hash)}>Sign vote</button></div>)}</div></article>)}{receipt&&<p role="status">Vote accepted · Receipt {receipt.id}</p>}{error&&<p role="alert" className="warning">{error}</p>}</section>;
}
