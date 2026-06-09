/**
 * Local LLM provider factory for node-llama-cpp.
 *
 * Creates a BundledSDK-compatible provider that runs llama.cpp
 * in-process with no HTTP calls.
 *
 * Configuration via environment variables:
 *   LLM_PROVIDER=local
 *   LLM_MODEL_PATH=unsloth/Qwen3.5-35B-A3B-GGUF:Q3_K_M
 *   LLM_N_CTX=32768
 *   LLM_N_GPU_LAYERS=-1
 *   LLM_DISABLE_THINKING=false
 *   LLM_INFERENCE_TIMEOUT=120
 *   LLM_INFERENCE_RETRIES=3
 *   LLM_TEMPERATURE, LLM_TOP_P, LLM_TOP_K, LLM_MIN_P
 */

import type { LanguageModelV3 } from "@ai-sdk/provider"
import * as Log from "@opencode-ai/core/util/log"
import { resolveGgufPath } from "./gguf-resolver"
import { LocalLanguageModel } from "./local-language-model"
import { createLocalRuntimeClient } from "./local-runtime"

const log = Log.create({ service: "local-provider" })

let singletonInstance: LocalProviderSDK | undefined
let singletonLoadPromise: Promise<LocalProviderSDK> | undefined

export interface LocalProviderOptions {
  modelPath?: string
  nCtx?: number
  nGpuLayers?: number
  batchSize?: number
  threads?: number
  maxThreads?: number
  sequences?: number
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
  inferenceTimeout?: number
  inferenceRetries?: number
}

interface LocalProviderSDK {
  languageModel(modelId: string): LanguageModelV3
}

/**
 * Load the local model eagerly. Call this at startup to pre-warm
 * the model so the first request doesn't wait for loading.
 *
 * Returns the provider SDK instance.
 */
export async function loadLocalModel(
  options?: LocalProviderOptions,
  onProgress?: (progress: { totalSize: number; downloadedSize: number }) => void,
): Promise<LocalProviderSDK> {
  if (singletonInstance) return singletonInstance
  if (singletonLoadPromise) return singletonLoadPromise

  singletonLoadPromise = (async () => {
    const modelPath = options?.modelPath ?? process.env.LLM_MODEL_PATH ?? "unsloth/Qwen3.5-35B-A3B-GGUF:Q3_K_M"
    const nCtx = options?.nCtx ?? parseInt(process.env.LLM_N_CTX ?? "262144", 10)
    const nGpuLayers = options?.nGpuLayers ?? parseInt(process.env.LLM_N_GPU_LAYERS ?? "-1", 10)
    const batchSize = options?.batchSize ?? (process.env.LLM_BATCH_SIZE ? parseInt(process.env.LLM_BATCH_SIZE, 10) : undefined)
    const threads = options?.threads ?? (process.env.LLM_THREADS ? parseInt(process.env.LLM_THREADS, 10) : undefined)
    const maxThreads = options?.maxThreads ?? (process.env.LLM_MAX_THREADS ? parseInt(process.env.LLM_MAX_THREADS, 10) : undefined)
    const sequences = options?.sequences ??
      (process.env.LLM_SEQUENCES
        ? parseInt(process.env.LLM_SEQUENCES, 10)
        : process.env.LLM_MAX_CONCURRENCY
          ? parseInt(process.env.LLM_MAX_CONCURRENCY, 10)
          : undefined)
    const cacheTypeK = options?.cacheTypeK ?? process.env.LLM_CACHE_TYPE_K ?? undefined
    const cacheTypeV = options?.cacheTypeV ?? process.env.LLM_CACHE_TYPE_V ?? undefined
    const flashAttention = options?.flashAttention ?? (process.env.LLM_FLASH_ATTENTION ?? "true").toLowerCase() === "true"
    const useMmap = options?.useMmap ?? (process.env.LLM_USE_MMAP ? process.env.LLM_USE_MMAP.toLowerCase() === "true" : undefined)
    const useMlock = options?.useMlock ?? (process.env.LLM_USE_MLOCK ? process.env.LLM_USE_MLOCK.toLowerCase() === "true" : undefined)
    const disableThinking =
      options?.disableThinking ?? (process.env.LLM_DISABLE_THINKING ?? "").toLowerCase() === "true"
    const inferenceTimeout = options?.inferenceTimeout ?? parseInt(process.env.LLM_INFERENCE_TIMEOUT ?? "120", 10)
    const inferenceRetries = options?.inferenceRetries ?? parseInt(process.env.LLM_INFERENCE_RETRIES ?? "3", 10)

    // IMPORTANT: node-llama-cpp defaults temperature to 0 (greedy decoding) when
    // left undefined. Greedy decoding on reasoning models (Qwen-style) causes
    // repetition loops and never-ending <think> segments. Apply the recommended
    // thinking-model sampling defaults so the model converges. Still overridable
    // via env (LLM_TEMPERATURE / LLM_TOP_P / LLM_TOP_K / LLM_MIN_P).
    const samplingParams = {
      temperature: options?.temperature ?? (process.env.LLM_TEMPERATURE ? parseFloat(process.env.LLM_TEMPERATURE) : 0.6),
      topP: options?.topP ?? (process.env.LLM_TOP_P ? parseFloat(process.env.LLM_TOP_P) : 0.95),
      topK: options?.topK ?? (process.env.LLM_TOP_K ? parseInt(process.env.LLM_TOP_K, 10) : 20),
      minP: options?.minP ?? (process.env.LLM_MIN_P ? parseFloat(process.env.LLM_MIN_P) : 0),
      repeatPenalty: options?.repeatPenalty ??
        (process.env.LLM_REPEAT_PENALTY ? parseFloat(process.env.LLM_REPEAT_PENALTY) : undefined),
    }

    log.info("resolved sampling params", samplingParams)

    log.info("resolving model path", { modelPath })
    const ggufPath = await resolveGgufPath(modelPath, onProgress)

    log.info("loading local model", {
      ggufPath,
      nCtx,
      nGpuLayers,
      batchSize,
      threads,
      maxThreads,
      sequences,
      cacheTypeK,
      cacheTypeV,
      flashAttention,
      useMmap,
      useMlock,
    })
    const runtime = createLocalRuntimeClient()
    await runtime.init({
      ggufPath,
      nCtx,
      nGpuLayers,
      batchSize,
      threads,
      maxThreads,
      sequences,
      cacheTypeK,
      cacheTypeV,
      flashAttention,
      useMmap,
      useMlock,
      samplingParams,
      inferenceTimeout,
      inferenceRetries,
    })
    log.info("local runtime worker initialized successfully")

    const lm = new LocalLanguageModel("default", {
      runtime,
      disableThinking,
      samplingParams,
      inferenceTimeout,
      inferenceRetries,
    })

    singletonInstance = {
      languageModel(_modelId: string): LanguageModelV3 {
        // Single model instance — modelId is ignored since only one model is loaded
        return lm
      },
    }

    return singletonInstance
  })().catch((error) => {
    singletonLoadPromise = undefined
    throw error
  })

  return singletonLoadPromise
}

/**
 * Create a local provider SDK.
 *
 * Registered as a bundled provider factory in provider.ts.
 * The factory pattern matches the signature `(opts: any) => BundledSDK`.
 *
 * The actual model loading happens lazily on first `languageModel()` call
 * unless `loadLocalModel()` has been called beforehand (eager loading).
 */
export function createLocal(options?: LocalProviderOptions): LocalProviderSDK {
  if (singletonInstance) return singletonInstance

  // Return a lazy SDK that loads on first use if not eagerly loaded
  let loadPromise: Promise<LocalProviderSDK> | undefined

  return {
    languageModel(modelId: string): LanguageModelV3 {
      if (singletonInstance) return singletonInstance.languageModel(modelId)

      // Create a lazy wrapper that triggers load on first inference
      const lazyModel: LanguageModelV3 = {
        specificationVersion: "v3",
        modelId: modelId || "default",
        provider: "local",
        get supportedUrls() {
          return {}
        },
        async doGenerate(callOptions) {
          if (!loadPromise) loadPromise = loadLocalModel(options)
          const sdk = await loadPromise
          return sdk.languageModel(modelId).doGenerate(callOptions)
        },
        async doStream(callOptions) {
          if (!loadPromise) loadPromise = loadLocalModel(options)
          const sdk = await loadPromise
          return sdk.languageModel(modelId).doStream(callOptions)
        },
      }

      return lazyModel
    },
  }
}

/**
 * Check if the local provider is configured via environment.
 */
export function isLocalProviderEnabled(): boolean {
  return (process.env.LLM_PROVIDER ?? "").toLowerCase() === "local"
}

export function resetLocalProviderForTests() {
  singletonInstance = undefined
  singletonLoadPromise = undefined
}
