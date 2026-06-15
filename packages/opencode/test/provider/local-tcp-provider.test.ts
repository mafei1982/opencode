import { afterEach, beforeEach, expect, mock, test } from "bun:test"

type CapturedFetchInit = BunFetchRequestInit & { timeout?: boolean }

const fetchCalls: Array<{ input: string; init?: CapturedFetchInit }> = []
let spawnArgs: string[] | undefined

void mock.module("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mock((config: {
    fetch?: (input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => Promise<Response>
  }) => ({
    languageModel: mock((_modelId: string) => ({
      specificationVersion: "v3",
      modelId: "default",
      provider: "local_tcp",
      supportedUrls: {},
      doGenerate: mock(async (options: { abortSignal?: AbortSignal }) => {
        await config.fetch?.("http://127.0.0.1/v1/chat/completions", {
          method: "POST",
          body: "{}",
          signal: options.abortSignal,
        })
        return { text: "ok" }
      }),
      doStream: mock(async (options: { abortSignal?: AbortSignal }) => {
        await config.fetch?.("http://127.0.0.1/v1/chat/completions", {
          method: "POST",
          body: "{}",
          signal: options.abortSignal,
        })
        return { stream: new ReadableStream() }
      }),
    })),
  })),
}))

void mock.module("node:fs", () => ({
  createWriteStream: mock(() => ({
    end: mock(() => undefined),
  })),
  existsSync: mock(() => true),
}))

void mock.module("node:fs/promises", () => ({
  appendFile: mock(async () => undefined),
  mkdir: mock(async () => undefined),
  truncate: mock(async () => undefined),
}))

void mock.module("../../src/provider/sdk/local/gguf-resolver", () => ({
  resolveLocalGgufPath: mock(() => "D:/fake/model.gguf"),
}))

void mock.module("@/util/process", () => ({
  spawn: mock((_args: string[]) => {
    spawnArgs = _args
    return {
      exitCode: null,
      once: mock((_event: string, _handler: () => void) => undefined),
      pid: 1234,
      signalCode: null,
      stderr: {
        pipe: mock((_dest: unknown, _options?: unknown) => undefined),
      },
      stdout: {
        pipe: mock((_dest: unknown, _options?: unknown) => undefined),
      },
    }
  }),
  stop: mock(async () => undefined),
}))

const { createLocalTcp, stopLocalTcpServer } = await import("../../src/provider/sdk/local-tcp/local-tcp-provider")

const originalFetch = globalThis.fetch

beforeEach(() => {
  fetchCalls.length = 0
  spawnArgs = undefined
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => {
    fetchCalls.push({ input: String(input), init: init as CapturedFetchInit | undefined })
    if (String(input).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
      status: 200,
    })
  }) as unknown as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  delete process.env.LLM_CACHE_RAM
  delete process.env.LLM_CHECKPOINT_MIN_STEP
  delete process.env.LLM_CTX_CHECKPOINTS
  delete process.env.LLM_INFERENCE_TIMEOUT
  delete process.env.LLM_KV_UNIFIED
  delete process.env.LLM_MAX_CONCURRENCY
  delete process.env.LLM_N_GPU_LAYERS_DRAFT
  delete process.env.LLM_PARALLEL_N
  delete process.env.LLM_REPEAT_LAST_N
  delete process.env.LLM_SPEC_DRAFT_N_MAX
  delete process.env.LLM_SPEC_DRAFT_N_MIN
  delete process.env.LLM_SPEC_DRAFT_P_MIN
  delete process.env.LLM_SPEC_DRAFT_TYPE_K
  delete process.env.LLM_SPEC_DRAFT_TYPE_V
  delete process.env.LLM_SPEC_TYPE
  delete process.env.LLM_SPLIT_MODE
  delete process.env.LLM_TCP_SERVER_PATH
  await stopLocalTcpServer()
})

test("local_tcp forwards kv/cache checkpoint envs to llama-server args", async () => {
  process.env.LLM_TCP_SERVER_PATH = "C:/fake/llama-server.exe"
  process.env.LLM_KV_UNIFIED = "true"
  process.env.LLM_CACHE_RAM = "8192"
  process.env.LLM_CTX_CHECKPOINTS = "32"
  process.env.LLM_CHECKPOINT_MIN_STEP = "256"
  const provider = createLocalTcp({
    modelPath: "fake/model.gguf",
    startupTimeout: 1_000,
  })

  await provider.languageModel("default").doGenerate({} as never)

  expect(spawnArgs).toBeDefined()
  expect(spawnArgs).toContain("--kv-unified")
  expect(spawnArgs).toContain("--cache-ram")
  expect(spawnArgs).toContain("8192")
  expect(spawnArgs).toContain("--ctx-checkpoints")
  expect(spawnArgs).toContain("32")
  expect(spawnArgs).toContain("--checkpoint-min-step")
  expect(spawnArgs).toContain("256")
})

test("local_tcp forwards speculative decoding envs to llama-server args", async () => {
  process.env.LLM_TCP_SERVER_PATH = "C:/fake/llama-server.exe"
  process.env.LLM_SPEC_TYPE = "draft-mtp"
  process.env.LLM_SPEC_DRAFT_N_MAX = "2"
  process.env.LLM_SPEC_DRAFT_N_MIN = "0"
  process.env.LLM_SPEC_DRAFT_P_MIN = "0.00"
  process.env.LLM_N_GPU_LAYERS_DRAFT = "all"
  process.env.LLM_SPEC_DRAFT_TYPE_K = "f16"
  process.env.LLM_SPEC_DRAFT_TYPE_V = "f16"
  const provider = createLocalTcp({
    modelPath: "fake/model.gguf",
    startupTimeout: 1_000,
  })

  await provider.languageModel("default").doGenerate({} as never)

  expect(spawnArgs).toBeDefined()
  expect(spawnArgs).toContain("--spec-type")
  expect(spawnArgs).toContain("draft-mtp")
  expect(spawnArgs).toContain("--spec-draft-n-max")
  expect(spawnArgs).toContain("2")
  expect(spawnArgs).toContain("--spec-draft-n-min")
  expect(spawnArgs).toContain("0")
  expect(spawnArgs).toContain("--spec-draft-p-min")
  expect(spawnArgs).toContain("--n-gpu-layers-draft")
  expect(spawnArgs).toContain("all")
  expect(spawnArgs).toContain("--spec-draft-type-k")
  expect(spawnArgs).toContain("--spec-draft-type-v")
})

test("local_tcp forwards split_mode from env to llama-server args", async () => {
  process.env.LLM_TCP_SERVER_PATH = "C:/fake/llama-server.exe"
  process.env.LLM_SPLIT_MODE = "row"
  const provider = createLocalTcp({
    modelPath: "fake/model.gguf",
    startupTimeout: 1_000,
  })

  await provider.languageModel("default").doGenerate({} as never)

  expect(spawnArgs).toBeDefined()
  const splitModeIndex = spawnArgs?.indexOf("--split-mode") ?? -1
  expect(splitModeIndex).toBeGreaterThan(-1)
  expect(spawnArgs?.[splitModeIndex + 1]).toBe("row")
})

test("local_tcp forwards parallel_n from env to llama-server args", async () => {
  process.env.LLM_TCP_SERVER_PATH = "C:/fake/llama-server.exe"
  process.env.LLM_MAX_CONCURRENCY = "1"
  process.env.LLM_PARALLEL_N = "2"
  const provider = createLocalTcp({
    modelPath: "fake/model.gguf",
    startupTimeout: 1_000,
  })

  await provider.languageModel("default").doGenerate({} as never)

  expect(spawnArgs).toBeDefined()
  const parallelIndex = spawnArgs?.indexOf("--parallel") ?? -1
  expect(parallelIndex).toBeGreaterThan(-1)
  expect(spawnArgs?.[parallelIndex + 1]).toBe("2")
})

test("local_tcp forwards repeat_last_n from env to llama-server args", async () => {
  process.env.LLM_TCP_SERVER_PATH = "C:/fake/llama-server.exe"
  process.env.LLM_REPEAT_LAST_N = "1024"
  const provider = createLocalTcp({
    modelPath: "fake/model.gguf",
    startupTimeout: 1_000,
  })

  await provider.languageModel("default").doGenerate({} as never)

  expect(spawnArgs).toBeDefined()
  expect(spawnArgs).toContain("--repeat-last-n")
  expect(spawnArgs).toContain("1024")
})

test("local_tcp keeps the caller abort signal unchanged when env inference timeout is zero", async () => {
  process.env.LLM_TCP_SERVER_PATH = "C:/fake/llama-server.exe"
  process.env.LLM_INFERENCE_TIMEOUT = "0"
  const provider = createLocalTcp({
    modelPath: "fake/model.gguf",
    startupTimeout: 1_000,
  })
  const controller = new AbortController()

  await provider.languageModel("default").doGenerate({ abortSignal: controller.signal } as never)

  const request = fetchCalls.find((call) => call.input.endsWith("/chat/completions"))
  expect(request).toBeDefined()
  expect(request?.init?.signal).toBe(controller.signal)
  expect(request?.init?.timeout).toBe(false)
})

test("local_tcp wraps the caller abort signal when inference timeout is enabled", async () => {
  process.env.LLM_TCP_SERVER_PATH = "C:/fake/llama-server.exe"
  const provider = createLocalTcp({
    inferenceTimeout: 5,
    modelPath: "fake/model.gguf",
    startupTimeout: 1_000,
  })
  const controller = new AbortController()

  await provider.languageModel("default").doGenerate({ abortSignal: controller.signal } as never)

  const request = fetchCalls.find((call) => call.input.endsWith("/chat/completions"))
  expect(request).toBeDefined()
  expect(request?.init?.signal).not.toBe(controller.signal)
  expect(request?.init?.timeout).toBe(false)

  controller.abort(new Error("stop"))
  expect(request?.init?.signal?.aborted).toBe(true)
})