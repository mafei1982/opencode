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

const log = Log.create({ service: "local-provider" })

let singletonInstance: LocalProviderSDK | undefined

export interface LocalProviderOptions {
  modelPath?: string
  nCtx?: number
  nGpuLayers?: number
  cacheTypeK?: string
  cacheTypeV?: string
  flashAttention?: boolean
  disableThinking?: boolean
  temperature?: number
  topP?: number
  topK?: number
  minP?: number
  inferenceTimeout?: number
  inferenceRetries?: number
}

interface LocalProviderSDK {
  languageModel(modelId: string): LanguageModelV3
}

async function createModelInstance(
  ggufPath: string,
  nCtx: number,
  nGpuLayers: number,
  cacheTypeK?: string,
  cacheTypeV?: string,
  flashAttention?: boolean,
) {
  const { getLlama, LlamaChatSession } = await import("node-llama-cpp")

  const llama = await getLlama("lastBuild")
  const model = await llama.loadModel({
    modelPath: ggufPath,
    gpuLayers: nGpuLayers === -1 ? "max" : nGpuLayers,
    defaultContextFlashAttention: flashAttention,
  })
  const contextOpts: Record<string, unknown> = {
    contextSize: nCtx,
    flashAttention,
  }
  if (cacheTypeK) contextOpts.typeK = cacheTypeK
  if (cacheTypeV) contextOpts.typeV = cacheTypeV
  const context = await model.createContext(contextOpts)
  log.info("context created", { contextSize: context.contextSize, flashAttention: context.flashAttention })
  const session = new LlamaChatSession({ contextSequence: context.getSequence() })

  return { model, context, session }
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

  const modelPath = options?.modelPath ?? process.env.LLM_MODEL_PATH ?? "unsloth/Qwen3.5-35B-A3B-GGUF:Q3_K_M"
  const nCtx = options?.nCtx ?? parseInt(process.env.LLM_N_CTX ?? "262144", 10)
  const nGpuLayers = options?.nGpuLayers ?? parseInt(process.env.LLM_N_GPU_LAYERS ?? "-1", 10)
  const cacheTypeK = options?.cacheTypeK ?? process.env.LLM_CACHE_TYPE_K ?? undefined
  const cacheTypeV = options?.cacheTypeV ?? process.env.LLM_CACHE_TYPE_V ?? undefined
  const flashAttention = options?.flashAttention ?? (process.env.LLM_FLASH_ATTENTION ?? "true").toLowerCase() === "true"
  const disableThinking =
    options?.disableThinking ?? (process.env.LLM_DISABLE_THINKING ?? "").toLowerCase() === "true"
  const inferenceTimeout = options?.inferenceTimeout ?? parseInt(process.env.LLM_INFERENCE_TIMEOUT ?? "120", 10)
  const inferenceRetries = options?.inferenceRetries ?? parseInt(process.env.LLM_INFERENCE_RETRIES ?? "3", 10)

  const samplingParams = {
    temperature: options?.temperature ?? (process.env.LLM_TEMPERATURE ? parseFloat(process.env.LLM_TEMPERATURE) : undefined),
    topP: options?.topP ?? (process.env.LLM_TOP_P ? parseFloat(process.env.LLM_TOP_P) : undefined),
    topK: options?.topK ?? (process.env.LLM_TOP_K ? parseInt(process.env.LLM_TOP_K, 10) : undefined),
    minP: options?.minP ?? (process.env.LLM_MIN_P ? parseFloat(process.env.LLM_MIN_P) : undefined),
  }

  log.info("resolving model path", { modelPath })
  const ggufPath = await resolveGgufPath(modelPath, onProgress)

  log.info("loading local model", { ggufPath, nCtx, nGpuLayers, cacheTypeK, cacheTypeV, flashAttention })
  const { model, context, session } = await createModelInstance(ggufPath, nCtx, nGpuLayers, cacheTypeK, cacheTypeV, flashAttention)
  log.info("local model loaded successfully")

  const modelFactory = async () => {
    log.info("re-creating model instance for recovery", { ggufPath, nCtx, nGpuLayers })
    return createModelInstance(ggufPath, nCtx, nGpuLayers, cacheTypeK, cacheTypeV, flashAttention)
  }

  const lm = new LocalLanguageModel("default", {
    model,
    context,
    session,
    nCtx,
    disableThinking,
    samplingParams,
    inferenceTimeout,
    inferenceRetries,
    modelFactory,
  })

  singletonInstance = {
    languageModel(_modelId: string): LanguageModelV3 {
      // Single model instance — modelId is ignored since only one model is loaded
      return lm
    },
  }

  return singletonInstance
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
        supportsStructuredOutputs: false,
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
