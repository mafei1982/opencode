import { existsSync, readFileSync } from "fs"
import path from "path"

export function loadEnvFiles(cwd = process.cwd()) {
  const candidates = [
    process.env.OPENCODE_ENV_FILE,
    process.env.LLM_ENV_FILE,
    path.join(cwd, ".env"),
    path.join(cwd, "llm.env"),
  ].filter((item, index, list): item is string => Boolean(item) && list.indexOf(item) === index)

  const loaded: string[] = []

  for (const rawPath of candidates) {
    const envPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath)
    if (!existsSync(envPath)) continue

    const content = readFileSync(envPath, "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue

      const eqIdx = trimmed.indexOf("=")
      if (eqIdx === -1) continue

      const key = trimmed.slice(0, eqIdx).trim()
      let value = trimmed.slice(eqIdx + 1).trim()
      if (!key || process.env[key] !== undefined) continue

      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }

      process.env[key] = value
    }

    loaded.push(envPath)
  }

  return loaded
}