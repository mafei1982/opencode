#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

await import("./generate.ts")

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

const bundledLlamaServerSource = path.resolve(dir, "../../vendor/llama-cpp-server")
const bundledLlamaServerTarget = path.join(dir, "dist", "node", "llama-cpp-server")
const truthy = new Set(["1", "true", "yes", "on"])
const addLlamaCppServer = truthy.has((process.env.add_llama_cpp_server ?? process.env.ADD_LLAMA_CPP_SERVER ?? "").trim().toLowerCase())

await fs.promises.rm(bundledLlamaServerTarget, { recursive: true, force: true })

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
} else if (await fs.promises.stat(bundledLlamaServerSource).then(() => true).catch(() => false)) {
  console.log("Skipped llama.cpp server bundling. Set add_llama_cpp_server=true to include it in dist/node.")
}

console.log("Build complete")
