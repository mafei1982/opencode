/**
 * GGUF model resolution: resolve a model specifier to a local GGUF file path.
 *
 * Accepted formats:
 * - Local path:  `./models/model.gguf` or `C:\models\model.gguf`
 * - HuggingFace: `owner/repo` — selects the first/smallest GGUF
 * - HuggingFace: `owner/repo:Q3_K_M` — selects the GGUF matching the
 *   quantization pattern (case-insensitive substring match)
 *
 * Model directory layout (LM Studio convention):
 *   <model_dir>/<publisher>/<repo_name>/<filename>.gguf
 */

import fs from "fs"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "gguf-resolver" })

function getDefaultModelDir(): string {
  return path.resolve(process.cwd(), "models")
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

/**
 * Resolve a model specifier to a local GGUF file path.
 *
 * Resolution order for HuggingFace specifiers:
 * 1. `LLM_MODEL_DIR` env override → look there first
 * 2. Implicit `models/` directory next to cwd
 * 3. Auto-download from HuggingFace (dev mode only)
 */
export async function resolveGgufPath(
  model: string,
  onProgress?: (progress: { totalSize: number; downloadedSize: number }) => void,
): Promise<string> {
  // 1. Direct local path
  if (fs.existsSync(model)) return path.resolve(model)

  // 2. Looks like a local path that doesn't exist
  if (model.endsWith(".gguf")) throw new Error(`GGUF file not found: ${model}`)

  // 3. HuggingFace specifier: owner/repo or owner/repo:quant
  let quantFilter = ""
  let specifier = model
  if (specifier.includes(":")) {
    const idx = specifier.lastIndexOf(":")
    quantFilter = specifier.slice(idx + 1)
    specifier = specifier.slice(0, idx)
  }

  const parts = specifier.split("/")
  if (parts.length !== 2) throw new Error(`Invalid model specifier: ${model}. Expected format: owner/repo[:quant]`)
  const [owner, repo] = parts

  const modelDir = process.env.LLM_MODEL_DIR || getDefaultModelDir()

  // Try local resolution first
  const localPath = findInModelDir(modelDir, owner, repo, quantFilter)
  if (localPath) {
    log.info("resolved model from local directory", { path: localPath })
    return localPath
  }

  // Auto-download from HuggingFace using node-llama-cpp's built-in downloader
  log.info("model not found locally, downloading from HuggingFace", { model, modelDir })

  const { createModelDownloader } = await import("node-llama-cpp")
  const destDir = path.join(modelDir, owner, repo)
  fs.mkdirSync(destDir, { recursive: true })

  const tag = quantFilter || "Q4_K_M"
  // Use direct file path format (hf:user/model/file.gguf) to avoid manifest resolution issues
  const ggufFileName = await resolveHfGgufFileName(owner, repo, tag)
  const downloader = await createModelDownloader({
    modelUri: `hf:${owner}/${repo}/${ggufFileName}`,
    dirPath: destDir,
    onProgress: onProgress
      ? (p: { totalSize: number; downloadedSize: number }) => onProgress(p)
      : undefined,
  })

  log.info("downloading model", { uri: `hf:${owner}/${repo}/${ggufFileName}`, dest: destDir })
  const downloadedPath = await downloader.download()
  log.info("model downloaded", { path: downloadedPath })
  return downloadedPath
}

/**
 * Resolve the GGUF filename from a HuggingFace repo by querying the API
 * for siblings (files) and matching by quantization substring.
 */
async function resolveHfGgufFileName(owner: string, repo: string, quant: string): Promise<string> {
  const url = `https://huggingface.co/api/models/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HuggingFace API error: ${response.status} for ${owner}/${repo}`)

  const data = (await response.json()) as { siblings?: Array<{ rfilename: string }> }
  const ggufFiles = (data.siblings ?? [])
    .map((s) => s.rfilename)
    .filter((f) => f.endsWith(".gguf"))

  if (ggufFiles.length === 0) throw new Error(`No GGUF files found in ${owner}/${repo}`)

  const lower = quant.toLowerCase()
  const match = ggufFiles.find((f) => f.toLowerCase().includes(lower))
  if (match) return match

  throw new Error(`No GGUF file matching quantization "${quant}" in ${owner}/${repo}. Available: ${ggufFiles.join(", ")}`)
}
