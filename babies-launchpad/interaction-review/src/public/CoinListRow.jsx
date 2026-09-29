import {solAmount,formatCountdown,formatUtc} from './campaign-adapter.mjs';
import {CapMeter} from './FundingSummary';
import {Pfp} from './CoinMedia';
import {ParentPair} from './CoinIdentity';
import {ExactAmount} from './ExactAmount';
import {DataFreshness} from './DataFreshness';
/**
 * CoinListRow (spec §3): 88 px desktop row with aligned columns, stacked card under 900 px. Family parents sit
 * under the identity; Standard has no empty parent row. Open rows show committed / hard and the cap ruler and say
 * "Still open" above the cap; live rows show FDV and liquidity with a timestamp, never a funding meter.
 */
export function CoinListRow({row,href,onOpen,clock}){
 const now=clock();
 const f=row.funding;
 const statusClass={open:'is-open',upcoming:'is-pending',live:'is-live',ended:row.statusLabel==='Refunds'?'is-problem':'is-muted',launching:'is-pending',unknown:'is-muted'}[row.bucket];
 return <article className="pl-coinrow" aria-label={row.name+' ('+row.statusLabel+')'}>
  <div className="pl-coinrow-pfp"><Pfp src={row.pfp} name={row.name} size={48}/></div>
  <div className="pl-coinrow-id">
   <a href={href} onClick={e=>{if(onOpen&&!e.metaKey&&!e.ctrlKey){e.preventDefault();onOpen();}}}>{row.name}<span>{row.symbol?'$'+row.symbol:''}</span></a>
   {row.mode==='family'&&<ParentPair parents={row.parents}/>}
  </div>
  <div className="pl-coinrow-type">{row.mode==='family'?'Family':'Standard'}</div>
  <div className="pl-coinrow-fund">
   {f.kind==='meter'&&<>
    <div><strong className="pl-num"><ExactAmount amount={solAmount(f.committedLamports)} unit={false}/> / {solAmount(f.hardLamports).compact} SOL</strong>{f.meter.overHard&&<span className="pl-muted"> · {f.meter.committedPct}%</span>}{f.stillOpen&&f.meter.reachedHard&&<span className="pl-muted"> · Still open</span>}</div>
    <CapMeter committedLamports={f.committedLamports} softLamports={f.softLamports} hardLamports={f.hardLamports} mini/>
    {f.stillOpen&&f.deadlineUnix!=null&&<span className="pl-muted pl-num">closes in {formatCountdown(f.deadlineUnix-now)}</span>}
   </>}
   {f.kind==='countdown'&&<div><strong className="pl-num">{f.opensAtUnix!=null?'starts in '+formatCountdown(f.opensAtUnix-now):'Opening date to be announced'}</strong>{f.opensAtUnix!=null&&<span className="pl-muted"><br/>{formatUtc(f.opensAtUnix)}</span>}</div>}
   {f.kind==='market'&&(f.market?<>
    <div className="pl-metric-pair"><div><span>FDV</span><strong><ExactAmount amount={solAmount(f.market.fdvLamports??0)}/></strong></div><div><span>Liquidity</span><strong>{f.market.liquidityLamports!=null?<ExactAmount amount={solAmount(f.market.liquidityLamports)}/>:'—'}</strong></div></div>
    {f.market.asOfUnix!=null&&<DataFreshness fetchedAtUnix={f.market.asOfUnix} staleAfterSeconds={120}/>}
   </>:<span className="pl-muted">Market data unavailable</span>)}
   {f.kind==='ended'&&<div><strong className="pl-num">{solAmount(f.committedLamports).compact} SOL committed</strong><span className="pl-muted"><br/>{f.reachedSoft?'Launch window closed':'Below the '+solAmount(f.softLamports).compact+' SOL minimum'} · refunds open</span></div>}
  </div>
  <div className="pl-coinrow-status"><span className={'pl-pill '+statusClass}><i aria-hidden="true"/>{row.statusLabel}</span></div>
  <div className="pl-coinrow-action"><button type="button" className={row.action==='Commit'||row.action==='Trade'?'primary pl-btn-sm':'pl-btn-sm'} onClick={onOpen} aria-label={row.action+' '+row.name}>{row.action}</button></div>
 </article>;
}
export function CoinListRowSkeleton(){
 return <div className="pl-coinrow is-skel" aria-hidden="true">
  <span className="pl-skel pl-pfp" style={{width:48,height:48}}/>
  <div className="pl-coinrow-id"><span className="pl-skel" style={{width:'40%',height:18}}/><span className="pl-skel" style={{width:'25%',height:12,marginTop:6}}/></div>
  <span className="pl-skel" style={{width:60,height:14}}/>
  <div className="pl-coinrow-fund"><span className="pl-skel" style={{width:'70%',height:14}}/><span className="pl-skel" style={{width:'100%',height:6}}/></div>
  <span className="pl-skel" style={{width:70,height:26,borderRadius:999}}/>
  <span className="pl-skel" style={{width:'100%',height:36,borderRadius:12}}/>
 </div>;
}
