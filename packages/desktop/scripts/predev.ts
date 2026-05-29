import { $ } from "bun"
import { existsSync, copyFileSync, unlinkSync } from "node:fs"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

// Copy LLM .env file into resources/ if LLM_ENV_FILE is specified
const llmEnvFile = process.env.LLM_ENV_FILE
const llmEnvDest = "resources/llm.env"
if (llmEnvFile) {
  if (!existsSync(llmEnvFile)) {
    console.error(`LLM_ENV_FILE not found: ${llmEnvFile}`)
    process.exit(1)
  }
  copyFileSync(llmEnvFile, llmEnvDest)
  console.log(`Bundled LLM config: ${llmEnvFile} → ${llmEnvDest}`)
} else if (existsSync(llmEnvDest)) {
  unlinkSync(llmEnvDest)
}

await $`cd ../opencode && bun script/build-node.ts`
