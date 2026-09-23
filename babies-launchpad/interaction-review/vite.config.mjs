import {accountPlugin} from "./server/account-plugin.mjs";
import {adminPlugin} from "./server/admin-plugin.mjs";
import { defineConfig } from "vite";
import {parentLookupPlugin} from "./server/parent-lookup.mjs";
import {demoPersistencePlugin} from "./server/demo-plugin.mjs";
import react from "@vitejs/plugin-react";

// Production builds are for mainnet unless VITE_KIDS_NETWORK says otherwise: the page refuses a server on another
// network (network-label.mjs), and a build made without the flag once refused the live server (23 Sep 2026).
export default defineConfig(({mode}) => ({
  define: {
    "import.meta.env.VITE_KIDS_NETWORK": JSON.stringify(process.env.VITE_KIDS_NETWORK || (mode === "production" ? "mainnet" : "localnet")),
  },
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), adminPlugin(), accountPlugin(), parentLookupPlugin(), demoPersistencePlugin()],
}));
