import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createEmbeddedConfigBundle } from "../core/src/embedded-config"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

const FLASHCODE_EMBEDDED_CONFIG_DIR = process.env.FLASHCODE_EMBEDDED_CONFIG_DIR
const OPENCODE_DISABLE_AGENT_BUILD = process.env.OPENCODE_DISABLE_AGENT_BUILD === "true"
const OPENCODE_DISABLE_AGENT_PLAN = process.env.OPENCODE_DISABLE_AGENT_PLAN === "true"
const truthy = new Set(["1", "true", "yes", "on"])
const falsy = new Set(["0", "false", "no", "off"])

function readBuildBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (truthy.has(normalized)) return true
  if (falsy.has(normalized)) return false
  return fallback
}

const ENABLE_LICENSE_CHECK = readBuildBoolean(process.env.ENABLE_LICENSE_CHECK ?? process.env.enable_license_check, false)

const BINARY_EXTENSIONS = new Set([".exe", ".dll", ".node", ".pdb", ".dylib", ".so", ".config", ".xml"])
const IGNORED_EMBEDDED_CONFIG_FILES = new Set([".gitignore", "package.json", "package-lock.json"])

async function readDirRecursive(dir: string, base = ""): Promise<Record<string, string>> {
  const entries: Record<string, string> = {}
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    const name = entry.name.toLowerCase()
    if (entry.isDirectory()) {
      if (name === "node_modules") continue
      Object.assign(entries, await readDirRecursive(path.join(dir, entry.name), rel))
      continue
    }

    if (IGNORED_EMBEDDED_CONFIG_FILES.has(name)) continue
    if (!BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      entries[rel] = await fs.readFile(path.join(dir, entry.name), "utf-8")
    }
  }
  return entries
}

async function copyServerAssets(dir: string, outDir: string, base = "") {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    const source = path.join(dir, entry.name)
    const target = path.join(outDir, rel)

    if (entry.isDirectory()) {
      await copyServerAssets(source, outDir, rel)
      continue
    }

    if (!rel.endsWith(".wasm") && !rel.startsWith("provider/")) continue
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, await fs.readFile(source))
  }
}

async function bundleToolFile(filePath: string): Promise<string> {
  const { build: esbuild } = await import("esbuild")
  const monorepoRoot = path.resolve(__dirname, "../..")
  const result = await esbuild({
    entryPoints: [filePath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["node:*"],
    write: false,
    nodePaths: [
      path.join(monorepoRoot, "node_modules"),
      path.join(monorepoRoot, "packages"),
    ],
    alias: {
      "@opencode-ai/plugin": path.join(monorepoRoot, "packages/plugin/src/index.ts"),
    },
  })
  const output = result.outputFiles?.[0]
  if (!output) throw new Error(`Failed to bundle tool file ${filePath}`)
  return output.text
}

async function buildEmbeddedConfig(): Promise<string> {
  if (!FLASHCODE_EMBEDDED_CONFIG_DIR) return "export default undefined;"

  const configDir = path.resolve(FLASHCODE_EMBEDDED_CONFIG_DIR)
  const files = await readDirRecursive(configDir)

  // Bundle .ts tool wrappers into .js for Node.js compatibility
  for (const key of Object.keys(files)) {
    if (!key.match(/^tools?\/[^/]+\.ts$/)) continue
    const jsKey = key.replace(/\.ts$/, ".js")
    files[jsKey] = await bundleToolFile(path.join(configDir, key))
    delete files[key]
  }

  // Process agent enable/disable in flashcode.json
  for (const key of ["flashcode.json", "flashcode.jsonc"]) {
    if (!files[key]) continue
    const config = JSON.parse(files[key])
    if (OPENCODE_DISABLE_AGENT_BUILD) {
      config.agent = { ...config.agent, build: { ...(config.agent?.build ?? {}), disable: true } }
    }
    if (OPENCODE_DISABLE_AGENT_PLAN) {
      config.agent = { ...config.agent, plan: { ...(config.agent?.plan ?? {}), disable: true } }
    }
    files[key] = JSON.stringify(config)
  }

  // If no flashcode.json exists but agent toggles are set, create one
  if (!files["flashcode.json"] && !files["flashcode.jsonc"] && (OPENCODE_DISABLE_AGENT_BUILD || OPENCODE_DISABLE_AGENT_PLAN)) {
    const config: Record<string, unknown> = { agent: {} }
    if (OPENCODE_DISABLE_AGENT_BUILD) (config.agent as Record<string, unknown>).build = { disable: true }
    if (OPENCODE_DISABLE_AGENT_PLAN) (config.agent as Record<string, unknown>).plan = { disable: true }
    files["flashcode.json"] = JSON.stringify(config)
  }

  return `export default ${JSON.stringify(createEmbeddedConfigBundle(files))};`
}

const EMBEDDED_CONFIG_VIRTUAL_ID = "virtual:embedded-config"

export default defineConfig({
  main: {
    define: {
      "import.meta.env.ENABLE_LICENSE_CHECK": JSON.stringify(ENABLE_LICENSE_CHECK),
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          await copyServerAssets(OPENCODE_SERVER_DIST, "./out/main/chunks")
        },
      },
      {
        name: "ni-cic-code:embedded-config",
        enforce: "pre",
        resolveId(id) {
          if (id === EMBEDDED_CONFIG_VIRTUAL_ID) return `\0${EMBEDDED_CONFIG_VIRTUAL_ID}`
        },
        async load(id) {
          if (id === `\0${EMBEDDED_CONFIG_VIRTUAL_ID}`) return buildEmbeddedConfig()
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    define: {
      "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
      },
    },
  },
})
