import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Daedalus preview bridge: reports runtime errors and navigation from the live preview to the
// Daedalus workspace so the agent can see and fix them. Dev server only; keep this plugin.
function daedalusBridge(): Plugin {
  return {
    name: "daedalus-bridge",
    apply: "serve",
    transformIndexHtml: () => [{ tag: "script", attrs: { src: "/__daedalus/bridge.js" }, injectTo: "head-prepend" }],
  };
}

export default defineConfig({
  plugins: [daedalusBridge(), react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // The preview is served through the sandbox's public URL, so accept any Host header.
    allowedHosts: true,
    hmr: process.env.DAEDALUS_PREVIEW_HTTPS ? { clientPort: 443, protocol: "wss" } : undefined,
  },
});
