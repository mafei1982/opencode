import { defineConfig } from "vite"
import niAppPlugin from "./vite"

const backendUrl = `http://${process.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${process.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`

export default defineConfig({
  plugins: [niAppPlugin] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3001,
    proxy: {
      "/auth": backendUrl,
      "/health": backendUrl,
      "/global": backendUrl,
      "/agent": backendUrl,
      "/provider": backendUrl,
      "/config": backendUrl,
      // Proxy /session API calls but not client-side /session/<id> page navigations
      // API calls use Accept: application/json or non-GET methods
      "/session": {
        target: backendUrl,
        bypass(req) {
          // Let browser navigations (HTML requests) fall through to the SPA
          if (req.method === "GET" && req.headers.accept?.includes("text/html")) {
            return req.url
          }
        },
      },
    },
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
})
