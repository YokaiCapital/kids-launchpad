// Program versions are selected by server-owned deployment configuration. The
// account layout remains 2 for both issuers; it is never a version-discovery hint.
export function publicIssuerVersion(value=2){
 if(value!==2&&value!==3)throw Error('Unsupported public issuer program version');
 return value;
}
