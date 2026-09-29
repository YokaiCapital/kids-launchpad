// Hash routes of the public pages (#explore, #launch-new, #coin/<campaignId>, #portfolio, #my-launches). Pure helpers so
// the parsing is testable without a browser. A malformed percent-escape in a shared link must render the not-found
// state, never throw inside a render (an uncaught URIError there unmounts the whole app).
export const coinHref=campaign=>'#coin/'+encodeURIComponent(campaign);
/** The second hash segment, decoded: '#coin/abc%20d' -> 'abc d'; nothing or a bad escape -> null. */
export function subFromHash(hash){
 const parts=String(hash||'').replace(/^#/,'').split('/');
 if(!parts[1])return null;
 try{return decodeURIComponent(parts[1]);}catch{return null;}
}
