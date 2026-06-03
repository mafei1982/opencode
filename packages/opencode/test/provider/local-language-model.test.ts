import { describe, expect, test } from "bun:test"
import { LocalLanguageModel } from "../../src/provider/sdk/local/local-language-model"
import { buildLocalRuntimeHistory, parseLocalToolCalls } from "../../src/provider/sdk/local/local-prompt"
import type { LocalRuntimeClient } from "../../src/provider/sdk/local/local-runtime"
import type { LocalRuntimeResult, LocalRuntimeStreamMessage } from "../../src/provider/sdk/local/local-runtime-protocol"

async function convertReadableStreamToArray<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader()
  const result: T[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result.push(value)
  }
  return result
}

const TEST_TOOLS = [
  {
    type: "function",
    name: "read_file",
    description: "Read a file from disk",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
      },
      required: ["filePath"],
    },
  },
] as const

const LARGE_PAYLOAD_TOOLS = [
  {
    type: "function",
    name: "write",
    description: "Write a file to disk",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        content: { type: "string" },
      },
      required: ["filePath", "content"],
    },
  },
  {
    type: "function",
    name: "task",
    description: "Run a subagent task",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
        subagent_type: { type: "string" },
      },
      required: ["description", "prompt", "subagent_type"],
    },
  },
] as const

const DEFAULT_GENERATE_RESULT: LocalRuntimeResult = {
  responseText: `<tool_calls>\n<tool_call name="read_file" call_id="call_1">{"filePath":"/README.md"}</tool_call>\n</tool_calls>`,
  parts: [
    {
      type: "text",
      text: `<tool_calls>\n<tool_call name="read_file" call_id="call_1">{"filePath":"/README.md"}</tool_call>\n</tool_calls>`,
    },
  ],
  stopReason: "stop",
}

function createSequentialRuntime(options: {
  streamRuns?: LocalRuntimeStreamMessage[][]
  generateResults?: LocalRuntimeResult[]
  onGenerate?: (history: unknown[]) => void
  onStream?: (history: unknown[]) => void
}): LocalRuntimeClient {
  let generateIndex = 0
  let streamIndex = 0

  return {
    async init() {},
    async generate(input) {
      options.onGenerate?.(input.history as unknown[])
      const result = options.generateResults?.[generateIndex] ?? options.generateResults?.at(-1) ?? DEFAULT_GENERATE_RESULT
      generateIndex += 1
      return result
    },
    async stream(input) {
      options.onStream?.(input.history as unknown[])
      const messages = options.streamRuns?.[streamIndex] ?? options.streamRuns?.at(-1) ?? []
      streamIndex += 1
      return new ReadableStream<LocalRuntimeStreamMessage>({
        start(controller) {
          for (const message of messages) controller.enqueue(message)
          controller.close()
        },
      })
    },
    async dispose() {},
  }
}

function createRuntime(streamMessages: LocalRuntimeStreamMessage[], generateResult?: LocalRuntimeResult): LocalRuntimeClient {
  return createSequentialRuntime({
    streamRuns: [streamMessages],
    generateResults: generateResult ? [generateResult] : undefined,
  })
}

describe("local prompt serialization", () => {
  test("injects tool instructions and serializes prior tool transcript", () => {
    const history = buildLocalRuntimeHistory(
      [
        { role: "system", content: "You are helpful." },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "read_file",
              input: { filePath: "/README.md" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "read_file",
              output: { type: "text", value: "README" },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Summarize it" }] },
      ] as any,
      { tools: TEST_TOOLS as any, disableThinking: false },
    )

    expect(history[0]).toMatchObject({ type: "system" })
    expect((history[0] as { text: string }).text).toContain("<available_tools>")
    expect((history[0] as { text: string }).text).toContain("The body of each <tool_call> is one JSON object")
    expect((history[0] as { text: string }).text).not.toContain("CDATA")
    expect((history[0] as { text: string }).text).not.toContain("XML child elements")
    expect((history[0] as { text: string }).text).toContain("read_file")
    expect(history[1]).toMatchObject({ type: "model" })
    expect((history[1] as { response: string[] }).response[0]).toContain("<tool_calls>")
    expect(history[2]).toMatchObject({ type: "user" })
    expect((history[2] as { text: string }).text).toContain("<tool_results>")
  })

  test("offers a CDATA field for large string args when write and task tools are present", () => {
    const history = buildLocalRuntimeHistory(
      [{ role: "user", content: [{ type: "text", text: "Write the DSL artifact" }] }] as any,
      { tools: LARGE_PAYLOAD_TOOLS as any, disableThinking: false },
    )

    const text = (history[0] as { text: string }).text
    expect(text).toContain("The body of each <tool_call> is one JSON object")
    expect(text).toContain("CDATA")
    expect(text).toContain('<content><![CDATA[')
    expect(text).toContain('<tool name="write">')
    expect(text).toContain('<tool name="task">')
  })

  test("extracts xml tool calls without leaking markup into visible text", () => {
    const parsed = parseLocalToolCalls(
      `Checking that now.\n<tool_calls>\n<tool_call name="read_file" call_id="call_1">{"filePath":"/README.md"}</tool_call>\n</tool_calls>`,
    )

    expect(parsed.text).toBe("Checking that now.\n")
    expect(parsed.toolCalls).toEqual([
      {
        toolName: "read_file",
        toolCallId: "call_1",
        input: JSON.stringify({ filePath: "/README.md" }),
      },
    ])
  })

  test("extracts tool calls encoded as attributes even with a malformed opener", () => {
    const parsed = parseLocalToolCalls(
      `<tool_calls>\n<tool_call name="task" call_id="call_1" description="Catalog selector for P3Y BI test" prompt="Select the matching operations" subagent_type="catalog-selector"}\n</tool_call>\n</tool_calls>`,
    )

    expect(parsed.text).toBe("")
    expect(parsed.toolCalls).toEqual([
      {
        toolName: "task",
        toolCallId: "call_1",
        input: JSON.stringify({
          description: "Catalog selector for P3Y BI test",
          prompt: "Select the matching operations",
          subagent_type: "catalog-selector",
        }),
      },
    ])
  })

  test("extracts a trailing tool call without an explicit closing tool_call tag", () => {
    const parsed = parseLocalToolCalls(
      `<tool_calls>\n<tool_call name="bash" call_id="call_1">{"command":"Write-Output hi","description":"Run a command","timeout":120000}\n</tool_calls>`,
    )

    expect(parsed.text).toBe("")
    expect(parsed.toolCalls).toEqual([
      {
        toolName: "bash",
        toolCallId: "call_1",
        input: JSON.stringify({
          command: "Write-Output hi",
          description: "Run a command",
          timeout: 120000,
        }),
      },
    ])
  })

  test("repairs malformed tool call json before parsing it", () => {
    const parsed = parseLocalToolCalls(
      `<tool_calls>\n<tool_call name="read_file" call_id="call_1">{filePath:'/README.md',}</tool_call>\n</tool_calls>`,
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.toolCalls).toEqual([
      {
        toolName: "read_file",
        toolCallId: "call_1",
        input: JSON.stringify({ filePath: "/README.md" }),
      },
    ])
  })

  test("extracts write calls that move large text into XML CDATA blocks", () => {
    const content = '{\n  "workflow": [\n    "write",\n    "task"\n  ]\n}'
    const parsed = parseLocalToolCalls(
      `<tool_calls>\n<tool_call name="write" call_id="call_1" filePath="/tmp/teststand.json"><content><![CDATA[${content}]]></content></tool_call>\n</tool_calls>`,
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.toolCalls).toEqual([
      {
        toolName: "write",
        toolCallId: "call_1",
        input: JSON.stringify({
          filePath: "/tmp/teststand.json",
          content,
        }),
      },
    ])
  })

  test("extracts task calls that move large prompts into XML CDATA blocks", () => {
    const prompt = "Create multiple structured JSON artifacts and hand off to a subagent."
    const parsed = parseLocalToolCalls(
      `<tool_calls>\n<tool_call name="task" call_id="call_1" description="Build DSL" subagent_type="Explore"><prompt><![CDATA[${prompt}]]></prompt></tool_call>\n</tool_calls>`,
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.toolCalls).toEqual([
      {
        toolName: "task",
        toolCallId: "call_1",
        input: JSON.stringify({
          description: "Build DSL",
          subagent_type: "Explore",
          prompt,
        }),
      },
    ])
  })

  test("extracts mixed calls that keep scalars in JSON and large text in a CDATA field", () => {
    const content = '{\n  "name": "P3Y",\n  "steps": ["a", "b"]\n}'
    const parsed = parseLocalToolCalls(
      `<tool_calls>\n<tool_call name="write" call_id="call_1">{"filePath": "/tmp/teststand.json"}<content><![CDATA[${content}]]></content></tool_call>\n</tool_calls>`,
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.toolCalls).toEqual([
      {
        toolName: "write",
        toolCallId: "call_1",
        input: JSON.stringify({
          filePath: "/tmp/teststand.json",
          content,
        }),
      },
    ])
  })

  test("extracts two tool calls separated by prose without raising a parse issue", () => {
    const parsed = parseLocalToolCalls(
      `<tool_calls>\n<tool_call name="read_file">{"filePath":"a.txt"}</tool_call>\nNow let me read the other file:\n<tool_call name="read_file">{"filePath":"b.txt"}</tool_call>\n</tool_calls>`,
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.toolCalls).toEqual([
      { toolName: "read_file", input: JSON.stringify({ filePath: "a.txt" }) },
      { toolName: "read_file", input: JSON.stringify({ filePath: "b.txt" }) },
    ])
  })

  test("extracts two tool calls when the tool_calls wrapper is left unclosed", () => {
    const parsed = parseLocalToolCalls(
      `<tool_calls>\n<tool_call name="read_file">{"filePath":"a.txt"}</tool_call>\n<tool_call name="read_file">{"filePath":"b.txt"}</tool_call>`,
    )

    expect(parsed.issues).toEqual([])
    expect(parsed.toolCalls).toEqual([
      { toolName: "read_file", input: JSON.stringify({ filePath: "a.txt" }) },
      { toolName: "read_file", input: JSON.stringify({ filePath: "b.txt" }) },
    ])
  })
})

describe("local language model", () => {
  test("repairs missing required tool args in doGenerate before returning a tool call", async () => {
    const histories: unknown[][] = []
    const runtime = createSequentialRuntime({
      generateResults: [
        {
          responseText: `<tool_calls>\n<tool_call name="read_file" call_id="call_1">{}</tool_call>\n</tool_calls>`,
          parts: [
            {
              type: "text",
              text: `<tool_calls>\n<tool_call name="read_file" call_id="call_1">{}</tool_call>\n</tool_calls>`,
            },
          ],
          stopReason: "stop",
        },
        DEFAULT_GENERATE_RESULT,
      ],
      onGenerate: (history) => histories.push(history),
      streamRuns: [[]],
    })
    const model = new LocalLanguageModel("default", {
      runtime,
      disableThinking: false,
      samplingParams: {},
      inferenceTimeout: 120,
      inferenceRetries: 3,
    })

    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Read the README" }] }],
      tools: TEST_TOOLS as any,
    } as any)

    expect(histories).toHaveLength(2)
    expect((histories[1].at(-1) as { text: string }).text).toContain("filePath")
    expect(result.content).toContainEqual({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "read_file",
      input: JSON.stringify({ filePath: "/README.md" }),
    })
  })

  test("converts streamed xml tool calls into AI SDK tool events", async () => {
    const runtime = createRuntime([
      { type: "reasoning-start" },
      { type: "reasoning-delta", text: "Need the README first." },
      { type: "reasoning-end" },
      { type: "text", text: "<tool_" },
      {
        type: "text",
        text: 'calls>\n<tool_call name="read_file" call_id="call_1">{"filePath":"/README.md"}</tool_call>\n</tool_calls>',
      },
      {
        type: "result",
        result: {
          responseText: `<tool_calls>\n<tool_call name="read_file" call_id="call_1">{"filePath":"/README.md"}</tool_call>\n</tool_calls>`,
          parts: [],
          stopReason: "stop",
        },
      },
    ])
    const model = new LocalLanguageModel("default", {
      runtime,
      disableThinking: false,
      samplingParams: {},
      inferenceTimeout: 120,
      inferenceRetries: 3,
    })

    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Read the README" }] }],
      tools: TEST_TOOLS as any,
    } as any)
    const parts = await convertReadableStreamToArray(stream)

    expect(parts.some((part) => part.type === "text-delta" && part.delta.includes("<tool"))).toBe(false)

    const reasoningEndIndex = parts.findIndex((part) => part.type === "reasoning-end")
    const toolStartIndex = parts.findIndex((part) => part.type === "tool-input-start")
    expect(reasoningEndIndex).toBeGreaterThanOrEqual(0)
    expect(toolStartIndex).toBeGreaterThan(reasoningEndIndex)

    expect(parts).toContainEqual({ type: "tool-input-start", id: "call_1", toolName: "read_file" })
    expect(parts).toContainEqual({ type: "tool-input-delta", id: "call_1", delta: JSON.stringify({ filePath: "/README.md" }) })
    expect(parts).toContainEqual({ type: "tool-input-end", id: "call_1" })
    expect(parts).toContainEqual({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "read_file",
      input: JSON.stringify({ filePath: "/README.md" }),
    })

    const finish = parts.find((part) => part.type === "finish")
    expect(finish).toMatchObject({
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    })
  })

  test("repairs streamed tool calls with missing required args before emitting tool events", async () => {
    const histories: unknown[][] = []
    const runtime = createSequentialRuntime({
      streamRuns: [
        [
          {
            type: "text",
            text: `<tool_calls>\n<tool_call name="read_file" call_id="call_1">{}</tool_call>\n</tool_calls>`,
          },
          {
            type: "result",
            result: {
              responseText: `<tool_calls>\n<tool_call name="read_file" call_id="call_1">{}</tool_call>\n</tool_calls>`,
              parts: [],
              stopReason: "stop",
            },
          },
        ],
        [
          {
            type: "text",
            text: `<tool_calls>\n<tool_call name="read_file" call_id="call_1">{"filePath":"/README.md"}</tool_call>\n</tool_calls>`,
          },
          {
            type: "result",
            result: DEFAULT_GENERATE_RESULT,
          },
        ],
      ],
      onStream: (history) => histories.push(history),
      generateResults: [DEFAULT_GENERATE_RESULT],
    })
    const model = new LocalLanguageModel("default", {
      runtime,
      disableThinking: false,
      samplingParams: {},
      inferenceTimeout: 120,
      inferenceRetries: 3,
    })

    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Read the README" }] }],
      tools: TEST_TOOLS as any,
    } as any)
    const parts = await convertReadableStreamToArray(stream)

    expect(histories).toHaveLength(2)
    expect((histories[1].at(-1) as { text: string }).text).toContain("filePath")
    expect(parts).toContainEqual({ type: "tool-input-start", id: "call_1", toolName: "read_file" })
    expect(parts).toContainEqual({ type: "tool-input-delta", id: "call_1", delta: JSON.stringify({ filePath: "/README.md" }) })
    expect(parts).toContainEqual({ type: "tool-input-end", id: "call_1" })
    expect(parts).toContainEqual({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "read_file",
      input: JSON.stringify({ filePath: "/README.md" }),
    })
  })

  test("converts streamed write calls that use XML CDATA blocks into AI SDK tool events", async () => {
    const content = '{\n  "workflow": [\n    "write",\n    "task"\n  ]\n}'
    const runtime = createRuntime([
      { type: "text", text: "<tool_calls>\n<tool_call name=\"write\" call_id=\"call_1\" filePath=\"/tmp/teststand.json\">" },
      { type: "text", text: `<content><![CDATA[${content}]]></content></tool_call>\n</tool_calls>` },
      {
        type: "result",
        result: {
          responseText: `<tool_calls>\n<tool_call name="write" call_id="call_1" filePath="/tmp/teststand.json"><content><![CDATA[${content}]]></content></tool_call>\n</tool_calls>`,
          parts: [],
          stopReason: "stop",
        },
      },
    ])
    const model = new LocalLanguageModel("default", {
      runtime,
      disableThinking: false,
      samplingParams: {},
      inferenceTimeout: 120,
      inferenceRetries: 3,
    })

    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Write the artifact" }] }],
      tools: LARGE_PAYLOAD_TOOLS as any,
    } as any)
    const parts = await convertReadableStreamToArray(stream)

    expect(parts).toContainEqual({ type: "tool-input-start", id: "call_1", toolName: "write" })
    expect(parts).toContainEqual({
      type: "tool-input-delta",
      id: "call_1",
      delta: JSON.stringify({ filePath: "/tmp/teststand.json", content }),
    })
    expect(parts).toContainEqual({ type: "tool-input-end", id: "call_1" })
    expect(parts).toContainEqual({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "write",
      input: JSON.stringify({ filePath: "/tmp/teststand.json", content }),
    })
  })
})