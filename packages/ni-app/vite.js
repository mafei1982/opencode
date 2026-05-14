import { readFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"
import path from "path"

const appPublic = fileURLToPath(new URL("../app/public", import.meta.url))
const themeFile = path.join(appPublic, "oc-theme-preload.js")

function getNiWorkspaceDir() {
  const home = homedir()
  if (process.platform === "win32") {
    return path.join(home, ".local", "share", "ni-opencode")
  }
  return path.join(home, ".local", "share", "ni-opencode")
}

function ensureNiWorkspaceDir() {
  const dir = getNiWorkspaceDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

// Ensure workspace dir exists at import time (covers build, dev, preview)
ensureNiWorkspaceDir()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "ni-app:config",
    config() {
      return {
        define: {
          __NI_WORKSPACE_DIR__: JSON.stringify(getNiWorkspaceDir()),
        },
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        worker: {
          format: "es",
        },
        publicDir: appPublic,
      }
    },
    configureServer(server) {
      ensureNiWorkspaceDir()
      // Also ensure via middleware on first request (in case dir was deleted)
      let checked = false
      server.middlewares.use((_req, _res, next) => {
        if (!checked) {
          ensureNiWorkspaceDir()
          checked = true
        }
        next()
      })
    },
    configurePreviewServer() {
      ensureNiWorkspaceDir()
    },
  },
  {
    name: "ni-app:theme-preload",
    transformIndexHtml(html) {
      if (!existsSync(themeFile)) return html
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(themeFile, "utf8")}</script>`,
      )
    },
  },
  tailwindcss(),
  solidPlugin(),
]
