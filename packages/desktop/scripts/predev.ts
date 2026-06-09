import { $ } from "bun"
import { existsSync, copyFileSync, unlinkSync } from "node:fs"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

// Copy LLM env file into resources/ so dev mode can read either llm.env or .env.
const llmEnvFile = process.env.LLM_ENV_FILE || (existsSync("llm.env") ? "llm.env" : existsSync(".env") ? ".env" : "")
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
