#!/usr/bin/env bun
import { $ } from "bun"
import { copyFileSync, existsSync, unlinkSync } from "node:fs"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
const addLlamaCppServer = ["1", "true", "yes", "on"].includes(
  (process.env.add_llama_cpp_server ?? process.env.ADD_LLAMA_CPP_SERVER ?? "").trim().toLowerCase(),
)
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`
console.log(
  addLlamaCppServer
    ? "Bundling llama.cpp server into desktop resources."
    : "Skipping bundled llama.cpp server; local_tcp will download it on first run when needed.",
)

const llmEnvFile = process.env.LLM_ENV_FILE || (existsSync("llm.env") ? "llm.env" : existsSync(".env") ? ".env" : "")
const llmEnvDest = "resources/llm.env"
if (llmEnvFile) {
  if (!existsSync(llmEnvFile)) throw new Error(`LLM_ENV_FILE not found: ${llmEnvFile}`)
  copyFileSync(llmEnvFile, llmEnvDest)
  console.log(`Bundled LLM config: ${llmEnvFile} → ${llmEnvDest}`)
} else if (existsSync(llmEnvDest)) {
  unlinkSync(llmEnvDest)
}

await $`cd ../opencode && bun script/build-node.ts`
