#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import path from "path"
import { fileURLToPath } from "url"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

const bundledLlamaServerSource = path.resolve(dir, "../../vendor/llama-cpp-server")
const bundledLlamaServerTarget = path.join(dir, "dist", "node", "llama-cpp-server")
const truthy = new Set(["1", "true", "yes", "on"])
const addLlamaCppServer = truthy.has(
  (process.env.add_llama_cpp_server ?? process.env.ADD_LLAMA_CPP_SERVER ?? "").trim().toLowerCase(),
)

await rm(bundledLlamaServerTarget, { recursive: true, force: true })

if (addLlamaCppServer) {
  const { installLlamaCppServer } = await import("../src/provider/sdk/local-tcp/llama-cpp-server")
  let lastLlamaDownloadProgress = -10
  const binary = await installLlamaCppServer(bundledLlamaServerTarget, {
    arch: "x64",
    platform: "win32",
    downloadProgress: (progress) => {
      if (progress.totalSize > 0 && (progress.percent >= lastLlamaDownloadProgress + 10 || progress.percent === 100)) {
        lastLlamaDownloadProgress = progress.percent
        console.log(`Downloading llama.cpp server: ${progress.percent}%`)
      }
    },
  })
  console.log(`Bundled llama.cpp server: ${binary} -> ${bundledLlamaServerTarget}`)
} else if (existsSync(bundledLlamaServerSource)) {
  console.log("Skipped llama.cpp server bundling. Set add_llama_cpp_server=true to include it in dist/node.")
}

console.log("Build complete")
