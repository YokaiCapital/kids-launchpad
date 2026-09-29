export const DEFAULT_COIN_DESCRIPTION='Fartcoin × Buttcoin = Shartcoin. Two communities. One unfortunate combination.';
const OLD_DESCRIPTION='Fartcoin × Buttcoin = SHART. Two communities. One unfortunate combination.';
export const resolveCoinDescription=value=>value===undefined||value===OLD_DESCRIPTION?DEFAULT_COIN_DESCRIPTION:value;
export const resolveCoinAuthor=value=>['SHART · Dev','SHART · Owner'].includes(value)?'Shartcoin · Dev':value;

export const resolveCoinPost=value=>value==='Welcome to SHART. Follow allocation progress and launch updates here. Real deposits are not open.'?'Welcome to Shartcoin. Follow allocation progress and launch updates here. Real deposits are not open.':value;
