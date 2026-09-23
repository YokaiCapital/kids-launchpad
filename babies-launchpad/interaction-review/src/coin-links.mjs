// Shartcoin's public links (owner, 23 Sep 2026). The dev profile served by the API may override them; these are the
// defaults shown on the launch and coin pages when the profile carries no link.
export const COIN_LINKS=Object.freeze({xUrl:'https://x.com/shartcoinkids'});
export function coinLink(profile,key){const v=profile?.[key];return typeof v==='string'&&/^https:\/\//.test(v)?v:COIN_LINKS[key]||null;}
