import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { existsSync } from "node:fs"
import { cp, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Archive } from "@/util/archive"
import metadata from "../../../../../../vendor/llama-cpp-server.json"

const downloadPromises = new Map<string, Promise<string>>()
const truthy = new Set(["1", "true", "yes", "on"])
const falsy = new Set(["0", "false", "no", "off"])

export type LlamaCppServerDownloadProgress = {
  downloadedSize: number
  percent: number
  totalSize: number
}

export type EnsureLlamaCppServerOptions = {
  arch?: string
  downloadProgress?: (progress: LlamaCppServerDownloadProgress) => void
  platform?: NodeJS.Platform
  serverPath?: string
  targetDir?: string
}

export function readBuildBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (truthy.has(normalized)) return true
  if (falsy.has(normalized)) return false
  return fallback
}

export function isAddLlamaCppServerEnabled(env: NodeJS.ProcessEnv = process.env) {
  return readBuildBoolean(env.add_llama_cpp_server ?? env.ADD_LLAMA_CPP_SERVER, false)
}

function parseString(value: string | undefined) {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function findRepoRoot(start: string): string | undefined {
  let current = start
  while (true) {
    if (existsSync(path.join(current, "vendor")) && existsSync(path.join(current, "packages"))) return current
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function findPackageRoot(start: string): string | undefined {
  let current = start
  while (true) {
    if (existsSync(path.join(current, "package.json"))) return current
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function isSupportedPlatform(platform: string, arch: string) {
  return platform === "win32" && arch === "x64"
}

function cacheDir() {
  return path.join(Global.Path.bin, "llama-cpp-server", metadata.version, metadata.platform)
}

function executablePath(dir: string) {
  return path.join(dir, metadata.executable)
}

export function getLlamaCppServerCandidates(options: Pick<EnsureLlamaCppServerOptions, "arch" | "platform" | "targetDir"> = {}) {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const dirname = path.dirname(fileURLToPath(import.meta.url))
  const packageRoot = findPackageRoot(dirname)
  const repoRoot = findRepoRoot(dirname)
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch

  return [
    resourcesPath ? executablePath(path.join(resourcesPath, "llama-cpp-server")) : undefined,
    packageRoot ? executablePath(path.join(packageRoot, "dist", "node", "llama-cpp-server")) : undefined,
    repoRoot ? executablePath(path.join(repoRoot, "vendor", "llama-cpp-server")) : undefined,
    isSupportedPlatform(platform, arch) ? executablePath(options.targetDir ?? cacheDir()) : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate))
}

async function findExecutable(dir: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true })
  const executable = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === metadata.executable)
  if (executable) return path.join(dir, executable.name)

  for (const entry of entries.filter((entry) => entry.isDirectory())) {
    const nested = await findExecutable(path.join(dir, entry.name))
    if (nested) return nested
  }
}

function emitDownloadProgress(
  progress: EnsureLlamaCppServerOptions["downloadProgress"],
  downloadedSize: number,
  totalSize: number,
) {
  if (!progress) return
  try {
    progress({
      downloadedSize,
      percent: totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0,
      totalSize,
    })
  } catch {}
}

async function downloadArchive(target: string, progress: EnsureLlamaCppServerOptions["downloadProgress"]) {
  const response = await fetch(metadata.archiveUrl)
  if (!response.ok) {
    throw new Error(`Failed to download llama.cpp server from ${metadata.archiveUrl}: ${response.status} ${response.statusText}`)
  }

  const totalSize = Number(response.headers.get("content-length") ?? "0") || 0
  const file = await open(target, "w")
  try {
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      await file.write(bytes)
      emitDownloadProgress(progress, bytes.byteLength, bytes.byteLength)
      return
    }

    let downloadedSize = 0
    const reader = response.body.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      downloadedSize += chunk.value.byteLength
      await file.write(chunk.value)
      emitDownloadProgress(progress, downloadedSize, totalSize)
    }
  } finally {
    await file.close()
  }
}

async function replaceDir(source: string, target: string) {
  await rm(target, { recursive: true, force: true })
  try {
    await rename(source, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
    await cp(source, target, { recursive: true })
    await rm(source, { recursive: true, force: true })
  }
}

async function copyServerDir(sourceBinary: string, targetDir: string) {
  await rm(targetDir, { recursive: true, force: true })
  await cp(path.dirname(sourceBinary), targetDir, { recursive: true })
  const targetBinary = executablePath(targetDir)
  if (!existsSync(targetBinary)) throw new Error(`Copied llama.cpp server is missing ${targetBinary}`)
  return targetBinary
}

async function downloadAndInstall(targetDir: string, progress: EnsureLlamaCppServerOptions["downloadProgress"]) {
  const targetBinary = executablePath(targetDir)
  if (existsSync(targetBinary)) return targetBinary

  return Flock.withLock(`llama-cpp-server:${metadata.version}:${metadata.platform}:${targetDir}`, async () => {
    if (existsSync(targetBinary)) return targetBinary

    const parent = path.dirname(targetDir)
    const suffix = `${process.pid}-${Date.now()}`
    const archivePath = path.join(parent, `${path.basename(targetDir)}-${suffix}.zip`)
    const extractDir = path.join(parent, `${path.basename(targetDir)}-${suffix}`)

    await mkdir(parent, { recursive: true })
    await rm(extractDir, { recursive: true, force: true })

    try {
      await downloadArchive(archivePath, progress)
      await Archive.extractZip(archivePath, extractDir)
      const extractedBinary = await findExecutable(extractDir)
      if (!extractedBinary) throw new Error(`Downloaded llama.cpp server archive did not contain ${metadata.executable}`)

      await replaceDir(path.dirname(extractedBinary), targetDir)
      if (!existsSync(targetBinary)) throw new Error(`Installed llama.cpp server is missing ${targetBinary}`)
      return targetBinary
    } finally {
      await rm(archivePath, { force: true }).catch(() => {})
      await rm(extractDir, { recursive: true, force: true }).catch(() => {})
    }
  })
}

export async function ensureLlamaCppServer(options: EnsureLlamaCppServerOptions = {}) {
  const explicit = parseString(options.serverPath ?? process.env.LLM_TCP_SERVER_PATH)
  if (explicit) {
    if (existsSync(explicit)) return explicit
    throw new Error(`Configured llama-server.exe was not found: ${explicit}. Check LLM_TCP_SERVER_PATH.`)
  }

  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const candidates = getLlamaCppServerCandidates(options)
  const match = candidates.find((candidate) => existsSync(candidate))
  if (match) return match

  if (!isSupportedPlatform(platform, arch)) {
    throw new Error(
      `Unable to find llama-server.exe for local_tcp. Automatic download currently supports Windows x64 only. Looked in: ${candidates.join(", ")}. Set LLM_TCP_SERVER_PATH to override.`,
    )
  }

  const targetDir = options.targetDir ?? cacheDir()
  const targetBinary = executablePath(targetDir)
  if (existsSync(targetBinary)) return targetBinary

  const key = path.resolve(targetDir)
  const existing = downloadPromises.get(key)
  if (existing) return existing

  const promise = downloadAndInstall(targetDir, options.downloadProgress).finally(() => {
    downloadPromises.delete(key)
  })
  downloadPromises.set(key, promise)
  return promise
}

export async function installLlamaCppServer(targetDir: string, options: Omit<EnsureLlamaCppServerOptions, "targetDir"> = {}) {
  const targetBinary = executablePath(targetDir)
  if (existsSync(targetBinary)) return targetBinary

  const explicit = parseString(options.serverPath ?? process.env.LLM_TCP_SERVER_PATH)
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`Configured llama-server.exe was not found: ${explicit}. Check LLM_TCP_SERVER_PATH.`)
    return copyServerDir(explicit, targetDir)
  }

  const match = getLlamaCppServerCandidates(options).find((candidate) => existsSync(candidate))
  if (match) return copyServerDir(match, targetDir)

  return copyServerDir(await ensureLlamaCppServer(options), targetDir)
}
