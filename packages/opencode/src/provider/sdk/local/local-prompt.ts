import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { jsonrepair } from "jsonrepair"

export type LocalRuntimeHistoryItem =
  | { type: "system" | "user"; text: string }
  | { type: "model"; response: string[] }

export type LocalParsedToolCall = {
  toolName: string
  toolCallId?: string
  input: string
}

export type LocalToolCallParseIssue = {
  code: "invalid_json" | "invalid_input_shape" | "invalid_tool_call" | "missing_tool_name"
  detail: string
  raw: string
  toolName?: string
  toolCallId?: string
}

type ParsedJsonObject =
  | { ok: true; value: Record<string, unknown> }
  | {
      ok: false
      code: "invalid_json" | "invalid_input_shape"
      error: string
    }

type LocalToolCallAttempt =
  | { call: LocalParsedToolCall; issue?: undefined }
  | { issue: LocalToolCallParseIssue; call?: undefined }

const TOOL_OPENERS = ["<tool_calls", "<tool_call"]
const TOOL_LOOKBEHIND = 32
const TOOL_BLOCK_RE = /<tool_calls\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/tool_calls>/g
const TOOL_CALL_RE = /<tool_call\b((?:[^>"']|"[^"]*"|'[^']*')*)(?:>|}\s*(?=<\/tool_call>)|(?=\s*<\/tool_call>))([\s\S]*?)<\/tool_call>/g
const TRAILING_TOOL_CALL_RE = /^<tool_call\b((?:[^>"']|"[^"]*"|'[^']*')*)(?:>|}\s*)([\s\S]*)$/
const TOOL_ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const TOOL_FIELD_RE = /<([A-Za-z_][\w:.-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/\1>/g
const CDATA_FIELD_RE = /<([A-Za-z_][\w:.-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/\1>/g

function escapeXmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function decodeXmlAttribute(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
}

function decodeXmlText(value: string) {
  return decodeXmlAttribute(value)
}

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}) ?? "{}"
  } catch {
    return "{}"
  }
}

function stringifyToolInput(input: unknown) {
  if (typeof input !== "string") return stringifyJson(input)
  const text = input.trim()
  if (!text) return "{}"

  const parsed = parseJsonObject(text)
  if (parsed.ok) return stringifyJson(parsed.value)
  return text
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJsonObject(text: string): ParsedJsonObject {
  const input = text.trim()
  if (!input) return { ok: true, value: {} }

  try {
    const parsed = JSON.parse(input)
    if (!isObjectRecord(parsed)) {
      return {
        ok: false,
        error: "Tool call JSON must decode to one object.",
        code: "invalid_input_shape",
      }
    }
    return { ok: true, value: parsed }
  } catch {
    try {
      const repairedText = jsonrepair(input)
      const parsed = JSON.parse(repairedText)
      if (!isObjectRecord(parsed)) {
        return {
          ok: false,
          error: "Tool call JSON must decode to one object.",
          code: "invalid_input_shape",
        }
      }
      return { ok: true, value: parsed }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: "invalid_json",
      }
    }
  }
}

export function extractToolResultText(result: unknown): string {
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

function serializeToolCall(toolName: string, input: unknown, toolCallId?: string) {
  const attrs = [`name="${escapeXmlAttribute(toolName)}"`]
  if (toolCallId) attrs.push(`call_id="${escapeXmlAttribute(toolCallId)}"`)
  return `<tool_call ${attrs.join(" ")}>${stringifyToolInput(input)}</tool_call>`
}

function serializeToolCalls(parts: Array<{ toolName: string; input: unknown; toolCallId?: string }>) {
  if (parts.length === 0) return ""
  return ["<tool_calls>", ...parts.map((part) => serializeToolCall(part.toolName, part.input, part.toolCallId)), "</tool_calls>"].join("\n")
}

function serializeToolResults(parts: Array<{ toolName: string; toolCallId?: string; output: unknown }>) {
  if (parts.length === 0) return ""
  return [
    "<tool_results>",
    ...parts.map((part) => {
      const attrs = [`name="${escapeXmlAttribute(part.toolName)}"`]
      if (part.toolCallId) attrs.push(`call_id="${escapeXmlAttribute(part.toolCallId)}"`)
      return `<tool_result ${attrs.join(" ")}>${stringifyJson({ output: extractToolResultText(part.output) })}</tool_result>`
    }),
    "</tool_results>",
  ].join("\n")
}

const LARGE_FIELD_RE = /content|text|body|code|patch|diff|data|prompt|message|source|script/i

// Finds a concrete (tool, field) pair where the field is a large free-text
// string argument, used to show the model one real CDATA example. Returns the
// first match so the example stays specific to the tools actually available.
function findLargeStringFieldExample(tools: Array<{ name: string; inputSchema?: unknown }>) {
  for (const tool of tools) {
    const schema = tool.inputSchema as
      | { properties?: Record<string, { type?: unknown }>; required?: unknown }
      | undefined
    const properties = schema?.properties
    if (!properties) continue

    const largeField = Object.keys(properties).find(
      (name) => properties[name]?.type === "string" && LARGE_FIELD_RE.test(name),
    )
    if (!largeField) continue

    const required = Array.isArray(schema?.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : []
    const siblingArg = required.find(
      (name) => name !== largeField && properties[name]?.type === "string",
    )
    return { tool: tool.name, field: largeField, siblingArg }
  }
  return undefined
}

function buildToolInstructions(
  tools: LanguageModelV3CallOptions["tools"],
  disableThinking: boolean,
) {
  const lines: string[] = []
  if (disableThinking) {
    lines.push("Do not output <think>...</think>. Answer directly with your final response.")
  }

  const functionTools = (tools ?? []).filter((tool) => tool.type === "function")
  if (functionTools.length === 0) return lines.join("\n")

  lines.push(
    "You can call tools. To call a tool, output only this block and nothing else:",
    "<tool_calls>",
    "<tool_call name=\"tool_name\">{\"arg\": \"value\"}</tool_call>",
    "</tool_calls>",
    "Tool call rules:",
    "- The body of each <tool_call> is one JSON object with that tool's arguments.",
    "- Use only the tool names listed below.",
    "- Include every required argument from the tool's JSON Schema.",
    "- When calling a tool, output nothing before or after the <tool_calls> block.",
    "- If you are not calling a tool, just answer normally.",
  )

  const largeExample = findLargeStringFieldExample(functionTools)
  if (largeExample) {
    const siblingJson = largeExample.siblingArg ? `{"${largeExample.siblingArg}": "..."}` : "{}"
    lines.push(
      "- For a long or multi-line string argument, keep the other arguments in the JSON object and put that one value in a CDATA field right after it, so you do not have to escape anything. Example:",
      `<tool_call name="${escapeXmlAttribute(largeExample.tool)}">${siblingJson}<${largeExample.field}><![CDATA[`,
      "...your raw multi-line text here, no escaping needed...",
      `]]></${largeExample.field}></tool_call>`,
    )
  }

  lines.push(
    "<available_tools>",
    ...functionTools.flatMap((tool) => [
      `<tool name="${escapeXmlAttribute(tool.name)}">`,
      `Description: ${tool.description ?? ""}`,
      `JSON Schema: ${stringifyJson(tool.inputSchema ?? {})}`,
      "</tool>",
    ]),
    "</available_tools>",
  )

  return lines.join("\n")
}

export function buildLocalRuntimeHistory(
  prompt: LanguageModelV3CallOptions["prompt"],
  options: {
    tools: LanguageModelV3CallOptions["tools"]
    disableThinking: boolean
  },
) {
  const history: LocalRuntimeHistoryItem[] = []
  const controlPrompt = buildToolInstructions(options.tools, options.disableThinking)
  let injectedControlPrompt = false

  const injectControlPrompt = (text: string) => {
    if (!controlPrompt || injectedControlPrompt) return text
    injectedControlPrompt = true
    return text.trim() ? `${text}\n\n${controlPrompt}` : controlPrompt
  }

  for (const msg of prompt) {
    if (msg.role === "system") {
      history.push({ type: "system", text: injectControlPrompt(msg.content) })
      continue
    }

    if (msg.role === "user") {
      const text = msg.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")

      if (text) history.push({ type: "user", text })
      continue
    }

    if (msg.role === "assistant") {
      const text = msg.content
        .flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text] : []))
        .join("\n")
      const toolCalls = msg.content
        .filter((part) => part.type === "tool-call")
        .map((part) => ({ toolName: part.toolName, input: part.input, toolCallId: part.toolCallId }))
      const payload = [text, serializeToolCalls(toolCalls)].filter(Boolean).join("\n\n")

      if (payload) history.push({ type: "model", response: [payload] })
      continue
    }

    if (msg.role === "tool") {
      const payload = serializeToolResults(
        msg.content
          .filter((part) => part.type === "tool-result")
          .map((part) => ({
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            output: part.output,
          })),
      )

      if (payload) history.push({ type: "user", text: payload })
    }
  }

  if (!injectedControlPrompt && controlPrompt) {
    history.unshift({ type: "system", text: controlPrompt })
  }

  const lastItem = history[history.length - 1]
  if (!lastItem || lastItem.type !== "user") {
    history.push({ type: "user", text: "Continue." })
  }

  return history
}

function parseAttributeValue(value: string) {
  const text = decodeXmlAttribute(value).trim()
  if (!text) return ""

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function parseToolCallAttributes(attributes: string) {
  const result: Record<string, unknown> = {}
  for (const match of attributes.matchAll(TOOL_ATTR_RE)) {
    const name = match[1]
    const value = match[2] ?? match[3] ?? ""
    result[name] = parseAttributeValue(value)
  }
  return result
}

function parseXmlFieldValue(value: string) {
  const trimmed = value.trim()
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(trimmed)
  if (cdata) return cdata[1]
  return decodeXmlText(value).trim()
}

function parseXmlFieldObject(body: string) {
  const input = body.trim()
  if (!input.startsWith("<")) return undefined

  const result: Record<string, string> = {}
  let cursor = 0
  let found = false
  for (const match of input.matchAll(TOOL_FIELD_RE)) {
    if (match.index === undefined) return undefined
    if (input.slice(cursor, match.index).trim()) return undefined
    result[match[1]] = parseXmlFieldValue(match[2] ?? "")
    cursor = match.index + match[0].length
    found = true
  }

  if (!found || input.slice(cursor).trim()) return undefined
  return result
}

// Mixed form: small scalar arguments stay as a JSON object while large or
// multi-line string arguments are carried in sibling CDATA fields to avoid
// JSON escaping. Only fields whose value is a CDATA section are pulled out, so
// ordinary JSON (even JSON that happens to contain angle brackets) is left
// untouched. Returns undefined when there is no CDATA field to merge.
function parseMixedJsonCdata(body: string) {
  const fields: Record<string, string> = {}
  let leftover = ""
  let cursor = 0
  let found = false
  for (const match of body.matchAll(CDATA_FIELD_RE)) {
    if (match.index === undefined) continue
    leftover += body.slice(cursor, match.index)
    fields[match[1]] = match[2] ?? ""
    cursor = match.index + match[0].length
    found = true
  }
  if (!found) return undefined
  leftover += body.slice(cursor)

  const rest = leftover.trim()
  if (!rest) return fields

  const parsed = parseJsonObject(rest)
  if (!parsed.ok) return undefined
  return { ...parsed.value, ...fields }
}

function parseSingleToolCall(attributes: string, body: string, raw: string): LocalToolCallAttempt {
  const attrs = parseToolCallAttributes(attributes)
  const toolName = typeof attrs.name === "string" ? attrs.name : undefined
  if (!toolName) {
    return {
      issue: {
        code: "missing_tool_name",
        detail: "Tool call is missing the required name attribute.",
        raw,
      } satisfies LocalToolCallParseIssue,
    }
  }

  const toolCallId = typeof attrs.call_id === "string" ? attrs.call_id : undefined
  delete attrs.name
  delete attrs.call_id

  const inputText = body.trim()
  const attributeInput = attrs

  let input: unknown = attributeInput
  if (inputText) {
    const xmlFieldInput = parseXmlFieldObject(inputText)
    if (xmlFieldInput) {
      input = { ...attributeInput, ...xmlFieldInput }
    }
    else {
      const mixedInput = parseMixedJsonCdata(inputText)
      if (mixedInput) {
        input = { ...attributeInput, ...mixedInput }
      }
      else {
        const parsed = parseJsonObject(inputText)
        if (!parsed.ok) {
          if (Object.keys(attributeInput).length > 0) {
            return {
              call: {
                toolName,
                toolCallId,
                input: stringifyJson(attributeInput),
              } satisfies LocalParsedToolCall,
            }
          }

          return {
            issue: {
              code: parsed.code,
              detail: parsed.error,
              raw,
              toolName,
              toolCallId,
            } satisfies LocalToolCallParseIssue,
          }
        }
        input = { ...attributeInput, ...parsed.value }
      }
    }
  }

  return {
    call: {
      toolName,
      toolCallId,
      input: stringifyJson(input),
    } satisfies LocalParsedToolCall,
  }
}

function parseTrailingToolCall(fragment: string): LocalToolCallAttempt {
  const match = TRAILING_TOOL_CALL_RE.exec(fragment.trim())
  if (!match) {
    return {
      issue: {
        code: "invalid_tool_call",
        detail: "Tool call XML could not be parsed.",
        raw: fragment.trim(),
      } satisfies LocalToolCallParseIssue,
    }
  }

  return parseSingleToolCall(match[1] ?? "", match[2] ?? "", match[0])
}

function parseToolCallFragment(fragment: string) {
  const calls: LocalParsedToolCall[] = []
  const issues: LocalToolCallParseIssue[] = []
  let found = false

  for (const match of fragment.matchAll(TOOL_CALL_RE)) {
    found = true
    const parsed = parseSingleToolCall(match[1] ?? "", match[2] ?? "", match[0])
    if (parsed.issue !== undefined) issues.push(parsed.issue)
    if (parsed.call !== undefined) calls.push(parsed.call)
  }

  const remaining = fragment.replaceAll(TOOL_CALL_RE, "").trim()
  // A leftover that still opens a <tool_call ...> is an unclosed call we can try
  // to recover. Plain prose, commas, or the surrounding <tool_calls> wrapper
  // sitting between two valid calls is NOT a tool call and must never raise an
  // issue, otherwise the repair loop throws away the sibling calls that parsed
  // correctly.
  const opener = /<tool_call\b/.exec(remaining)
  if (opener) {
    const trailing = parseTrailingToolCall(remaining.slice(opener.index))
    if (trailing.issue !== undefined) issues.push(trailing.issue)
    if (trailing.call !== undefined) calls.push(trailing.call)
  }

  if (!found && calls.length === 0 && issues.length === 0) {
    if (remaining && opener) {
      issues.push({
        code: "invalid_tool_call",
        detail: "Tool call XML could not be parsed.",
        raw: remaining,
      })
    }
    if (!remaining || !opener) {
      return {
        found: false,
        toolCalls: calls,
        issues,
      }
    }
  }

  return {
    found: found || calls.length > 0,
    toolCalls: calls,
    issues,
  }
}

export function parseLocalToolCalls(text: string) {
  const blocks = [...text.matchAll(TOOL_BLOCK_RE)]
  if (blocks.length > 0) {
    const parsedBlocks: Array<{
      start: number
      end: number
      calls: LocalParsedToolCall[]
      issues: LocalToolCallParseIssue[]
    }> = []
    for (const block of blocks) {
      const calls = parseToolCallFragment(block[1] ?? "")
      if (block.index === undefined) return { text, toolCalls: [], issues: [] as LocalToolCallParseIssue[] }
      parsedBlocks.push({
        start: block.index,
        end: block.index + block[0].length,
        calls: calls.toolCalls,
        issues: calls.issues,
      })
    }

    let cursor = 0
    let visibleText = ""
    const toolCalls: LocalParsedToolCall[] = []
    const issues: LocalToolCallParseIssue[] = []
    for (const block of parsedBlocks) {
      visibleText += text.slice(cursor, block.start)
      cursor = block.end
      toolCalls.push(...block.calls)
      issues.push(...block.issues)
    }
    visibleText += text.slice(cursor)

    return { text: visibleText, toolCalls, issues }
  }

  const toolStart = findToolStart(text)
  if (toolStart !== undefined) {
    const directCalls = parseToolCallFragment(text.slice(toolStart))
    if (directCalls.found || directCalls.issues.length > 0) {
      return {
        text: text.slice(0, toolStart),
        toolCalls: directCalls.toolCalls,
        issues: directCalls.issues,
      }
    }
  }

  return { text, toolCalls: [], issues: [] as LocalToolCallParseIssue[] }
}

function findToolStart(text: string) {
  const indices = TOOL_OPENERS
    .map((opener) => text.indexOf(opener))
    .filter((index) => index >= 0)
  if (indices.length === 0) return undefined
  return Math.min(...indices)
}

export class LocalToolCallTextParser {
  private readonly chunks: string[] = []
  private emittedChars = 0
  private sawPotentialToolBlock = false

  append(delta: string) {
    if (!delta) return ""
    this.chunks.push(delta)
    const fullText = this.chunks.join("")

    if (this.sawPotentialToolBlock) return ""

    const toolStart = findToolStart(fullText)
    if (toolStart !== undefined) {
      this.sawPotentialToolBlock = true
      const safeText = fullText.slice(this.emittedChars, toolStart)
      this.emittedChars = toolStart
      return safeText
    }

    const flushEnd = Math.max(this.emittedChars, fullText.length - TOOL_LOOKBEHIND)
    if (flushEnd <= this.emittedChars) return ""

    const safeText = fullText.slice(this.emittedChars, flushEnd)
    this.emittedChars = flushEnd
    return safeText
  }

  finish() {
    const fullText = this.chunks.join("")
    const parsed = parseLocalToolCalls(fullText)
    if (parsed.toolCalls.length === 0 && parsed.issues.length === 0) {
      return {
        text: fullText.slice(this.emittedChars),
        toolCalls: [] as LocalParsedToolCall[],
        issues: [] as LocalToolCallParseIssue[],
      }
    }

    const remainingText = parsed.text.slice(this.emittedChars)
    this.emittedChars = parsed.text.length
    return {
      text: remainingText,
      toolCalls: parsed.toolCalls,
      issues: parsed.issues,
    }
  }
}
