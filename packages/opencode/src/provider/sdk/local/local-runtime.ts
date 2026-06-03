import fs from "node:fs"
import { Worker } from "node:worker_threads"
import { fileURLToPath } from "node:url"
import { generateId } from "@ai-sdk/provider-utils"
import * as Log from "@opencode-ai/core/util/log"
import type {
  LocalRuntimeGenerateInput,
  LocalRuntimeInitInput,
  LocalRuntimeResult,
  LocalRuntimeStreamMessage,
  LocalRuntimeWorkerRequest,
  LocalRuntimeWorkerResponse,
} from "./local-runtime-protocol"

const log = Log.create({ service: "local-runtime" })

declare global {
  const OPENCODE_LOCAL_RUNTIME_WORKER_PATH: string | undefined
}

type PendingRequest = {
  resolve: (payload: unknown) => void
  reject: (error: Error) => void
  abortCleanup: () => void
}

type PendingStream = {
  controller: ReadableStreamDefaultController<LocalRuntimeStreamMessage>
  abortCleanup: () => void
}

async function resolveWorkerTarget() {
  if (typeof OPENCODE_LOCAL_RUNTIME_WORKER_PATH !== "undefined") {
    return OPENCODE_LOCAL_RUNTIME_WORKER_PATH
  }

  const candidates = [
    new URL("./local-runtime-worker.js", import.meta.url),
    new URL("./provider/sdk/local/local-runtime-worker.js", import.meta.url),
    new URL("./local-runtime-worker.ts", import.meta.url),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(fileURLToPath(candidate))) return candidate
  }

  return candidates[candidates.length - 1]
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

export interface LocalRuntimeClient {
  init(input: LocalRuntimeInitInput): Promise<void>
  generate(input: LocalRuntimeGenerateInput, abortSignal?: AbortSignal): Promise<LocalRuntimeResult>
  stream(input: LocalRuntimeGenerateInput, abortSignal?: AbortSignal): Promise<ReadableStream<LocalRuntimeStreamMessage>>
  dispose(): Promise<void>
}

class LocalRuntimeWorkerClient implements LocalRuntimeClient {
  private worker: Worker | undefined
  private initPromise: Promise<void> | undefined
  private initialized = false
  private readonly pending = new Map<string, PendingRequest>()
  private readonly streams = new Map<string, PendingStream>()

  private async ensureWorker() {
    if (this.worker) return this.worker

    const worker = new Worker(await resolveWorkerTarget())
    worker.on("message", (message: LocalRuntimeWorkerResponse) => this.handleMessage(message))
    worker.on("error", (error) => this.handleFailure(error))
    worker.on("exit", (code) => {
      if (code !== 0) this.handleFailure(new Error(`Local runtime worker exited with code ${code}`))
      this.worker = undefined
      this.initialized = false
      this.initPromise = undefined
    })
    this.worker = worker
    return worker
  }

  private handleFailure(error: unknown) {
    const cause = toError(error)
    log.error("local runtime worker failed", { error: cause.message, stack: cause.stack })

    for (const [requestId, pending] of this.pending) {
      pending.abortCleanup()
      pending.reject(cause)
      this.pending.delete(requestId)
    }

    for (const [requestId, stream] of this.streams) {
      stream.abortCleanup()
      stream.controller.error(cause)
      this.streams.delete(requestId)
    }

    if (this.worker) {
      this.worker.removeAllListeners()
      this.worker = undefined
    }
    this.initialized = false
    this.initPromise = undefined
  }

  private bindAbort(requestId: string, abortSignal?: AbortSignal) {
    if (!abortSignal) return () => {}

    const abort = () => {
      if (!this.worker) return
      this.worker.postMessage({ type: "abort", requestId } satisfies LocalRuntimeWorkerRequest)
    }

    if (abortSignal.aborted) {
      abort()
      return () => {}
    }

    abortSignal.addEventListener("abort", abort, { once: true })
    return () => abortSignal.removeEventListener("abort", abort)
  }

  private async request<T>(
    message: Extract<LocalRuntimeWorkerRequest, { type: "init" | "generate" }>,
    abortSignal?: AbortSignal,
  ) {
    const worker = await this.ensureWorker()
    return new Promise<T>((resolve, reject) => {
      const abortCleanup = this.bindAbort(message.requestId, abortSignal)
      this.pending.set(message.requestId, {
        abortCleanup,
        resolve: (payload) => resolve(payload as T),
        reject,
      })
      worker.postMessage(message)
    })
  }

  private handleMessage(message: LocalRuntimeWorkerResponse) {
    if (message.type === "ready") {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      pending.abortCleanup()
      pending.resolve(undefined)
      this.pending.delete(message.requestId)
      return
    }

    if (message.type === "result") {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      pending.abortCleanup()
      pending.resolve(message.payload)
      this.pending.delete(message.requestId)
      return
    }

    if (message.type === "stream-event") {
      const stream = this.streams.get(message.requestId)
      if (!stream) return
      stream.controller.enqueue(message.payload)
      return
    }

    if (message.type === "stream-end") {
      const stream = this.streams.get(message.requestId)
      if (!stream) return
      stream.controller.enqueue({ type: "result", result: message.payload })
      stream.abortCleanup()
      stream.controller.close()
      this.streams.delete(message.requestId)
      return
    }

    if (message.type === "error") {
      const error = new Error(message.error.message)
      error.stack = message.error.stack

      const pending = this.pending.get(message.requestId)
      if (pending) {
        pending.abortCleanup()
        pending.reject(error)
        this.pending.delete(message.requestId)
      }

      const stream = this.streams.get(message.requestId)
      if (stream) {
        stream.abortCleanup()
        stream.controller.error(error)
        this.streams.delete(message.requestId)
      }
    }
  }

  async init(input: LocalRuntimeInitInput) {
    if (this.initialized) return
    if (!this.initPromise) {
      this.initPromise = this.request<void>({ type: "init", requestId: generateId(), payload: input })
        .then(() => {
          this.initialized = true
        })
        .catch((error) => {
          this.initPromise = undefined
          throw error
        })
    }
    return this.initPromise
  }

  async generate(input: LocalRuntimeGenerateInput, abortSignal?: AbortSignal) {
    if (!this.initialized) throw new Error("Local runtime has not been initialized")
    return this.request<LocalRuntimeResult>(
      { type: "generate", requestId: generateId(), payload: input },
      abortSignal,
    )
  }

  async stream(input: LocalRuntimeGenerateInput, abortSignal?: AbortSignal) {
    if (!this.initialized) throw new Error("Local runtime has not been initialized")
    const requestId = generateId()

    return new ReadableStream<LocalRuntimeStreamMessage>({
      start: async (controller) => {
        try {
          const worker = await this.ensureWorker()
          const abortCleanup = this.bindAbort(requestId, abortSignal)
          this.streams.set(requestId, { controller, abortCleanup })
          worker.postMessage({ type: "stream", requestId, payload: input } satisfies LocalRuntimeWorkerRequest)
        } catch (error) {
          controller.error(toError(error))
        }
      },
      cancel: () => {
        const stream = this.streams.get(requestId)
        stream?.abortCleanup()
        this.streams.delete(requestId)
        if (this.worker) {
          this.worker.postMessage({ type: "abort", requestId } satisfies LocalRuntimeWorkerRequest)
        }
      },
    })
  }

  async dispose() {
    const worker = this.worker
    this.worker = undefined
    this.initialized = false
    this.initPromise = undefined
    if (!worker) return
    worker.postMessage({ type: "dispose" } satisfies LocalRuntimeWorkerRequest)
    await worker.terminate()
  }
}

export function createLocalRuntimeClient(): LocalRuntimeClient {
  return new LocalRuntimeWorkerClient()
}
