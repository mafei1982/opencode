import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import path from "node:path"

const existingPaths = new Set<string>()
const fetchCalls: string[] = []
const lockCalls: string[] = []
let extracted = false
let writtenBytes = 0

function normalize(input: string) {
  return path.normalize(input)
}

void mock.module("@opencode-ai/core/global", () => ({
  Global: {
    Path: {
      bin: normalize("C:/cache/bin"),
      state: normalize("C:/cache/state"),
    },
  },
}))

void mock.module("@opencode-ai/core/util/flock", () => ({
  Flock: {
    withLock: mock(async (key: string, fn: () => Promise<string>) => {
      lockCalls.push(key)
      return fn()
    }),
  },
}))

void mock.module("node:fs", () => ({
  existsSync: mock((input: string) => existingPaths.has(normalize(input))),
}))

void mock.module("node:fs/promises", () => ({
  cp: mock(async (_source: string, target: string) => {
    existingPaths.add(normalize(path.join(target, "llama-server.exe")))
  }),
  mkdir: mock(async () => undefined),
  open: mock(async () => ({
    close: mock(async () => undefined),
    write: mock(async (chunk: Uint8Array) => {
      writtenBytes += chunk.byteLength
    }),
  })),
  readdir: mock(async () =>
    extracted
      ? [
          {
            isDirectory: () => false,
            isFile: () => true,
            name: "llama-server.exe",
          },
        ]
      : [],
  ),
  rename: mock(async (_source: string, target: string) => {
    existingPaths.add(normalize(path.join(target, "llama-server.exe")))
  }),
  rm: mock(async () => undefined),
}))

void mock.module("@/util/archive", () => ({
  Archive: {
    extractZip: mock(async () => {
      extracted = true
    }),
  },
}))

const { ensureLlamaCppServer, installLlamaCppServer, isAddLlamaCppServerEnabled } = await import(
  "../../src/provider/sdk/local-tcp/llama-cpp-server"
)

const originalFetch = globalThis.fetch

beforeEach(() => {
  existingPaths.clear()
  fetchCalls.length = 0
  lockCalls.length = 0
  extracted = false
  writtenBytes = 0
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => {
    fetchCalls.push(String(input))
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "content-length": "4" },
      status: 200,
    })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.ADD_LLAMA_CPP_SERVER
  delete process.env.add_llama_cpp_server
  delete process.env.LLM_TCP_SERVER_PATH
})

test("ensureLlamaCppServer returns an existing explicit server path", async () => {
  existingPaths.add(normalize("C:/custom/llama-server.exe"))

  await expect(ensureLlamaCppServer({ serverPath: "C:/custom/llama-server.exe" })).resolves.toBe(
    "C:/custom/llama-server.exe",
  )
  expect(fetchCalls).toHaveLength(0)
})

test("ensureLlamaCppServer fails when an explicit server path is missing", async () => {
  await expect(ensureLlamaCppServer({ serverPath: "C:/missing/llama-server.exe" })).rejects.toThrow(
    "Configured llama-server.exe was not found",
  )
  expect(fetchCalls).toHaveLength(0)
})

test("ensureLlamaCppServer downloads the pinned Windows server when candidates are missing", async () => {
  const progress: Array<{ downloadedSize: number; percent: number; totalSize: number }> = []

  const binary = await ensureLlamaCppServer({
    arch: "x64",
    downloadProgress: (event) => progress.push(event),
    platform: "win32",
  })

  expect(binary.endsWith(normalize("llama-cpp-server/b9878/win-cuda-12.4-x64/llama-server.exe"))).toBe(true)
  expect(fetchCalls).toEqual([
    "https://github.com/ggml-org/llama.cpp/releases/download/b9878/llama-b9878-bin-win-cuda-12.4-x64.zip",
  ])
  expect(lockCalls).toHaveLength(1)
  expect(progress.at(-1)).toEqual({ downloadedSize: 4, percent: 100, totalSize: 4 })
  expect(writtenBytes).toBe(4)
})

test("ensureLlamaCppServer deduplicates concurrent downloads", async () => {
  await Promise.all([
    ensureLlamaCppServer({ arch: "x64", platform: "win32" }),
    ensureLlamaCppServer({ arch: "x64", platform: "win32" }),
  ])

  expect(fetchCalls).toHaveLength(1)
})

test("ensureLlamaCppServer reports unsupported platforms", async () => {
  await expect(ensureLlamaCppServer({ arch: "x64", platform: "linux" })).rejects.toThrow("Windows x64 only")
  expect(fetchCalls).toHaveLength(0)
})

test("installLlamaCppServer copies an existing candidate into the requested target", async () => {
  const source = normalize("C:/custom/llama-server.exe")
  existingPaths.add(source)
  process.env.LLM_TCP_SERVER_PATH = source

  await expect(installLlamaCppServer(normalize("C:/target/llama-cpp-server"))).resolves.toBe(
    normalize("C:/target/llama-cpp-server/llama-server.exe"),
  )
  expect(fetchCalls).toHaveLength(0)
})

test("installLlamaCppServer downloads into cache before copying to the requested target", async () => {
  const target = normalize("C:/target/llama-cpp-server")

  await expect(installLlamaCppServer(target, { arch: "x64", platform: "win32" })).resolves.toBe(
    normalize("C:/target/llama-cpp-server/llama-server.exe"),
  )

  expect(fetchCalls).toHaveLength(1)
  expect(lockCalls[0]).toContain(normalize("C:/cache/bin/llama-cpp-server/b9878/win-cuda-12.4-x64"))
  expect(existingPaths.has(normalize("C:/cache/bin/llama-cpp-server/b9878/win-cuda-12.4-x64/llama-server.exe"))).toBe(
    true,
  )
  expect(existingPaths.has(normalize("C:/target/llama-cpp-server/llama-server.exe"))).toBe(true)
})

test("isAddLlamaCppServerEnabled reads lowercase and uppercase build flags", () => {
  expect(isAddLlamaCppServerEnabled({ add_llama_cpp_server: "true" })).toBe(true)
  expect(isAddLlamaCppServerEnabled({ ADD_LLAMA_CPP_SERVER: "1" })).toBe(true)
  expect(isAddLlamaCppServerEnabled({ add_llama_cpp_server: "false", ADD_LLAMA_CPP_SERVER: "1" })).toBe(false)
  expect(isAddLlamaCppServerEnabled({})).toBe(false)
})
