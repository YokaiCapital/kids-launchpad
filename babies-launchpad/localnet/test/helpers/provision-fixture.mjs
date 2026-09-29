import {Keypair,PublicKey,SystemProgram} from '@solana/web3.js';
import {createMintIntent} from '../../creation/mint-packet.mjs';
import {createProvisionIntent,provisionTerms,reviewedProvisionPolicy} from '../../creation/provision-packet.mjs';
import {campaignAddress,launchAuthority,createInstruction,WSOL,AMM_CONFIG_TIERS} from '../../protocol-v2/client.mjs';
import {readPresets,presetTerms,presetsHash} from '../../registry/presets.mjs';
const address=()=>Keypair.generate().publicKey.toBase58();
export function provisionFixture(){
 const creator=Keypair.generate(),owner=creator.publicKey.toBase58(),programId=address(),genesisHash=address(),nonce='123',campaign=campaignAddress(programId,owner,nonce).toBase58(),authority=launchAuthority(programId,campaign).toBase58();
 const mint=createMintIntent({preparation:{programVersion:3,state:'reserved',fundingEnabled:false,requestId:'request-one',leaseId:'lease-one',genesisHash,programId,campaign,authority,nonce,mint:'7e2g1HXJQPCMLED6PQZhHwzYw9iGemwPuUc5FAFMkids'},creator:owner,rentLamports:'1461600',metadata:{name:'Local coin',symbol:'LocalCoin',uri:'https://example.com/local.json',documentHash:'a'.repeat(64)}});
 const manifest=readPresets(),tier=AMM_CONFIG_TIERS[0];manifest.agreed.feePolicy={...manifest.agreed.feePolicy,ammConfig:tier.address.toBase58(),ammConfigIndex:2,tradeFeeBps:200};
 const quote={terms:presetTerms(manifest,{mode:'standard',capPresetId:'default'}).terms,policyHash:presetsHash(manifest),planHash:'b'.repeat(64)};
 const intent=createProvisionIntent({mint,policy:reviewedProvisionPolicy(quote),treasury:address(),opensAt:'2000000000',authorityBudgetLamports:'300000000'}),block={blockhash:address(),lastValidBlockHeight:150,observedSlot:50};
 return {creator,intent,block,quote};
}

import {MintLayout,AccountLayout} from '@solana/spl-token';
import {TOKEN_PROGRAM,CAMPAIGN_MAGIC} from '../../protocol-v2/client.mjs';
import {METADATA_PROGRAM} from '../../token-metadata.mjs';
export function provisionAccounts(intent){
 const m=intent.mint,zero=PublicKey.default,mint=Buffer.alloc(82),child=Buffer.alloc(165),native=Buffer.alloc(165),campaign=Buffer.alloc(1024);
 MintLayout.encode({mintAuthorityOption:0,mintAuthority:zero,supply:BigInt(m.supply),decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:zero},mint);
 const base={owner:new PublicKey(m.authority),delegateOption:0,delegate:zero,state:1,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:zero};
 AccountLayout.encode({...base,mint:new PublicKey(m.mint),amount:BigInt(m.supply),isNativeOption:0,isNative:0n},child);
 AccountLayout.encode({...base,mint:WSOL,amount:0n,isNativeOption:1,isNative:2039280n},native);
 const str=s=>{const b=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b]);};
 const metadata=Buffer.concat([Buffer.from([4]),new PublicKey(m.creator).toBuffer(),new PublicKey(m.mint).toBuffer(),str(m.metadata.name),str(m.metadata.symbol),str(m.metadata.uri),Buffer.alloc(5)]);
 const created=createInstruction(m.programId,provisionTerms(intent));CAMPAIGN_MAGIC.copy(campaign);created.sealed.copy(campaign,8);created.hash.copy(campaign,808);
 const account=(data,owner,lamports=10000000)=>({data,owner,executable:false,lamports});
 return {context:{slot:101},value:[account(campaign,new PublicKey(m.programId)),account(Buffer.alloc(0),SystemProgram.programId,Number(intent.authorityBudgetLamports)),account(native,TOKEN_PROGRAM),account(mint,TOKEN_PROGRAM),account(child,TOKEN_PROGRAM),account(metadata,METADATA_PROGRAM)]};
}
