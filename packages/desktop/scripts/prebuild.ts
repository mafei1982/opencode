#!/usr/bin/env bun
import { $ } from "bun"
import { existsSync, copyFileSync, unlinkSync } from "node:fs"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`

// Copy LLM env file into resources/ so the desktop app auto-starts with
// local LLM configuration. Prefer an explicit override, then local llm.env,
// then a local .env file.
const llmEnvFile = process.env.LLM_ENV_FILE || (existsSync("llm.env") ? "llm.env" : existsSync(".env") ? ".env" : "")
const llmEnvDest = "resources/llm.env"
if (llmEnvFile) {
  if (!existsSync(llmEnvFile)) {
    console.error(`LLM_ENV_FILE not found: ${llmEnvFile}`)
    process.exit(1)
  }
  copyFileSync(llmEnvFile, llmEnvDest)
  console.log(`Bundled LLM config: ${llmEnvFile} → ${llmEnvDest}`)
} else {
  // Clean up any leftover from previous builds
  if (existsSync(llmEnvDest)) unlinkSync(llmEnvDest)
}

await $`cd ../opencode && bun script/build-node.ts`
