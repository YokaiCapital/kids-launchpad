import {accountPlugin} from "./server/account-plugin.mjs";
import {adminPlugin} from "./server/admin-plugin.mjs";
import { defineConfig } from "vite";
import {parentLookupPlugin} from "./server/parent-lookup.mjs";
import {demoPersistencePlugin} from "./server/demo-plugin.mjs";
import react from "@vitejs/plugin-react";

export default defineConfig({
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
});
