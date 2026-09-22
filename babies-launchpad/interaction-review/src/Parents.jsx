export function ParentIcon({name}) {
 return name==='Fartcoin'?<img className="parent-token-icon" src="/assets/parent-fartcoin.webp" alt="Fartcoin logo"/>:<img className="parent-token-icon" src="/assets/parent-buttcoin.png" alt="Buttcoin logo"/>;
}
export function Parents(){
 return <div className="coin-parentage" aria-label="Shartcoin is the kid of Fartcoin and Buttcoin"><span className="parentage-caption">THE PARENTS</span><div className="parentage-pair"><span><ParentIcon name="Fartcoin"/><strong>Fartcoin</strong></span><b aria-hidden="true">+</b><span><ParentIcon name="Buttcoin"/><strong>Buttcoin</strong></span><b aria-hidden="true">→</b><strong className="parentage-child">Shartcoin</strong></div></div>;
}
