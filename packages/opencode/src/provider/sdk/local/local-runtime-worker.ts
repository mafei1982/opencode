import { parentPort } from "node:worker_threads"
import * as Log from "@opencode-ai/core/util/log"
import type {
  LastBuildOptions,
  LlamaChat,
  LlamaChatResponseChunk,
  LlamaContext,
  LlamaContextOptions,
  LlamaModel,
  LlamaModelOptions,
} from "node-llama-cpp"
import type {
  LocalRuntimeGenerateInput,
  LocalRuntimeInitInput,
  LocalRuntimeResponsePart,
  LocalRuntimeResult,
  LocalRuntimeStreamEvent,
  LocalRuntimeWorkerRequest,
  LocalRuntimeWorkerResponse,
} from "./local-runtime-protocol"

const log = Log.create({ service: "local-runtime-worker" })

if (!parentPort) throw new Error("Local runtime worker requires a parent port")
const workerPort = parentPort

type RuntimeState = {
  init: LocalRuntimeInitInput | undefined
  model: LlamaModel | undefined
  context: LlamaContext | undefined
  chat: LlamaChat | undefined
  loading: Promise<void> | undefined
  recovering: Promise<void> | undefined
}

const state: RuntimeState = {
  init: undefined,
  model: undefined,
  context: undefined,
  chat: undefined,
  loading: undefined,
  recovering: undefined,
}

const activeRequests = new Map<string, AbortController>()

function postMessage(message: LocalRuntimeWorkerResponse) {
  workerPort.postMessage(message)
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

async function createModel(init: LocalRuntimeInitInput) {
  const { getLlama } = await import("node-llama-cpp")
  const lastBuildOptions: LastBuildOptions | undefined = init.maxThreads === undefined
    ? undefined
    : { maxThreads: init.maxThreads }
  const defaultContextKvCacheKeyType = init.cacheTypeK as LlamaModelOptions["experimentalDefaultContextKvCacheKeyType"] | undefined
  const defaultContextKvCacheValueType = init.cacheTypeV as LlamaModelOptions["experimentalDefaultContextKvCacheValueType"] | undefined

  const llama = await getLlama("lastBuild", lastBuildOptions)
  const modelOptions: LlamaModelOptions = {
    modelPath: init.ggufPath,
    gpuLayers: init.nGpuLayers === -1 ? "max" : init.nGpuLayers,
    ...(init.flashAttention !== undefined ? { defaultContextFlashAttention: init.flashAttention } : {}),
    ...(init.useMmap !== undefined ? { useMmap: init.useMmap } : {}),
    ...(init.useMlock !== undefined ? { useMlock: init.useMlock } : {}),
    ...(defaultContextKvCacheKeyType ? { experimentalDefaultContextKvCacheKeyType: defaultContextKvCacheKeyType } : {}),
    ...(defaultContextKvCacheValueType ? { experimentalDefaultContextKvCacheValueType: defaultContextKvCacheValueType } : {}),
  }

  log.info("loading llama model in worker", {
    ggufPath: init.ggufPath,
    gpuLayers: modelOptions.gpuLayers,
    useMmap: modelOptions.useMmap,
    useMlock: modelOptions.useMlock,
    defaultContextFlashAttention: modelOptions.defaultContextFlashAttention,
    defaultContextKvCacheKeyType: modelOptions.experimentalDefaultContextKvCacheKeyType,
    defaultContextKvCacheValueType: modelOptions.experimentalDefaultContextKvCacheValueType,
  })

  return llama.loadModel(modelOptions)
}

async function createContextAndChat(model: LlamaModel, init: LocalRuntimeInitInput) {
  const { LlamaChat } = await import("node-llama-cpp")
  const contextKvCacheKeyType = init.cacheTypeK as LlamaContextOptions["experimentalKvCacheKeyType"] | undefined
  const contextKvCacheValueType = init.cacheTypeV as LlamaContextOptions["experimentalKvCacheValueType"] | undefined

  const contextOptions: LlamaContextOptions = {
    contextSize: init.nCtx,
    ...(init.batchSize !== undefined ? { batchSize: init.batchSize } : {}),
    ...(init.threads !== undefined ? { threads: init.threads } : {}),
    ...(init.sequences !== undefined ? { sequences: init.sequences } : {}),
    ...(init.flashAttention !== undefined ? { flashAttention: init.flashAttention } : {}),
  }
  if (contextKvCacheKeyType) contextOptions.experimentalKvCacheKeyType = contextKvCacheKeyType
  if (contextKvCacheValueType) contextOptions.experimentalKvCacheValueType = contextKvCacheValueType

  log.info("creating llama context in worker", {
    requestedContextSize: contextOptions.contextSize,
    batchSize: contextOptions.batchSize,
    threads: contextOptions.threads,
    sequences: contextOptions.sequences,
    flashAttention: contextOptions.flashAttention,
    kvCacheKeyType: contextOptions.experimentalKvCacheKeyType,
    kvCacheValueType: contextOptions.experimentalKvCacheValueType,
  })

  const context = await model.createContext(contextOptions)
  log.info("llama context created in worker", {
    contextSize: context.contextSize,
    batchSize: context.batchSize,
    flashAttention: context.flashAttention,
    kvCacheKeyType: context.kvCacheKeyType,
    kvCacheValueType: context.kvCacheValueType,
  })

  return {
    context,
    chat: new LlamaChat({ contextSequence: context.getSequence() }),
  }
}

async function disposeContext() {
  const context = state.context as { dispose?: () => void | Promise<void> } | undefined
  state.context = undefined
  state.chat = undefined
  await context?.dispose?.()
}

async function ensureLoaded(force = false) {
  if (!state.init) throw new Error("Local runtime worker has not been initialized")
  if (state.model && state.chat && !force) return
  if (state.loading) return state.loading

  state.loading = (async () => {
    if (!state.init) throw new Error("Local runtime worker has not been initialized")
    if (!state.model) {
      state.model = await createModel(state.init)
    }
    if (state.context) {
      await disposeContext()
    }
    const next = await createContextAndChat(state.model, state.init)
    state.context = next.context
    state.chat = next.chat
  })()
    .finally(() => {
      state.loading = undefined
    })

  return state.loading
}

async function recoverAfterTimeout() {
  if (state.recovering) return state.recovering
  state.recovering = ensureLoaded(true).finally(() => {
    state.recovering = undefined
  })
  return state.recovering
}

function normalizeResult(result: any): LocalRuntimeResult {
  const parts: LocalRuntimeResponsePart[] = []
  for (const item of result.fullResponse ?? []) {
    if (typeof item === "string" && item) {
      parts.push({ type: "text", text: item })
      continue
    }

    if (typeof item === "object" && item !== null) {
      const segment = item as { type?: string; segmentType?: string; text?: string }
      if (segment.type === "segment" && segment.segmentType === "thought" && segment.text) {
        parts.push({ type: "reasoning", text: segment.text })
      }
    }
  }

  return {
    responseText: result.response || "",
    parts,
    stopReason: result.metadata?.stopReason ?? "unknown",
  }
}

function isTimeoutError(error: unknown) {
  return error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError" || error.message.toLowerCase().includes("timeout"))
}

function createChunkIdleTimeout(ms: number) {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined

  const refresh = () => {
    if (ms <= 0) return
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      controller.abort(new Error(`Local runtime chunk idle timeout after ${ms}ms`))
    }, ms)
  }

  const clear = () => {
    if (!timeout) return
    clearTimeout(timeout)
    timeout = undefined
  }

  refresh()

  return {
    signal: controller.signal,
    refresh,
    clear,
  }
}

async function runInference(
  requestId: string,
  input: LocalRuntimeGenerateInput,
  onEvent?: (event: LocalRuntimeStreamEvent) => void,
): Promise<LocalRuntimeResult> {
  if (!state.init) throw new Error("Local runtime worker has not been initialized")
  await ensureLoaded()
  const chat = state.chat
  if (!chat) throw new Error("Local runtime worker chat is not initialized")

  const history = input.history
  const timeoutMs = state.init.inferenceTimeout * 1000
  for (let attempt = 1; attempt <= state.init.inferenceRetries; attempt++) {
    const requestAbort = new AbortController()
    const idleTimeout = timeoutMs > 0 ? createChunkIdleTimeout(timeoutMs) : undefined
    activeRequests.set(requestId, requestAbort)
    let reasoningOpen = false

    try {
      const signals: AbortSignal[] = [requestAbort.signal]
      if (idleTimeout) signals.push(idleTimeout.signal)
      const signal = AbortSignal.any(signals)

      const result = await chat.generateResponse(history, {
        signal,
        temperature: state.init.samplingParams.temperature,
        topP: state.init.samplingParams.topP,
        topK: state.init.samplingParams.topK,
        minP: state.init.samplingParams.minP,
        repeatPenalty: state.init.samplingParams.repeatPenalty === undefined
          ? undefined
          : { penalty: state.init.samplingParams.repeatPenalty },
        onResponseChunk(chunk: LlamaChatResponseChunk) {
          idleTimeout?.refresh()
          if (!onEvent) return

          if (chunk.type === "segment" && chunk.segmentType === "thought") {
            if (!reasoningOpen) {
              reasoningOpen = true
              onEvent({ type: "reasoning-start" })
            }
            if (chunk.text) onEvent({ type: "reasoning-delta", text: chunk.text })
            if (chunk.segmentEndTime && reasoningOpen) {
              reasoningOpen = false
              onEvent({ type: "reasoning-end" })
            }
            return
          }

          if (reasoningOpen) {
            reasoningOpen = false
            onEvent({ type: "reasoning-end" })
          }
          if (chunk.text) onEvent({ type: "text", text: chunk.text })
        },
      })

      if (reasoningOpen) onEvent?.({ type: "reasoning-end" })
      return normalizeResult(result)
    } catch (error) {
      if (requestAbort.signal.aborted) throw error
      if (!isTimeoutError(error) || attempt >= state.init.inferenceRetries) throw error
      log.warn("local runtime worker chunk idle timeout, rebuilding context", {
        attempt,
        retries: state.init.inferenceRetries,
        timeoutMs,
      })
      await recoverAfterTimeout()
    } finally {
      idleTimeout?.clear()
      activeRequests.delete(requestId)
    }
  }

  throw new Error("Local runtime inference failed after all retries")
}

async function handleMessage(message: LocalRuntimeWorkerRequest) {
  if (message.type === "abort") {
    activeRequests.get(message.requestId)?.abort()
    return
  }

  if (message.type === "dispose") {
    process.exit(0)
  }

  try {
    if (message.type === "init") {
      state.init = message.payload
      await ensureLoaded(true)
      postMessage({ type: "ready", requestId: message.requestId })
      return
    }

    if (message.type === "generate") {
      const result = await runInference(message.requestId, message.payload)
      postMessage({ type: "result", requestId: message.requestId, payload: result })
      return
    }

    if (message.type === "stream") {
      const result = await runInference(message.requestId, message.payload, (event) => {
        postMessage({ type: "stream-event", requestId: message.requestId, payload: event })
      })
      postMessage({ type: "stream-end", requestId: message.requestId, payload: result })
    }
  } catch (error) {
    postMessage({ type: "error", requestId: message.requestId, error: serializeError(error) })
  }
}

workerPort.on("message", (message: LocalRuntimeWorkerRequest) => {
  void handleMessage(message)
})
