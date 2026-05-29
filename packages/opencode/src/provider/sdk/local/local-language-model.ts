/**
 * LanguageModelV3 adapter for node-llama-cpp.
 *
 * Wraps an in-process llama.cpp model as an AI SDK LanguageModelV3,
 * enabling seamless integration with the opencode provider system.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"
import type { LlamaModel, LlamaChatSession, LlamaContext, LlamaChatResponseChunk } from "node-llama-cpp"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "local-llm" })

export type LocalLanguageModelConfig = {
  model: LlamaModel
  context: LlamaContext
  session: LlamaChatSession
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
    session: LlamaChatSession
  }>
}

interface ParsedToolCall {
  name: string
  arguments: string
}

function parseToolCalls(content: string): ParsedToolCall[] {
  const pattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  const calls: ParsedToolCall[] = []

  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    const raw = match[1].trim()

    // Try JSON format: {"name": "fn", "arguments": {...}}
    try {
      const obj = JSON.parse(raw)
      calls.push({
        name: obj.name ?? "",
        arguments: typeof obj.arguments === "object" ? JSON.stringify(obj.arguments) : String(obj.arguments ?? "{}"),
      })
      continue
    } catch {
      // Not JSON, try XML function format
    }

    // Try XML format: <function=name><parameter=key>value</parameter></function>
    const fnMatch = /<function=([^>]+)>([\s\S]*?)<\/function>/.exec(raw)
    if (fnMatch) {
      const name = fnMatch[1]
      const paramsRaw = fnMatch[2]
      const params: Record<string, string> = {}
      const paramPattern = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g
      let pm: RegExpExecArray | null
      while ((pm = paramPattern.exec(paramsRaw)) !== null) {
        params[pm[1]] = pm[2]
      }
      calls.push({ name, arguments: JSON.stringify(params) })
      continue
    }

    log.warn("failed to parse tool_call block", { raw: raw.slice(0, 200) })
  }

  return calls
}

function convertPromptToText(prompt: LanguageModelV3CallOptions["prompt"]): string {
  const parts: string[] = []
  for (const msg of prompt) {
    if (msg.role === "system") {
      parts.push(`System: ${msg.content}`)
    } else if (msg.role === "user") {
      for (const part of msg.content) {
        if (part.type === "text") parts.push(`User: ${part.text}`)
      }
    } else if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") parts.push(`Assistant: ${part.text}`)
        if (part.type === "tool-call") parts.push(`Assistant: [tool_call: ${part.toolName}(${part.input})]`)
      }
    } else if (msg.role === "tool") {
      for (const part of msg.content) {
        if (part.type === "tool-result")
          parts.push(`Tool (${part.toolName}): ${typeof part.result === "string" ? part.result : JSON.stringify(part.result)}`)
      }
    }
  }
  return parts.join("\n")
}

function buildToolPrompt(tools: LanguageModelV3CallOptions["tools"]): string {
  if (!tools || tools.length === 0) return ""

  const toolDefs = tools
    .map((t) => {
      const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : "{}"
      return `- ${t.name}: ${t.description ?? ""}\n  Parameters: ${schema}`
    })
    .join("\n")

  return (
    "\n\nYou have access to the following tools. To call a tool, respond with a <tool_call> block:\n" +
    "<tool_call>\n" +
    '{"name": "tool_name", "arguments": {"param": "value"}}\n' +
    "</tool_call>\n\n" +
    "Available tools:\n" +
    toolDefs
  )
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

  private async runInference(text: string, abortSignal?: AbortSignal) {
    const timeoutMs = this.config.inferenceTimeout * 1000
    const maxRetries = this.config.inferenceRetries

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController()
      const signals: AbortSignal[] = [controller.signal]
      if (abortSignal) signals.push(abortSignal)
      if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
      const combined = AbortSignal.any(signals)

      try {
        return await this.config.session.promptWithMeta(text, {
          signal: combined,
          temperature: this.config.samplingParams.temperature,
          topP: this.config.samplingParams.topP,
          topK: this.config.samplingParams.topK,
          minP: this.config.samplingParams.minP,
        })
      } catch (err: unknown) {
        if (abortSignal?.aborted) throw err

        const isTimeout =
          err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError" || err.message.includes("timeout"))

        if (!isTimeout || attempt >= maxRetries) throw err

        log.warn("inference timeout, attempting recovery", { attempt, maxRetries })
        await this.recoverAfterTimeout()
      }
    }

    throw new Error("inference failed after all retries")
  }

  private async recoverAfterTimeout() {
    if (this.recovering) return
    this.recovering = true
    try {
      log.warn("=== TIMEOUT RECOVERY: Starting model reload ===")
      const fresh = await this.config.modelFactory()
      this.config.model = fresh.model
      this.config.context = fresh.context
      this.config.session = fresh.session
      log.info("=== TIMEOUT RECOVERY: Model reloaded successfully ===")
    } catch (err) {
      log.error("failed to reload model", { error: err })
    } finally {
      this.recovering = false
    }
  }

  async doGenerate(options: LanguageModelV3CallOptions) {
    const toolPrompt = buildToolPrompt(options.tools)
    const text = convertPromptToText(options.prompt) + toolPrompt

    const result = await this.runInference(text, options.abortSignal)
    const content: LanguageModelV3Content[] = []

    // Extract reasoning segments and text from structured response
    for (const item of result.response) {
      if (typeof item === "string") {
        if (item) content.push({ type: "text", text: item })
        continue
      }
      if (item.type === "segment" && item.segmentType === "thought") {
        if (item.text) content.push({ type: "reasoning", text: item.text })
        continue
      }
    }

    // Check for tool calls in the response text
    const toolCalls = parseToolCalls(result.responseText)
    if (toolCalls.length > 0) {
      // Remove tool_call blocks from text parts
      const filtered = content.filter((c) => {
        if (c.type !== "text") return true
        const stripped = c.text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim()
        if (!stripped) return false
        c.text = stripped
        return true
      })
      content.length = 0
      content.push(...filtered)
      for (const call of toolCalls) {
        content.push({
          type: "tool-call",
          toolCallId: `call_${generateId()}`,
          toolName: call.name,
          input: call.arguments,
        })
      }
    }

    // Ensure at least one text part
    if (!content.some((c) => c.type === "text")) {
      content.push({ type: "text", text: result.responseText })
    }

    return {
      content,
      finishReason: { unified: "stop" as const, raw: result.stopReason },
      usage: {
        inputTokens: { total: undefined },
        outputTokens: { total: undefined },
      },
      request: { body: text },
      response: {
        id: generateId(),
        modelId: this.modelId,
        headers: {},
        body: result.responseText,
      },
      warnings: [],
    }
  }

  async doStream(options: LanguageModelV3CallOptions) {
    const toolPrompt = buildToolPrompt(options.tools)
    const text = convertPromptToText(options.prompt) + toolPrompt

    const config = this.config
    const modelId = this.modelId

    const outputStream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })

        try {
          let fullResponse = ""
          const abortController = new AbortController()
          const signals: AbortSignal[] = [abortController.signal]
          if (options.abortSignal) signals.push(options.abortSignal)
          const combined = AbortSignal.any(signals)

          // Track segment state
          let activeReasoningId: string | undefined
          let activeTextId: string | undefined

          const result = await config.session.promptWithMeta(text, {
            signal: combined,
            temperature: config.samplingParams.temperature,
            topP: config.samplingParams.topP,
            topK: config.samplingParams.topK,
            minP: config.samplingParams.minP,
            onResponseChunk(chunk: LlamaChatResponseChunk) {
              if (chunk.type === "segment" && chunk.segmentType === "thought") {
                // Close any open text segment before reasoning
                if (activeTextId) {
                  controller.enqueue({ type: "text-end", id: activeTextId })
                  activeTextId = undefined
                }
                if (chunk.segmentStartTime) {
                  activeReasoningId = generateId()
                  controller.enqueue({ type: "reasoning-start", id: activeReasoningId })
                }
                if (chunk.text && activeReasoningId) {
                  controller.enqueue({ type: "reasoning-delta", id: activeReasoningId, delta: chunk.text })
                }
                if (chunk.segmentEndTime && activeReasoningId) {
                  controller.enqueue({ type: "reasoning-end", id: activeReasoningId })
                  activeReasoningId = undefined
                }
              } else {
                // Close any open reasoning segment before text
                if (activeReasoningId) {
                  controller.enqueue({ type: "reasoning-end", id: activeReasoningId })
                  activeReasoningId = undefined
                }
                if (chunk.text) {
                  if (!activeTextId) {
                    activeTextId = generateId()
                    controller.enqueue({ type: "text-start", id: activeTextId })
                  }
                  fullResponse += chunk.text
                  controller.enqueue({ type: "text-delta", id: activeTextId, delta: chunk.text })
                }
              }
            },
          })

          // Close any open segments
          if (activeReasoningId) {
            controller.enqueue({ type: "reasoning-end", id: activeReasoningId })
          }
          if (activeTextId) {
            controller.enqueue({ type: "text-end", id: activeTextId })
          }

          // Check for tool calls in final text
          const toolCalls = parseToolCalls(fullResponse)
          for (const call of toolCalls) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: `call_${generateId()}`,
              toolName: call.name,
              input: call.arguments,
            })
          }

          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: result.stopReason },
            usage: {
              inputTokens: { total: undefined },
              outputTokens: { total: undefined },
            },
            providerMetadata: {},
            response: {
              id: generateId(),
              modelId,
              headers: {},
              body: result.responseText,
            },
          })
          controller.close()
        } catch (err) {
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
      request: { body: text },
      response: {
        headers: {},
      },
      warnings: [],
    }
  }
}
