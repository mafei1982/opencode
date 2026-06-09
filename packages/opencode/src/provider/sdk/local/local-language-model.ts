import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"
import * as Log from "@opencode-ai/core/util/log"
import {
  buildLocalRuntimeHistory,
  LocalToolCallTextParser,
  type LocalParsedToolCall,
  type LocalToolCallParseIssue,
} from "./local-prompt"
import type { LocalRuntimeClient } from "./local-runtime"

const log = Log.create({ service: "local-llm" })
const MAX_TOOL_REPAIR_ATTEMPTS = 2

type LocalToolRepairIssue = LocalToolCallParseIssue | {
  code: "missing_required" | "unknown_tool"
  detail: string
  raw: string
  toolName?: string
  toolCallId?: string
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getToolRepairIssue(
  toolCalls: LocalParsedToolCall[],
  parseIssues: LocalToolCallParseIssue[],
  tools: LanguageModelV3CallOptions["tools"],
): LocalToolRepairIssue | undefined {
  if (parseIssues.length > 0) return parseIssues[0]

  const functionTools = (tools ?? []).filter((tool) => tool.type === "function")
  const toolMap = new Map(functionTools.map((tool) => [tool.name, tool]))

  const issues = toolCalls.flatMap<LocalToolRepairIssue>((call) => {
    const tool = toolMap.get(call.toolName)
    if (!tool) {
      return [{
        code: "unknown_tool" as const,
        detail: `Tool \"${call.toolName}\" is not in the available tool list.`,
        raw: call.input,
        toolName: call.toolName,
        toolCallId: call.toolCallId,
      }]
    }

    try {
      const parsed = JSON.parse(call.input)
      if (!isObjectRecord(parsed)) {
        return [{
          code: "invalid_input_shape" as const,
          detail: "Tool call JSON must decode to one object.",
          raw: call.input,
          toolName: call.toolName,
          toolCallId: call.toolCallId,
        }]
      }

      const required = Array.isArray(tool.inputSchema?.required)
        ? tool.inputSchema.required.filter((item): item is string => typeof item === "string")
        : []
      const missing = required.filter((key) => parsed[key] === undefined)
      if (missing.length === 0) return []

      return [{
        code: "missing_required" as const,
        detail: `Tool \"${call.toolName}\" is missing required parameter(s): ${missing.join(", ")}.`,
        raw: call.input,
        toolName: call.toolName,
        toolCallId: call.toolCallId,
      }]
    } catch {
      return [{
        code: "invalid_json" as const,
        detail: "Tool call JSON could not be decoded after parsing.",
        raw: call.input,
        toolName: call.toolName,
        toolCallId: call.toolCallId,
      }]
    }
  })[0]

  return issues
}

function buildToolRepairMessage(
  responseText: string,
  issue: LocalToolRepairIssue,
  tools: LanguageModelV3CallOptions["tools"],
) {
  const functionTools = (tools ?? []).filter((tool) => tool.type === "function")
  const matchedTool = issue.toolName ? functionTools.find((tool) => tool.name === issue.toolName) : undefined
  const rawResponse = (responseText.trim() || issue.raw).slice(0, 4000)

  return [
    "Your previous response attempted a tool call, but it was invalid.",
    `Problem: ${issue.detail}`,
    issue.toolName ? `Tool: ${issue.toolName}` : undefined,
    issue.toolCallId ? `Tool call id: ${issue.toolCallId}` : undefined,
    matchedTool ? `Expected JSON Schema: ${JSON.stringify(matchedTool.inputSchema ?? {})}` : undefined,
    functionTools.length > 0
      ? `Allowed tool names: ${functionTools.map((tool) => tool.name).join(", ")}`
      : "No tools are currently available.",
    "Previous assistant response:",
    rawResponse || "(empty response)",
    "Re-emit exactly one corrected <tool_calls>...</tool_calls> block with one valid JSON object body.",
    "Do not include explanation, Markdown, or extra text.",
  ].filter((line): line is string => Boolean(line)).join("\n")
}

function appendRepairTurn(
  history: ReturnType<typeof buildLocalRuntimeHistory>,
  responseText: string,
  issue: LocalToolRepairIssue,
  tools: LanguageModelV3CallOptions["tools"],
) {
  const rawResponse = responseText.trim() || issue.raw || "(empty response)"
  return [
    ...history,
    { type: "model" as const, response: [rawResponse] },
    { type: "user" as const, text: buildToolRepairMessage(rawResponse, issue, tools) },
  ]
}

export type LocalLanguageModelConfig = {
  runtime: LocalRuntimeClient
  disableThinking: boolean
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

export class LocalLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly modelId: string
  readonly provider = "local"
  readonly supportsStructuredOutputs = false

  constructor(modelId: string, private readonly config: LocalLanguageModelConfig) {
    this.modelId = modelId
  }

  get supportedUrls() {
    return {}
  }

  async doGenerate(options: LanguageModelV3CallOptions) {
    let history = buildLocalRuntimeHistory(options.prompt, {
      tools: options.tools,
      disableThinking: this.config.disableThinking,
    })
    const lastUser = [...history].reverse().find((item) => item.type === "user") as { text?: string } | undefined
    log.info("doGenerate request", {
      historyItems: history.length,
      lastUserChars: lastUser?.text?.length ?? 0,
      toolCount: options.tools?.length ?? 0,
      disableThinking: this.config.disableThinking,
      sampling: this.config.samplingParams,
      inferenceTimeout: this.config.inferenceTimeout,
      inferenceRetries: this.config.inferenceRetries,
    })

    const startedAt = Date.now()
    let repairAttempts = 0

    while (true) {
      const result = await this.config.runtime.generate({ history }, options.abortSignal)
      const content: LanguageModelV3Content[] = []
      const parser = new LocalToolCallTextParser()
      let thoughtChars = 0
      let textChars = 0

      for (const part of result.parts) {
        if (part.type === "reasoning" && part.text) {
          thoughtChars += part.text.length
          content.push({ type: "reasoning", text: part.text })
          continue
        }

        if (part.type === "text" && part.text) {
          const visibleText = parser.append(part.text)
          if (!visibleText) continue
          textChars += visibleText.length
          content.push({ type: "text", text: visibleText })
        }
      }

      const finalText = parser.finish()
      if (finalText.text) {
        textChars += finalText.text.length
        content.push({ type: "text", text: finalText.text })
      }

      const repairIssue = getToolRepairIssue(finalText.toolCalls, finalText.issues, options.tools)
      if (repairIssue && repairAttempts < MAX_TOOL_REPAIR_ATTEMPTS) {
        repairAttempts += 1
        log.warn("repairing invalid local tool call", {
          attempt: repairAttempts,
          code: repairIssue.code,
          toolName: repairIssue.toolName,
          detail: repairIssue.detail,
        })
        history = appendRepairTurn(history, result.responseText, repairIssue, options.tools)
        continue
      }

      if (!repairIssue) {
        for (const call of finalText.toolCalls) {
          content.push({
            type: "tool-call",
            toolCallId: call.toolCallId ?? `call_${generateId()}`,
            toolName: call.toolName,
            input: call.input,
          })
        }
      }

      const hasToolCalls = !repairIssue && finalText.toolCalls.length > 0

      log.info("doGenerate response", {
        stopReason: result.stopReason,
        durationMs: Date.now() - startedAt,
        thoughtChars,
        textChars,
        responseChars: result.responseText.length,
        repairAttempts,
        toolRepairIssue: repairIssue?.code,
        toolCalls: finalText.toolCalls.map((call) => call.toolName),
      })

      if (content.length === 0) {
        content.push({
          type: "text",
          text: finalText.text || (repairIssue ? "" : result.responseText) || "(empty response)",
        })
      }

      return {
        content,
        finishReason: {
          unified: hasToolCalls ? ("tool-calls" as const) : ("stop" as const),
          raw: hasToolCalls ? "tool_calls" : result.stopReason,
        },
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        request: { body: "" },
        response: {
          id: generateId(),
          modelId: this.modelId,
          headers: {},
          body: result.responseText,
        },
        warnings: [],
      }
    }
  }

  async doStream(options: LanguageModelV3CallOptions) {
    let history = buildLocalRuntimeHistory(options.prompt, {
      tools: options.tools,
      disableThinking: this.config.disableThinking,
    })
    const lastUser = [...history].reverse().find((item) => item.type === "user") as { text?: string } | undefined
    log.info("doStream request", {
      historyItems: history.length,
      lastUserChars: lastUser?.text?.length ?? 0,
      toolCount: options.tools?.length ?? 0,
      disableThinking: this.config.disableThinking,
      sampling: this.config.samplingParams,
    })

    const runtime = this.config.runtime
    const outputStream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })

        const startedAt = Date.now()
        let thoughtChars = 0
        let textChars = 0
        let chunkCount = 0
        let repairAttempts = 0
        let activeReasoningId: string | undefined
        let activeTextId: string | undefined

        try {
          while (true) {
            activeReasoningId = undefined
            activeTextId = undefined
            let rawStopReason = "unknown"
            let responseText = ""
            const parser = new LocalToolCallTextParser()

            const emitText = (delta: string) => {
              if (!delta) return
              if (activeReasoningId) {
                controller.enqueue({ type: "reasoning-end", id: activeReasoningId })
                activeReasoningId = undefined
              }
              if (!activeTextId) {
                activeTextId = generateId()
                controller.enqueue({ type: "text-start", id: activeTextId })
              }
              textChars += delta.length
              controller.enqueue({ type: "text-delta", id: activeTextId, delta })
            }

            const runtimeStream = await runtime.stream({ history }, options.abortSignal)
            const reader = runtimeStream.getReader()

            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              if (value.type === "reasoning-start") {
                chunkCount++
                if (activeTextId) {
                  controller.enqueue({ type: "text-end", id: activeTextId })
                  activeTextId = undefined
                }
                if (!activeReasoningId) {
                  activeReasoningId = generateId()
                  controller.enqueue({ type: "reasoning-start", id: activeReasoningId })
                }
                continue
              }

              if (value.type === "reasoning-delta") {
                chunkCount++
                thoughtChars += value.text.length
                if (!activeReasoningId) {
                  activeReasoningId = generateId()
                  controller.enqueue({ type: "reasoning-start", id: activeReasoningId })
                }
                controller.enqueue({ type: "reasoning-delta", id: activeReasoningId, delta: value.text })
                continue
              }

              if (value.type === "reasoning-end") {
                chunkCount++
                if (activeReasoningId) {
                  controller.enqueue({ type: "reasoning-end", id: activeReasoningId })
                  activeReasoningId = undefined
                }
                continue
              }

              if (value.type === "text") {
                chunkCount++
                const safeText = parser.append(value.text)
                emitText(safeText)
                continue
              }

              rawStopReason = value.result.stopReason
              responseText = value.result.responseText
            }

            if (activeReasoningId) {
              controller.enqueue({ type: "reasoning-end", id: activeReasoningId })
              activeReasoningId = undefined
            }

            const finalText = parser.finish()
            emitText(finalText.text)

            const repairIssue = getToolRepairIssue(finalText.toolCalls, finalText.issues, options.tools)
            if (repairIssue && repairAttempts < MAX_TOOL_REPAIR_ATTEMPTS) {
              if (activeTextId) {
                controller.enqueue({ type: "text-end", id: activeTextId })
                activeTextId = undefined
              }
              repairAttempts += 1
              log.warn("repairing invalid local tool call in stream", {
                attempt: repairAttempts,
                code: repairIssue.code,
                toolName: repairIssue.toolName,
                detail: repairIssue.detail,
              })
              history = appendRepairTurn(history, responseText, repairIssue, options.tools)
              continue
            }

            const hasToolCalls = !repairIssue && finalText.toolCalls.length > 0
            if (activeTextId) {
              controller.enqueue({ type: "text-end", id: activeTextId })
              activeTextId = undefined
            }

            if (hasToolCalls) {
              for (const call of finalText.toolCalls) {
                const callId = call.toolCallId ?? `call_${generateId()}`
                controller.enqueue({ type: "tool-input-start", id: callId, toolName: call.toolName })
                controller.enqueue({ type: "tool-input-delta", id: callId, delta: call.input })
                controller.enqueue({ type: "tool-input-end", id: callId })
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: callId,
                  toolName: call.toolName,
                  input: call.input,
                })
              }
            }

            log.info("doStream response", {
              stopReason: rawStopReason,
              durationMs: Date.now() - startedAt,
              chunkCount,
              thoughtChars,
              textChars,
              responseChars: responseText.length,
              repairAttempts,
              toolRepairIssue: repairIssue?.code,
              toolCalls: finalText.toolCalls.map((call) => call.toolName),
            })

            controller.enqueue({
              type: "finish",
              finishReason: {
                unified: hasToolCalls ? "tool-calls" : "stop",
                raw: hasToolCalls ? "tool_calls" : rawStopReason,
              },
              usage: {
                inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: undefined, text: undefined, reasoning: undefined },
              },
              providerMetadata: {},
            })
            controller.close()
            return
          }
        } catch (error) {
          log.error("doStream inference error", {
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
            thoughtChars,
            textChars,
            chunkCount,
          })
          if (activeReasoningId) controller.enqueue({ type: "reasoning-end", id: activeReasoningId })
          if (activeTextId) controller.enqueue({ type: "text-end", id: activeTextId })
          controller.enqueue({
            type: "error",
            error: error instanceof Error ? error : new Error(String(error)),
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
