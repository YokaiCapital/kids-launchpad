import {accountPlugin} from "./server/account-plugin.mjs";
import {adminPlugin} from "./server/admin-plugin.mjs";
import { defineConfig } from "vite";
import {parentLookupPlugin} from "./server/parent-lookup.mjs";
import {demoPersistencePlugin} from "./server/demo-plugin.mjs";
import react from "@vitejs/plugin-react";
import {mediaCspDirectives} from "./src/public/media-hosts.mjs";

// Public launches only (VITE_KIDS_PUBLIC_LAUNCHES=1): a Content-Security-Policy meta tag that restricts images and media
// to the site and the media allow-list (src/public/media-hosts.mjs). Only img-src and media-src are set: the rest of a
// policy (script-src, style-src, connect-src) needs the inline analytics bootstrap in index.html, the wallet standard
// and the chart library verified against it first, and the gate (deployment/gate.mjs) sets headers for its own pages
// only, so a full policy is deferred to its own change. With the flag off the built index.html is byte-identical to
// before.
const publicLaunchesCsp=()=>({name:"kids-public-launches-csp",transformIndexHtml:{order:"pre",handler(){if(process.env.VITE_KIDS_PUBLIC_LAUNCHES!=="1")return;return [{tag:"meta",attrs:{"http-equiv":"Content-Security-Policy",content:mediaCspDirectives()},injectTo:"head-prepend"}];}}});

// Production builds are for mainnet unless VITE_KIDS_NETWORK says otherwise: the page refuses a server on another
// network (network-label.mjs), and a build made without the flag once refused the live server (23 Sep 2026).
export default defineConfig(async ({mode}) => {
 const {startRegistryImport}=await import("../localnet/registry/startup.mjs");
 const {publicServices}=await import("./server/public-services.mjs");
 const {campaignsPluginFor}=await import("./server/campaigns-plugin.mjs");
 const {readCampaignView}=await import("../localnet/registry/read-adapters.mjs");
 // Pilot UI (dev server only): with KIDS_PILOT_API_ORIGIN set, every /api request is proxied to the hosted pilot API's
 // gateway with the service token and the site origin added here, on the operator's machine; no local API is composed and
 // the token never reaches the browser (it is deliberately not a VITE_ variable).
 const pilot=process.env.KIDS_PILOT_API_ORIGIN?(()=>{const origin=new URL(process.env.KIDS_PILOT_API_ORIGIN);const token=process.env.KIDS_PILOT_API_TOKEN;if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.username||origin.password)throw new Error('KIDS_PILOT_API_ORIGIN must be an https origin');if(typeof token!=='string'||token.length<32)throw new Error('KIDS_PILOT_API_TOKEN (the pilot gateway service token) is required');if(mode==='production')throw new Error('The pilot proxy is for the dev server only');return {origin:origin.origin,token};})():null;
 // Release pins for the browser (program audit, 28 September 2026, L2): a mainnet build carries the released program id,
 // genesis hash and treasury from deployment/hosted/release-mainnet.json, and the creator flow refuses a quote that differs.
 const network=process.env.VITE_KIDS_NETWORK||(mode==="production"?"mainnet":"localnet");
 const release=await (async()=>{if(network==="localnet")return null;const {readFileSync,existsSync}=await import("node:fs");const file=new URL("../deployment/hosted/release-"+network+".json",import.meta.url);if(!existsSync(file))return null;const m=JSON.parse(readFileSync(file,"utf8"));return {programId:m.programId,genesisHash:m.genesisHash,treasury:m.treasury};})();
 const registryImport=!pilot&&process.env.KIDS_REGISTRY_URL?startRegistryImport():null;
 const api=pilot?{account:null,manifest:null}:await publicServices({registryImport});
 const campaigns=pilot?null:campaignsPluginFor({registryImport,readView:api.readView||readCampaignView,manifest:api.manifest});
 return ({
  define: {
    "import.meta.env.VITE_KIDS_NETWORK": JSON.stringify(network),
    // Pilot UI only: the sign-in challenge is bound to the public site's origin, not to this machine's address.
    "import.meta.env.VITE_KIDS_PILOT_SITE_ORIGIN": JSON.stringify(pilot?"https://kids.fun":""),
    "import.meta.env.VITE_KIDS_RELEASE_PROGRAM_ID": JSON.stringify(release?.programId||""),
    "import.meta.env.VITE_KIDS_RELEASE_GENESIS_HASH": JSON.stringify(release?.genesisHash||""),
    "import.meta.env.VITE_KIDS_RELEASE_TREASURY": JSON.stringify(release?.treasury||""),
    // Public launches (24 Sep 2026): off unless the build says otherwise, so production bundles none of src/public.
    "import.meta.env.VITE_KIDS_PUBLIC_LAUNCHES": JSON.stringify(process.env.VITE_KIDS_PUBLIC_LAUNCHES === "1" ? "1" : "0"),
    // Local fixtures for those pages: never bundled unless asked for explicitly, whatever the mode.
    "import.meta.env.VITE_KIDS_PUBLIC_LAUNCHES_FIXTURES": JSON.stringify(process.env.VITE_KIDS_PUBLIC_LAUNCHES_FIXTURES === "1" ? "1" : "0"),
  },
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: pilot?"127.0.0.1":"0.0.0.0",
    allowedHosts: ["terminal.local"],
    ...(pilot?{proxy:{"/api":{target:pilot.origin,changeOrigin:true,secure:true,configure(proxy){proxy.on("proxyReq",req=>{req.setHeader("authorization","Bearer "+pilot.token);req.setHeader("origin","https://kids.fun");});}}}}:{}),
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: pilot?[react(), publicLaunchesCsp()]:[react(), publicLaunchesCsp(), adminPlugin(), accountPlugin({publicLaunchService:api.account}), ...(campaigns?[campaigns]:[]), parentLookupPlugin(), demoPersistencePlugin()],
});});
