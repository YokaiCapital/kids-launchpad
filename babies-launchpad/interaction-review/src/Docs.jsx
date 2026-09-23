import {useEffect,useRef,useState} from 'react';
import {DOCS,docHref,docText} from './docs-content';
import './docs.css';
const requestedTopic=()=>location.hash.split('/')[1]||'start';
const groups=[...new Set(DOCS.map(doc=>doc.group))];
const searchText=DOCS.map(doc=>({doc,text:docText(doc).toLowerCase()}));
export function Docs(){
 const [topic,setTopic]=useState(requestedTopic),[query,setQuery]=useState('');
 const heading=useRef(null),first=useRef(true);
 useEffect(()=>{const change=()=>{setTopic(requestedTopic());setQuery('');};window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
 const doc=DOCS.find(item=>item.id===topic),index=DOCS.indexOf(doc);
 useEffect(()=>{if(first.current){first.current=false;return;}heading.current?.focus({preventScroll:true});heading.current?.scrollIntoView({block:'start'});},[topic]);
 const normalized=query.trim().toLowerCase(),matches=normalized?searchText.filter(item=>item.text.includes(normalized)).map(item=>item.doc):[];
 return <div className="kids-docs">
  <a className="kd-skip" href="#kd-article" onClick={event=>{event.preventDefault();heading.current?.focus();}}>Skip to article</a>
  <aside className="kd-sidebar" aria-label="Documentation navigation">
   <a className="kd-library" href="#docs/start">KIDS <span>FIELD GUIDE</span></a>
   <label className="kd-search" htmlFor="kids-doc-search"><span>Find an answer</span><input id="kids-doc-search" type="search" value={query} placeholder="Try refunds or parent rewards" onChange={event=>setQuery(event.target.value)}/></label>
   <div className="kd-mobile-topics"><label htmlFor="kd-topic">Explore the guide</label><select id="kd-topic" value={doc?.id||''} onChange={event=>{location.hash=docHref(event.target.value).slice(1);}}>{!doc&&<option value="">Choose a topic</option>}{DOCS.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
   <nav className="kd-topics" aria-label="Guide topics">{groups.map(group=><div key={group}><p>{group}</p>{DOCS.filter(item=>item.group===group).map(item=><a key={item.id} href={docHref(item.id)} aria-current={!normalized&&item.id===topic?'page':undefined}>{item.title}</a>)}</div>)}</nav>
   <a className="kd-back" href="#shart">← Back to Shartcoin</a>
  </aside>
  <div className="kd-reading">
   {normalized?<section className="kd-article" aria-label="Search results"><p className="kd-eyebrow">SEARCH THE GUIDE</p><h1>Find your answer.</h1><p role="status" className="kd-summary">{matches.length} {matches.length===1?'topic':'topics'} for “{query.trim()}”</p><div className="kd-results">{matches.map(item=><a key={item.id} href={docHref(item.id)} onClick={()=>setQuery('')}><span>{item.group}</span><h2>{item.title}</h2><p>{item.summary}</p><b aria-hidden="true">↗</b></a>)}</div>{!matches.length&&<p>Try “claim”, “cap”, “fees” or “wallet”. <button type="button" onClick={()=>setQuery('')}>Clear search</button></p>}</section>:
   <article className="kd-article" aria-labelledby="kd-article">
    <p className="kd-eyebrow">{doc?.group||'KIDS FIELD GUIDE'}</p>
    <h1 id="kd-article" ref={heading} tabIndex={-1}>{doc?.title||'That topic is not here.'}</h1>
    <p className="kd-summary">{doc?.summary||'Choose a topic from the guide to keep reading.'}</p>
    {doc?.id==='start'&&<div className="kd-flow" aria-label="Launch sequence">{['Commit','Allocate','Launch','Claim'].map((label,i)=><span key={label}><b>{i+1}</b>{label}</span>)}</div>}
    {doc?.sections.map((section,i)=><section className="kd-section" key={section.title} aria-labelledby={'kd-section-'+i}><h2 id={'kd-section-'+i}>{section.title}</h2>{section.paragraphs?.map(p=><p key={p}>{p}</p>)}{section.steps&&<ol>{section.steps.map(step=><li key={step}>{step}</li>)}</ol>}{section.table&&<div className="kd-table" role="region" tabIndex={0} aria-label={section.title+' table'}><table><thead><tr>{section.table.headers.map(cell=><th scope="col" key={cell}>{cell}</th>)}</tr></thead><tbody>{section.table.rows.map(row=><tr key={row[0]}>{row.map((cell,j)=>j===0?<th scope="row" key={j}>{cell}</th>:<td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>}{section.links&&<div className="kd-links">{section.links.map(([label,id])=><a key={id} href={docHref(id)}>{label}<span aria-hidden="true">↗</span></a>)}</div>}{section.external?.map(([label,url])=><a className="kd-external" href={url} key={url} target="_blank" rel="noopener noreferrer">{label} ↗</a>)}</section>)}
    {doc&&<nav className="kd-pagination" aria-label="Previous and next guide topics">{index>0?<a href={docHref(DOCS[index-1].id)}><span>← Previous</span><strong>{DOCS[index-1].title}</strong></a>:<span/>}{index<DOCS.length-1&&<a href={docHref(DOCS[index+1].id)}><span>Next →</span><strong>{DOCS[index+1].title}</strong></a>}</nav>}
    <p className="kd-note">Mechanics guide · Campaign terms and verified on-chain state govern. <a href="#docs/verify">What to verify ↗</a></p>
   </article>}
  </div>
 </div>;
}
