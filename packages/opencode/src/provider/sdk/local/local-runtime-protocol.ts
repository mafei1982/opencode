import type { LocalRuntimeHistoryItem } from "./local-prompt"

export type LocalRuntimeInitInput = {
  ggufPath: string
  nCtx: number
  nGpuLayers: number
  batchSize?: number
  threads?: number
  maxThreads?: number
  sequences?: number
  cacheTypeK?: string
  cacheTypeV?: string
  flashAttention?: boolean
  useMmap?: boolean
  useMlock?: boolean
  samplingParams: {
    temperature?: number
    topP?: number
    topK?: number
    minP?: number
    repeatPenalty?: number
  }
  inferenceTimeout: number
  inferenceRetries: number
}

export type LocalRuntimeGenerateInput = {
  history: LocalRuntimeHistoryItem[]
}

export type LocalRuntimeResponsePart = {
  type: "text" | "reasoning"
  text: string
}

export type LocalRuntimeResult = {
  responseText: string
  parts: LocalRuntimeResponsePart[]
  stopReason: string
}

export type LocalRuntimeStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning-start" }
  | { type: "reasoning-delta"; text: string }
  | { type: "reasoning-end" }

export type LocalRuntimeStreamMessage =
  | LocalRuntimeStreamEvent
  | { type: "result"; result: LocalRuntimeResult }

export type LocalRuntimeWorkerRequest =
  | { type: "init"; requestId: string; payload: LocalRuntimeInitInput }
  | { type: "generate"; requestId: string; payload: LocalRuntimeGenerateInput }
  | { type: "stream"; requestId: string; payload: LocalRuntimeGenerateInput }
  | { type: "abort"; requestId: string }
  | { type: "dispose" }

export type LocalRuntimeWorkerResponse =
  | { type: "ready"; requestId: string }
  | { type: "result"; requestId: string; payload: LocalRuntimeResult }
  | { type: "stream-event"; requestId: string; payload: LocalRuntimeStreamEvent }
  | { type: "stream-end"; requestId: string; payload: LocalRuntimeResult }
  | { type: "error"; requestId: string; error: { message: string; stack?: string } }
