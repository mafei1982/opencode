/**
 * LanguageModelV3 adapter for node-llama-cpp.
 *
 * Uses LlamaChat.generateResponse() which stops naturally when the model
 * triggers function calls (stopReason: "functionCalls"), returning parsed
 * calls without needing abort hacks or internal loops.
 *
 * Tool calls and results are stored as ChatModelFunctionCall objects
 * so the Jinja chat template renders them correctly.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"
import type { LlamaModel, LlamaChat, LlamaContext, LlamaChatResponseChunk, LlamaChatResponseFunctionCallParamsChunk } from "node-llama-cpp"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "local-llm" })

export type LocalLanguageModelConfig = {
  model: LlamaModel
  context: LlamaContext
  chat: LlamaChat
  nCtx: number
  disableThinking: boolean
  samplingParams: {
    temperature?: number
    topP?: number
    topK?: number
    minP?: number
  }
  inferenceTimeout: number
  inferenceRetries: number
  modelFactory: () => Promise<{
    model: LlamaModel
    context: LlamaContext
    chat: LlamaChat
  }>
}

// Extract clean text from AI SDK V3 tool result.
// part.result can be: {type,value} object, array of content parts, or string
function extractToolResultText(result: unknown): string {
  if (!result) return "(no output)"
  if (typeof result === "string") return result

  if (Array.isArray(result)) {
    return result
      .map((item: Record<string, unknown>) =>
        item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item),
      )
      .join("\n") || "(no output)"
  }

  if (typeof result === "object") {
    const obj = result as Record<string, unknown>
    if ("value" in obj) {
      if (obj.type === "content" && Array.isArray(obj.value)) {
        return (obj.value as Array<Record<string, unknown>>)
          .map((item) =>
            item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item),
          )
          .join("\n") || "(no output)"
      }
      if (typeof obj.value === "string") return obj.value || "(no output)"
      return JSON.stringify(obj.value)
    }
    if ("text" in obj && obj.type === "text" && typeof obj.text === "string") {
      return obj.text || "(no output)"
    }
  }

  return JSON.stringify(result)
}

// Convert AI SDK prompt to node-llama-cpp ChatHistoryItem format.
// Tool calls/results are stored as ChatModelFunctionCall objects so the
// Jinja template renders them correctly as <tool_call> and <tool_response>.
function convertPromptToChatHistory(prompt: LanguageModelV3CallOptions["prompt"]) {
  const history: Array<Record<string, unknown>> = []

  for (const msg of prompt) {
    if (msg.role === "system") {
      history.push({ type: "system", text: msg.content })
    } else if (msg.role === "user") {
      const texts: string[] = []
      for (const part of msg.content) {
        if (part.type === "text") texts.push(part.text)
      }
      history.push({ type: "user", text: texts.join("\n") })
    } else if (msg.role === "assistant") {
      const response: unknown[] = []
      for (const part of msg.content) {
        if (part.type === "text" && part.text.trim()) {
          response.push(part.text)
        }
        if (part.type === "tool-call") {
          const parsedInput = typeof part.input === "string"
            ? (() => { try { return JSON.parse(part.input as string) } catch { return {} } })()
            : (part.input ?? {})
          response.push({
            type: "functionCall",
            name: part.toolName,
            _callId: part.toolCallId,
            params: parsedInput,
            result: null,
          })
        }
      }
      if (response.length > 0) history.push({ type: "model", response })
    } else if (msg.role === "tool") {
      // Match tool results to their functionCall objects in the last model message
      const lastModel = history.findLast((h) => h.type === "model") as { response: Array<Record<string, unknown>> } | undefined
      if (lastModel) {
        for (const part of msg.content) {
          if (part.type === "tool-result") {
            const call = lastModel.response.find(
              (r) => r.type === "functionCall" && r._callId === part.toolCallId && r.result === null,
            )
            if (call) {
              call.result = extractToolResultText(part.output)
            }
          }
        }
      }
    }
  }

  // generateResponse expects history ending with a user message
  const lastItem = history[history.length - 1]
  if (!lastItem || lastItem.type !== "user") {
    history.push({ type: "user", text: "Continue." })
  }

  return history
}

// Build ChatModelFunctions from AI SDK tools (no handler — LlamaChat stops naturally).
function buildChatModelFunctions(tools: LanguageModelV3CallOptions["tools"]) {
  if (!tools || tools.length === 0) return undefined
  const functions: Record<string, { description?: string; params?: object }> = {}
  for (const tool of tools) {
    if (tool.type !== "function") continue
    functions[tool.name] = {
      description: tool.description ?? "",
      ...(tool.inputSchema ? { params: tool.inputSchema } : {}),
    }
  }
  log.info("built chat model functions", { names: Object.keys(functions) })
  return functions
}

export class LocalLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly modelId: string
  readonly provider = "local"
  readonly supportsStructuredOutputs = false

  private config: LocalLanguageModelConfig
  private recovering = false

  constructor(modelId: string, config: LocalLanguageModelConfig) {
    this.modelId = modelId
    this.config = config
  }

  get supportedUrls() {
    return {}
  }

  private async recoverAfterTimeout() {
    if (this.recovering) return
    this.recovering = true
    try {
      log.warn("=== TIMEOUT RECOVERY: Starting model reload ===")
      const fresh = await this.config.modelFactory()
      this.config.model = fresh.model
      this.config.context = fresh.context
      this.config.chat = fresh.chat
      log.info("=== TIMEOUT RECOVERY: Model reloaded successfully ===")
    } catch (err) {
      log.error("failed to reload model", { error: err })
    } finally {
      this.recovering = false
    }
  }

  async doGenerate(options: LanguageModelV3CallOptions) {
    const history = convertPromptToChatHistory(options.prompt)
    const functions = buildChatModelFunctions(options.tools)

    const lastUser = [...history].reverse().find((h) => h.type === "user") as { text?: string } | undefined
    log.info("doGenerate request", {
      historyItems: history.length,
      lastUserChars: lastUser?.text?.length ?? 0,
      toolCount: functions ? Object.keys(functions).length : 0,
      disableThinking: this.config.disableThinking,
      sampling: this.config.samplingParams,
      inferenceTimeout: this.config.inferenceTimeout,
      inferenceRetries: this.config.inferenceRetries,
    })

    const timeoutMs = this.config.inferenceTimeout * 1000
    const maxRetries = this.config.inferenceRetries
    let result: { response: string; fullResponse: Array<unknown>; functionCalls?: Array<{ functionName: string; params: unknown }>; metadata: { stopReason: string } } | undefined

    const startedAt = Date.now()
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const signals: AbortSignal[] = []
      if (options.abortSignal) signals.push(options.abortSignal)
      if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
      const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined

      try {
        result = await (this.config.chat as any).generateResponse(
          history,
          {
            signal,
            temperature: this.config.samplingParams.temperature,
            topP: this.config.samplingParams.topP,
            topK: this.config.samplingParams.topK,
            minP: this.config.samplingParams.minP,
            ...(functions ? { functions: functions as any } : {}),
          },
        )
        break
      } catch (err: unknown) {
        if (options.abortSignal?.aborted) throw err
        const isTimeout = err instanceof Error &&
          (err.name === "TimeoutError" || err.name === "AbortError" || err.message.includes("timeout"))
        if (!isTimeout || attempt >= maxRetries) throw err
        log.warn("inference timeout, attempting recovery", { attempt, maxRetries })
        await this.recoverAfterTimeout()
      }
    }

    if (!result) throw new Error("inference failed after all retries")

    const content: LanguageModelV3Content[] = []
    const hasFunctionCalls = result.metadata.stopReason === "functionCalls" && result.functionCalls && result.functionCalls.length > 0

    // Process fullResponse for text and thinking segments
    let thoughtChars = 0
    let textChars = 0
    for (const item of result.fullResponse) {
      if (typeof item === "string" && item.trim()) {
        textChars += item.length
        content.push({ type: "text", text: item })
      } else if (typeof item === "object" && item !== null) {
        const seg = item as { type?: string; segmentType?: string; text?: string }
        if (seg.type === "segment" && seg.segmentType === "thought" && seg.text) {
          thoughtChars += seg.text.length
          content.push({ type: "reasoning", text: seg.text })
        }
      }
    }

    log.info("doGenerate response", {
      stopReason: result.metadata.stopReason,
      durationMs: Date.now() - startedAt,
      thoughtChars,
      textChars,
      responseChars: result.response?.length ?? 0,
      functionCalls: hasFunctionCalls ? result.functionCalls!.map((c) => c.functionName) : [],
    })
    if (result.metadata.stopReason === "maxTokens") {
      log.warn("doGenerate hit maxTokens without natural stop (possible loop / runaway thinking)", {
        thoughtChars,
        textChars,
      })
    }

    // Add function calls from result
    if (hasFunctionCalls) {
      for (const call of result.functionCalls!) {
        content.push({
          type: "tool-call",
          toolCallId: `call_${generateId()}`,
          toolName: call.functionName,
          input: JSON.stringify(call.params),
        })
      }
    }

    if (content.length === 0) {
      content.push({ type: "text", text: result.response || "(empty response)" })
    }

    return {
      content,
      finishReason: {
        unified: hasFunctionCalls ? ("tool-calls" as const) : ("stop" as const),
        raw: result.metadata.stopReason,
      },
      usage: { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } },
      request: { body: "" },
      response: {
        id: generateId(),
        modelId: this.modelId,
        headers: {},
        body: result.response || "",
      },
      warnings: [],
    }
  }

  async doStream(options: LanguageModelV3CallOptions) {
    const history = convertPromptToChatHistory(options.prompt)
    const functions = buildChatModelFunctions(options.tools)
    const config = this.config
    const modelId = this.modelId

    const lastUser = [...history].reverse().find((h) => h.type === "user") as { text?: string } | undefined
    log.info("doStream request", {
      historyItems: history.length,
      lastUserChars: lastUser?.text?.length ?? 0,
      toolCount: functions ? Object.keys(functions).length : 0,
      disableThinking: config.disableThinking,
      sampling: config.samplingParams,
    })

    const outputStream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })

        let activeReasoningId: string | undefined
        let activeTextId: string | undefined
        const toolInputIds = new Map<number, { callId: string; toolName: string }>()

        // Diagnostics for loop / runaway-thinking detection
        const startedAt = Date.now()
        let firstTokenAt: number | undefined
        let thoughtChars = 0
        let textChars = 0
        let chunkCount = 0

        try {
          const result: any = await (config.chat as any).generateResponse(
            history,
            {
              signal: options.abortSignal,
              temperature: config.samplingParams.temperature,
              topP: config.samplingParams.topP,
              topK: config.samplingParams.topK,
              minP: config.samplingParams.minP,
              ...(functions ? { functions: functions as any } : {}),
              onResponseChunk(chunk: LlamaChatResponseChunk) {
                chunkCount++
                if (firstTokenAt === undefined) firstTokenAt = Date.now()
                if (chunk.type === "segment" && chunk.segmentType === "thought") {
                  if (chunk.text) thoughtChars += chunk.text.length
                  if (activeTextId) {
                    controller.enqueue({ type: "text-end", id: activeTextId })
                    activeTextId = undefined
                  }
                  if ((chunk as any).segmentStartTime) {
                    activeReasoningId = generateId()
                    controller.enqueue({ type: "reasoning-start", id: activeReasoningId })
                  }
                  if (chunk.text && activeReasoningId) {
                    controller.enqueue({ type: "reasoning-delta", id: activeReasoningId, delta: chunk.text })
                  }
                  if ((chunk as any).segmentEndTime && activeReasoningId) {
                    controller.enqueue({ type: "reasoning-end", id: activeReasoningId })
                    activeReasoningId = undefined
                  }
                } else if (chunk.text) {
                  textChars += chunk.text.length
                  if (activeReasoningId) {
                    controller.enqueue({ type: "reasoning-end", id: activeReasoningId })
                    activeReasoningId = undefined
                  }
                  if (!activeTextId) {
                    activeTextId = generateId()
                    controller.enqueue({ type: "text-start", id: activeTextId })
                  }
                  controller.enqueue({ type: "text-delta", id: activeTextId, delta: chunk.text })
                }
              },
              ...(functions ? {
                onFunctionCallParamsChunk(chunk: LlamaChatResponseFunctionCallParamsChunk) {
                  // Close open text/reasoning when first function call starts
                  if (toolInputIds.size === 0) {
                    if (activeTextId) {
                      controller.enqueue({ type: "text-end", id: activeTextId })
                      activeTextId = undefined
                    }
                    if (activeReasoningId) {
                      controller.enqueue({ type: "reasoning-end", id: activeReasoningId })
                      activeReasoningId = undefined
                    }
                  }

                  if (!toolInputIds.has(chunk.callIndex)) {
                    const callId = `call_${generateId()}`
                    toolInputIds.set(chunk.callIndex, { callId, toolName: chunk.functionName })
                    controller.enqueue({ type: "tool-input-start", id: callId, toolName: chunk.functionName })
                  }
                  const info = toolInputIds.get(chunk.callIndex)!
                  controller.enqueue({ type: "tool-input-delta", id: info.callId, delta: chunk.paramsChunk })
                },
              } : {}),
            },
          )

          // Close any open segments
          if (activeReasoningId) controller.enqueue({ type: "reasoning-end", id: activeReasoningId })
          if (activeTextId) controller.enqueue({ type: "text-end", id: activeTextId })

          const hasFunctionCalls = result.metadata?.stopReason === "functionCalls" && result.functionCalls?.length > 0

          log.info("doStream response", {
            stopReason: result.metadata?.stopReason ?? "unknown",
            durationMs: Date.now() - startedAt,
            timeToFirstTokenMs: firstTokenAt ? firstTokenAt - startedAt : undefined,
            chunkCount,
            thoughtChars,
            textChars,
            functionCalls: hasFunctionCalls ? result.functionCalls.map((c: { functionName: string }) => c.functionName) : [],
          })
          if (result.metadata?.stopReason === "maxTokens") {
            log.warn("doStream hit maxTokens without natural stop (possible loop / runaway thinking)", {
              thoughtChars,
              textChars,
              sampling: config.samplingParams,
            })
          }

          // Emit tool calls from result
          if (hasFunctionCalls) {
            for (const call of result.functionCalls) {
              const existing = [...toolInputIds.values()].find((v) => v.toolName === call.functionName)
              if (existing) {
                controller.enqueue({ type: "tool-input-end", id: existing.callId })
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: existing.callId,
                  toolName: call.functionName,
                  input: JSON.stringify(call.params),
                })
              } else {
                const callId = `call_${generateId()}`
                controller.enqueue({ type: "tool-input-start", id: callId, toolName: call.functionName })
                controller.enqueue({ type: "tool-input-delta", id: callId, delta: JSON.stringify(call.params) })
                controller.enqueue({ type: "tool-input-end", id: callId })
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: callId,
                  toolName: call.functionName,
                  input: JSON.stringify(call.params),
                })
              }
            }
          }

          controller.enqueue({
            type: "finish",
            finishReason: {
              unified: hasFunctionCalls ? "tool-calls" : "stop",
              raw: result.metadata?.stopReason ?? "unknown",
            },
            usage: { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } },
            providerMetadata: {},
          })
          controller.close()
        } catch (err) {
          log.error("doStream inference error", {
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startedAt,
            thoughtChars,
            textChars,
            chunkCount,
          })
          // Close any open segments before error
          if (activeReasoningId) controller.enqueue({ type: "reasoning-end", id: activeReasoningId })
          if (activeTextId) controller.enqueue({ type: "text-end", id: activeTextId })
          controller.enqueue({
            type: "error",
            error: err instanceof Error ? err : new Error(String(err)),
          })
          controller.close()
        }
      },
    })

    return {
      stream: outputStream,
      request: { body: "" },
      response: { headers: {} },
      warnings: [],
    }
  }
}
