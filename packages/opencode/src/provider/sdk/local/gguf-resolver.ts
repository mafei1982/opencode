/**
 * Resolve a model specifier to a local GGUF file path.
 *
 * Accepted formats:
 * - Local path:  `./models/model.gguf` or `C:\models\model.gguf`
 * - HuggingFace cache key: `owner/repo` or `owner/repo:Q3_K_M`
 *
 * Model directory layout (LM Studio convention):
 *   <model_dir>/<publisher>/<repo_name>/<filename>.gguf
 */

import fs from "fs"
import path from "path"

export function getDefaultModelDir(): string {
  return path.resolve("models")
}

function parseHfSpecifier(model: string) {
  let quantFilter = ""
  let specifier = model
  if (specifier.includes(":")) {
    const idx = specifier.lastIndexOf(":")
    quantFilter = specifier.slice(idx + 1)
    specifier = specifier.slice(0, idx)
  }

  const parts = specifier.split("/")
  if (parts.length !== 2) return

  return {
    owner: parts[0],
    quantFilter,
    repo: parts[1],
  }
}

function findInModelDir(modelDir: string, owner: string, repo: string, quantFilter: string): string | undefined {
  const repoDir = path.join(modelDir, owner, repo)
  if (!fs.existsSync(repoDir)) return undefined

  const candidates = fs
    .readdirSync(repoDir)
    .filter((f) => f.endsWith(".gguf"))
    .sort()

  if (candidates.length === 0) return undefined

  if (quantFilter) {
    const lower = quantFilter.toLowerCase()
    const match = candidates.find((f) => f.toLowerCase().includes(lower))
    return match ? path.join(repoDir, match) : undefined
  }

  return path.join(repoDir, candidates[0])
}

export function resolveLocalGgufPath(model: string): string | undefined {
  if (fs.existsSync(model)) return path.resolve(model)

  const parsed = parseHfSpecifier(model)
  if (!parsed) return undefined

  const modelDir = process.env.LLM_MODEL_DIR || getDefaultModelDir()
  const localPath = findInModelDir(modelDir, parsed.owner, parsed.repo, parsed.quantFilter)
  if (localPath) {
    console.info("[gguf-resolver] resolved model from local directory", { path: localPath })
    return localPath
  }

  return undefined
}
