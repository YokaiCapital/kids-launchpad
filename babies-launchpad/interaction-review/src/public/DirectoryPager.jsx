export function DirectoryPager({source}){
 if(!source.hasPrevious&&!source.nextCursor)return null;
 return <div role="navigation" className="pl-directory-pager" aria-label="Launch pages"><button type="button" disabled={!source.hasPrevious||source.status==='loading'} onClick={source.previous}>Previous</button><span>Page {source.page||1}</span><button type="button" disabled={!source.nextCursor||source.status==='loading'} onClick={source.next}>Next launches</button></div>;
}
