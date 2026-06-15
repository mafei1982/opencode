import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { FetchFunction } from "@ai-sdk/provider-utils"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { createWriteStream, existsSync } from "node:fs"
import { appendFile, mkdir, truncate } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import * as Process from "@/util/process"
import { resolveLocalGgufPath } from "../local/gguf-resolver"

const log = Log.create({ service: "local-tcp-provider" })

const DEFAULT_MODEL_PATH = "unsloth/Qwen3.5-35B-A3B-GGUF:Q3_K_M"
const DEFAULT_MODEL_ALIAS = "default"
const DEFAULT_STARTUP_TIMEOUT = 15 * 60 * 1000

let singletonServer: LocalTcpServer | undefined
let singletonLoadPromise: Promise<LocalTcpServer> | undefined
let hooksInstalled = false

type GpuLayers = number | "all" | "auto"
type SplitMode = "none" | "layer" | "row" | "tensor"

export interface LocalTcpProviderOptions {
  modelPath?: string
  nCtx?: number
  nGpuLayers?: number
  nGpuLayersDraft?: GpuLayers
  splitMode?: SplitMode
  batchSize?: number
  threads?: number
  maxThreads?: number
  sequences?: number
  kvUnified?: boolean
  cacheRam?: number
  ctxCheckpoints?: number
  checkpointMinStep?: number
  specType?: string
  specDraftNMax?: number
  specDraftNMin?: number
  specDraftPMin?: number
  specDraftTypeK?: string
  specDraftTypeV?: string
  cacheTypeK?: string
  cacheTypeV?: string
  flashAttention?: boolean
  useMmap?: boolean
  useMlock?: boolean
  disableThinking?: boolean
  temperature?: number
  topP?: number
  topK?: number
  minP?: number
  repeatPenalty?: number
  repeatLastN?: number
  inferenceTimeout?: number
  serverPath?: string
  startupTimeout?: number
}

type LocalTcpServer = {
  apiKey: string
  baseURL: string
  logPath: string
  modelPath: string
  port: number
  process: Process.Child
}

function parseIntEnv(value: string | undefined) {
  return value ? parseInt(value, 10) : undefined
}

function parseFloatEnv(value: string | undefined) {
  return value ? parseFloat(value) : undefined
}

function parseBooleanEnv(value: string | undefined) {
  return value ? value.toLowerCase() === "true" : undefined
}

function parseStringEnv(value: string | undefined) {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function parseGpuLayersEnv(value: string | undefined): GpuLayers | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return
  if (normalized === "all" || normalized === "auto") return normalized

  const parsed = parseInt(normalized, 10)
  if (!Number.isNaN(parsed)) return parsed
}

function parseSplitMode(value: string | undefined): SplitMode | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "none" || normalized === "layer" || normalized === "row" || normalized === "tensor") {
    return normalized
  }
}

function quoteCommandArg(value: string) {
  if (value.length === 0) return '""'
  if (!/[\s"]/g.test(value)) return value
  return `"${value.replaceAll('"', '\\"')}"`
}

function formatCommandForLog(args: string[]) {
  return args.map(quoteCommandArg).join(" ")
}

function redactCommandArgs(args: string[]) {
  return args.map((value, index) => (index > 0 && args[index - 1] === "--api-key" ? "<redacted>" : value))
}

function resolveOptions(options?: LocalTcpProviderOptions): Required<Pick<LocalTcpProviderOptions, "modelPath" | "disableThinking" | "startupTimeout">> & LocalTcpProviderOptions {
  return {
    modelPath: options?.modelPath ?? process.env.LLM_MODEL_PATH ?? DEFAULT_MODEL_PATH,
    nCtx: options?.nCtx ?? parseIntEnv(process.env.LLM_N_CTX),
    nGpuLayers: options?.nGpuLayers ?? parseIntEnv(process.env.LLM_N_GPU_LAYERS),
    nGpuLayersDraft: options?.nGpuLayersDraft ?? parseGpuLayersEnv(process.env.LLM_N_GPU_LAYERS_DRAFT),
    splitMode: options?.splitMode ?? parseSplitMode(process.env.LLM_SPLIT_MODE),
    batchSize: options?.batchSize ?? parseIntEnv(process.env.LLM_BATCH_SIZE),
    threads: options?.threads ?? parseIntEnv(process.env.LLM_THREADS),
    maxThreads: options?.maxThreads ?? parseIntEnv(process.env.LLM_MAX_THREADS),
    sequences:
      options?.sequences ??
      parseIntEnv(process.env.LLM_PARALLEL_N) ??
      parseIntEnv(process.env.LLM_SEQUENCES) ??
      parseIntEnv(process.env.LLM_MAX_CONCURRENCY),
    kvUnified: options?.kvUnified ?? parseBooleanEnv(process.env.LLM_KV_UNIFIED),
    cacheRam: options?.cacheRam ?? parseIntEnv(process.env.LLM_CACHE_RAM),
    ctxCheckpoints: options?.ctxCheckpoints ?? parseIntEnv(process.env.LLM_CTX_CHECKPOINTS),
    checkpointMinStep: options?.checkpointMinStep ?? parseIntEnv(process.env.LLM_CHECKPOINT_MIN_STEP),
    specType: options?.specType ?? parseStringEnv(process.env.LLM_SPEC_TYPE),
    specDraftNMax: options?.specDraftNMax ?? parseIntEnv(process.env.LLM_SPEC_DRAFT_N_MAX),
    specDraftNMin: options?.specDraftNMin ?? parseIntEnv(process.env.LLM_SPEC_DRAFT_N_MIN),
    specDraftPMin: options?.specDraftPMin ?? parseFloatEnv(process.env.LLM_SPEC_DRAFT_P_MIN),
    specDraftTypeK: options?.specDraftTypeK ?? parseStringEnv(process.env.LLM_SPEC_DRAFT_TYPE_K),
    specDraftTypeV: options?.specDraftTypeV ?? parseStringEnv(process.env.LLM_SPEC_DRAFT_TYPE_V),
    cacheTypeK: options?.cacheTypeK ?? process.env.LLM_CACHE_TYPE_K,
    cacheTypeV: options?.cacheTypeV ?? process.env.LLM_CACHE_TYPE_V,
    flashAttention: options?.flashAttention ?? parseBooleanEnv(process.env.LLM_FLASH_ATTENTION),
    useMmap: options?.useMmap ?? parseBooleanEnv(process.env.LLM_USE_MMAP),
    useMlock: options?.useMlock ?? parseBooleanEnv(process.env.LLM_USE_MLOCK),
    disableThinking: options?.disableThinking ?? (process.env.LLM_DISABLE_THINKING ?? "").toLowerCase() === "true",
    temperature: options?.temperature ?? (parseFloatEnv(process.env.LLM_TEMPERATURE) ?? 0.6),
    topP: options?.topP ?? (parseFloatEnv(process.env.LLM_TOP_P) ?? 0.95),
    topK: options?.topK ?? (parseIntEnv(process.env.LLM_TOP_K) ?? 20),
    minP: options?.minP ?? (parseFloatEnv(process.env.LLM_MIN_P) ?? 0),
    repeatPenalty: options?.repeatPenalty ?? parseFloatEnv(process.env.LLM_REPEAT_PENALTY),
    repeatLastN: options?.repeatLastN ?? parseIntEnv(process.env.LLM_REPEAT_LAST_N),
    inferenceTimeout: options?.inferenceTimeout ?? parseIntEnv(process.env.LLM_INFERENCE_TIMEOUT),
    serverPath: options?.serverPath ?? process.env.LLM_TCP_SERVER_PATH,
    startupTimeout: options?.startupTimeout ?? parseIntEnv(process.env.LLM_SERVER_START_TIMEOUT) ?? DEFAULT_STARTUP_TIMEOUT,
  }
}

function isHuggingFaceSpec(modelPath: string) {
  return /^[^/\\]+\/[^/:\\]+(?::.+)?$/.test(modelPath)
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

function resolveServerBinary(options: LocalTcpProviderOptions) {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const dirname = path.dirname(fileURLToPath(import.meta.url))
  const packageRoot = findPackageRoot(dirname)
  const repoRoot = findRepoRoot(dirname)
  const candidates = [
    options.serverPath,
    process.env.LLM_TCP_SERVER_PATH,
    resourcesPath ? path.join(resourcesPath, "llama-cpp-server", "llama-server.exe") : undefined,
    packageRoot ? path.join(packageRoot, "dist", "node", "llama-cpp-server", "llama-server.exe") : undefined,
    repoRoot ? path.join(repoRoot, "vendor", "llama-cpp-server", "llama-server.exe") : undefined,
  ].filter((value): value is string => Boolean(value))

  const match = candidates.find((candidate) => existsSync(candidate))
  if (match) return match

  throw new Error(
    `Unable to find llama-server.exe. Looked in: ${candidates.join(", ")}. Set LLM_TCP_SERVER_PATH to override.`,
  )
}

function resolveModelArgs(modelPath: string) {
  const localPath = resolveLocalGgufPath(modelPath)
  if (localPath) return ["--model", localPath]

  if (path.isAbsolute(modelPath) || modelPath.toLowerCase().endsWith(".gguf")) {
    throw new Error(`GGUF file not found: ${modelPath}`)
  }

  if (isHuggingFaceSpec(modelPath)) {
    return ["--hf-repo", modelPath]
  }

  return ["--model", path.resolve(modelPath)]
}

function getLogPath() {
  const current = Log.file()
  if (current) {
    const ext = path.extname(current) || ".log"
    return path.join(path.dirname(current), `${path.basename(current, ext)}.llama-server${ext}`)
  }
  return path.join(Global.Path.log, "llama-server.log")
}

async function getFreePort() {
  const net = await import("node:net")
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to resolve a free port for llama-server")))
        return
      }
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}

async function fetchWithTimeout(url: string, init: RequestInit, timeout: number) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(new Error("Timed out waiting for llama-server")), timeout)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          const error = new Error(`local_tcp SSE read timed out after ${ms}ms`)
          ctl.abort(error)
          void reader.cancel(error)
          reject(error)
        }, ms)

        reader.read().then(
          (value) => {
            clearTimeout(id)
            resolve(value)
          },
          (error) => {
            clearTimeout(id)
            reject(error)
          },
        )
      })

      if (part.done) {
        ctrl.close()
        return
      }

      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

function createInferenceFetch(inferenceTimeout?: number): FetchFunction {
  const timeoutMs = typeof inferenceTimeout === "number" ? inferenceTimeout * 1000 : undefined
  const debugBodyPath = process.env.LLM_TCP_DEBUG_BODY

  return (async (input, init) => {
    const opts = init ?? {}

    if (debugBodyPath && typeof opts.body === "string") {
      const target = path.isAbsolute(debugBodyPath)
        ? debugBodyPath
        : path.join(Global.Path.data, "local-tcp", debugBodyPath)
      await mkdir(path.dirname(target), { recursive: true }).catch(() => {})
      await appendFile(
        target,
        `\n===== ${new Date().toISOString()} bytes=${Buffer.byteLength(opts.body)} =====\n${opts.body}\n`,
      ).catch((error) => log.error("failed to write debug body", { error: String(error) }))
    }

    const chunkAbortCtl = typeof timeoutMs === "number" && timeoutMs > 0 ? new AbortController() : undefined
    const signals: AbortSignal[] = []

    if (opts.signal) signals.push(opts.signal)
    if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
    if (typeof timeoutMs === "number" && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))

    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    const response = await fetch(input, {
      ...opts,
      signal,
      // @ts-ignore Bun adds its own request timeout unless disabled explicitly.
      timeout: false,
    })

    if (!chunkAbortCtl || typeof timeoutMs !== "number") return response
    return wrapSSE(response, timeoutMs, chunkAbortCtl)
  }) as FetchFunction
}

async function waitForServerReady(server: LocalTcpServer, timeout: number) {
  const started = Date.now()
  const headers = new Headers({ Authorization: `Bearer ${server.apiKey}` })

  while (Date.now() - started < timeout) {
    if (server.process.exitCode !== null || server.process.signalCode !== null) {
      throw new Error(`llama-server exited before becoming ready. See ${server.logPath}`)
    }

    try {
      const response = await fetchWithTimeout(`${server.baseURL}/models`, { headers }, 2_000)
      if (response.ok) return
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  throw new Error(`Timed out waiting for llama-server to become ready. See ${server.logPath}`)
}

function installProcessHooks() {
  if (hooksInstalled) return
  hooksInstalled = true

  const stop = () => {
    void stopLocalTcpServer()
  }

  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

export async function loadLocalTcpServer(options?: LocalTcpProviderOptions) {
  if (singletonServer) return singletonServer
  if (singletonLoadPromise) return singletonLoadPromise

  singletonLoadPromise = (async () => {
    const resolved = resolveOptions(options)
    const binary = resolveServerBinary(resolved)
    const port = await getFreePort()
    const apiKey = randomUUID()
    const logPath = getLogPath()
    const modelArgs = resolveModelArgs(resolved.modelPath)
    const args = [
      binary,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--alias",
      DEFAULT_MODEL_ALIAS,
      "--api-key",
      apiKey,
      ...modelArgs,
    ]

    if (resolved.nCtx !== undefined) args.push("--ctx-size", String(resolved.nCtx))
    if (resolved.nGpuLayers !== undefined) args.push("--gpu-layers", String(resolved.nGpuLayers))
    if (resolved.nGpuLayersDraft !== undefined) args.push("--n-gpu-layers-draft", String(resolved.nGpuLayersDraft))
    if (resolved.splitMode) args.push("--split-mode", resolved.splitMode)
    if (resolved.batchSize !== undefined) args.push("--batch-size", String(resolved.batchSize))
    if (resolved.threads ?? resolved.maxThreads) args.push("--threads", String(resolved.threads ?? resolved.maxThreads))
    if (resolved.sequences !== undefined) args.push("--parallel", String(resolved.sequences))
    if (resolved.kvUnified !== undefined) args.push(resolved.kvUnified ? "--kv-unified" : "--no-kv-unified")
    if (resolved.cacheRam !== undefined) args.push("--cache-ram", String(resolved.cacheRam))
    if (resolved.ctxCheckpoints !== undefined) args.push("--ctx-checkpoints", String(resolved.ctxCheckpoints))
    if (resolved.checkpointMinStep !== undefined) args.push("--checkpoint-min-step", String(resolved.checkpointMinStep))
    if (resolved.specType) args.push("--spec-type", resolved.specType)
    if (resolved.specDraftNMax !== undefined) args.push("--spec-draft-n-max", String(resolved.specDraftNMax))
    if (resolved.specDraftNMin !== undefined) args.push("--spec-draft-n-min", String(resolved.specDraftNMin))
    if (resolved.specDraftPMin !== undefined) args.push("--spec-draft-p-min", String(resolved.specDraftPMin))
    if (resolved.specDraftTypeK) args.push("--spec-draft-type-k", resolved.specDraftTypeK)
    if (resolved.specDraftTypeV) args.push("--spec-draft-type-v", resolved.specDraftTypeV)
    if (resolved.cacheTypeK) args.push("--cache-type-k", resolved.cacheTypeK)
    if (resolved.cacheTypeV) args.push("--cache-type-v", resolved.cacheTypeV)
    if (resolved.flashAttention !== undefined) args.push("--flash-attn", resolved.flashAttention ? "on" : "off")
    if (resolved.useMmap !== undefined) args.push(resolved.useMmap ? "--mmap" : "--no-mmap")
    if (resolved.useMlock) args.push("--mlock")
    if (resolved.disableThinking) args.push("--reasoning", "off")
    if (resolved.temperature !== undefined) args.push("--temp", String(resolved.temperature))
    if (resolved.topP !== undefined) args.push("--top-p", String(resolved.topP))
    if (resolved.topK !== undefined) args.push("--top-k", String(resolved.topK))
    if (resolved.minP !== undefined) args.push("--min-p", String(resolved.minP))
    if (resolved.repeatPenalty !== undefined) args.push("--repeat-penalty", String(resolved.repeatPenalty))
    if (resolved.repeatLastN !== undefined) args.push("--repeat-last-n", String(resolved.repeatLastN))

    await mkdir(path.dirname(logPath), { recursive: true })
    await truncate(logPath).catch(() => {})
    const redactedArgs = redactCommandArgs(args)
    await appendFile(
      logPath,
      [
        `[opencode] cwd: ${path.dirname(binary)}`,
        `[opencode] command: ${formatCommandForLog(redactedArgs)}`,
        ...(process.env.LLM_MODEL_DIR ? [`[opencode] env LLAMA_CACHE=${process.env.LLM_MODEL_DIR}`] : []),
        "",
      ].join("\n"),
    )
    const stream = createWriteStream(logPath, { flags: "a" })
    const child = Process.spawn(args, {
      cwd: path.dirname(binary),
      env: {
        LLAMA_CACHE: process.env.LLM_MODEL_DIR ?? undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    child.stdout?.pipe(stream, { end: false })
    child.stderr?.pipe(stream, { end: false })
    child.once("exit", () => {
      stream.end()
      if (singletonServer?.process.pid === child.pid) singletonServer = undefined
    })

    const server = {
      apiKey,
      baseURL: `http://127.0.0.1:${port}/v1`,
      logPath,
      modelPath: resolved.modelPath,
      port,
      process: child,
    } satisfies LocalTcpServer

    log.info("starting local tcp llama-server", {
      binary,
      command: formatCommandForLog(redactedArgs),
      cwd: path.dirname(binary),
      logPath,
      modelArgs,
      modelPath: resolved.modelPath,
      port,
    })

    await waitForServerReady(server, resolved.startupTimeout)
    installProcessHooks()
    singletonServer = server
    return server
  })().catch((error) => {
    singletonLoadPromise = undefined
    throw error
  })

  return singletonLoadPromise
}

export async function stopLocalTcpServer() {
  const server = singletonServer
  singletonServer = undefined
  singletonLoadPromise = undefined
  if (!server) return

  log.info("stopping local tcp llama-server", { pid: server.process.pid, port: server.port })
  await Process.stop(server.process)
}

async function resolveLanguageModel(modelId: string, options?: LocalTcpProviderOptions) {
  const resolved = resolveOptions(options)
  const server = await loadLocalTcpServer(resolved)
  return createOpenAICompatible({
    apiKey: server.apiKey,
    baseURL: server.baseURL,
    fetch: createInferenceFetch(resolved.inferenceTimeout),
    name: "local_tcp",
  }).languageModel(modelId || DEFAULT_MODEL_ALIAS)
}

export function createLocalTcp(options?: LocalTcpProviderOptions) {
  return {
    languageModel(modelId: string): LanguageModelV3 {
      const lazyModel: LanguageModelV3 = {
        specificationVersion: "v3",
        modelId: modelId || DEFAULT_MODEL_ALIAS,
        provider: "local_tcp",
        get supportedUrls() {
          return {}
        },
        async doGenerate(callOptions) {
          return (await resolveLanguageModel(modelId, options)).doGenerate(callOptions)
        },
        async doStream(callOptions) {
          return (await resolveLanguageModel(modelId, options)).doStream(callOptions)
        },
      }

      return lazyModel
    },
  }
}

export function isLocalTcpProviderEnabled() {
  return (process.env.LLM_PROVIDER ?? "").toLowerCase() === "local_tcp"
}