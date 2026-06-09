import { afterEach, describe, expect, mock, test } from "bun:test"

const runtimeInitCalls: unknown[] = []
const runtimeClients: { init: ReturnType<typeof mock> }[] = []
const modelInstances: unknown[] = []
let resolveInit: (() => void) | undefined

void mock.module("../../src/provider/sdk/local/gguf-resolver", () => ({
  resolveGgufPath: mock(async () => "D:/fake/model.gguf"),
}))

void mock.module("../../src/provider/sdk/local/local-runtime", () => ({
  createLocalRuntimeClient: mock(() => {
    const client = {
      init: mock(
        (input: unknown) =>
          new Promise<void>((resolve) => {
            runtimeInitCalls.push(input)
            resolveInit = resolve
          }),
      ),
      generate: mock(async () => ({})),
      stream: mock(async () => new ReadableStream()),
      dispose: mock(async () => {}),
    }
    runtimeClients.push(client)
    return client
  }),
}))

class MockLocalLanguageModel {
  constructor(_modelId: string, _options: unknown) {
    modelInstances.push(this)
  }

  async doGenerate() {
    return { text: "ok" } as any
  }

  async doStream() {
    return { stream: new ReadableStream() } as any
  }
}

void mock.module("../../src/provider/sdk/local/local-language-model", () => ({
  LocalLanguageModel: MockLocalLanguageModel,
}))

const { createLocal, resetLocalProviderForTests } = await import("../../src/provider/sdk/local/local-provider")

describe("local provider", () => {
  afterEach(() => {
    resetLocalProviderForTests()
    runtimeInitCalls.length = 0
    runtimeClients.length = 0
    modelInstances.length = 0
    resolveInit = undefined
    delete process.env.LLM_MODEL_PATH
    delete process.env.LLM_REPEAT_PENALTY
  })

  test("deduplicates concurrent lazy initialization across provider instances", async () => {
    process.env.LLM_MODEL_PATH = "Jackrong/Qwopus3.6-27B-v2-MTP-GGUF:Q4_K_M"

    const first = createLocal()
    const second = createLocal()
    const firstLoad = first.languageModel("default").doGenerate({} as any)
    const secondLoad = second.languageModel("default").doGenerate({} as any)

    await Promise.resolve()
    await Promise.resolve()

    expect(runtimeClients).toHaveLength(1)
    expect(runtimeInitCalls).toHaveLength(1)

    resolveInit?.()

    await expect(firstLoad as Promise<any>).resolves.toEqual({ text: "ok" })
    await expect(secondLoad as Promise<any>).resolves.toEqual({ text: "ok" })
    expect(modelInstances).toHaveLength(1)
  })

  test("passes repeat penalty from env into runtime sampling params", async () => {
    process.env.LLM_MODEL_PATH = "Jackrong/Qwopus3.6-27B-v2-MTP-GGUF:Q4_K_M"
    process.env.LLM_REPEAT_PENALTY = "1.1"

    const provider = createLocal()
    const load = provider.languageModel("default").doGenerate({} as any)

    await Promise.resolve()
    await Promise.resolve()

    expect(runtimeInitCalls).toHaveLength(1)
    expect(runtimeInitCalls[0]).toMatchObject({
      samplingParams: {
        repeatPenalty: 1.1,
      },
    })

    resolveInit?.()
    await expect(load as Promise<any>).resolves.toEqual({ text: "ok" })
  })
})