import { afterEach, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"

import { tmpdir } from "../fixture/fixture"
import { resolveLocalGgufPath } from "../../src/provider/sdk/local/gguf-resolver"

afterEach(() => {
  delete process.env.LLM_MODEL_DIR
})

test("resolveLocalGgufPath prefers local cached GGUF for HuggingFace specifier", async () => {
  await using tmp = await tmpdir()
  const modelDir = path.join(tmp.path, "Jackrong", "Qwopus3.6-27B-v2-MTP-GGUF")
  await mkdir(modelDir, { recursive: true })

  const ggufPath = path.join(modelDir, "Qwopus3.6-27B-v2-MTP-Q4_K_M.gguf")
  await Bun.write(ggufPath, "test")
  process.env.LLM_MODEL_DIR = tmp.path

  expect(resolveLocalGgufPath("Jackrong/Qwopus3.6-27B-v2-MTP-GGUF:Q4_K_M")).toBe(ggufPath)
})

test("resolveLocalGgufPath resolves explicit GGUF paths unchanged", async () => {
  await using tmp = await tmpdir()
  const ggufPath = path.join(tmp.path, "model.gguf")
  await Bun.write(ggufPath, "test")

  expect(resolveLocalGgufPath(ggufPath)).toBe(ggufPath)
})