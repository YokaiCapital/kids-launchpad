import './coin-skeleton.css';

/** Reserve the shape of real content; never show invented balances while loading. */
export function CoinSkeleton({variant='funding'}){
 return <div className={'coin-skeleton coin-skeleton--'+variant} role="status" aria-label="Loading coin details" aria-busy="true">
  <div className="coin-skeleton-shapes" aria-hidden="true">
   <span className="coin-skeleton-line"/>
   <span className="coin-skeleton-value"/>
   <span className="coin-skeleton-bar"/>
   <div className="coin-skeleton-pair"><span/><span/></div>
   {variant!=='status'&&<><span className="coin-skeleton-note"/><span className="coin-skeleton-footer"/></>}
  </div>
 </div>;
}
