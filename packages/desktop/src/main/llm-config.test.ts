import { describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { applyBundledToolsEnv, resolveBundledToolsDir } from "./llm-config"

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flashcode-desktop-tools-"))
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe("llm-config", () => {
  test("resolveBundledToolsDir finds dev resources/tools next to out/main", async () => {
    await withTempDir(async (dir) => {
      const toolsDir = path.join(dir, "resources", "tools")
      const mainDir = path.join(dir, "out", "main")
      await fs.mkdir(toolsDir, { recursive: true })
      await fs.mkdir(mainDir, { recursive: true })

      expect(resolveBundledToolsDir({ dirname: mainDir })).toBe(toolsDir)
    })
  })

  test("resolveBundledToolsDir prefers packaged resources/tools when available", async () => {
    await withTempDir(async (dir) => {
      const packagedResources = path.join(dir, "packaged-resources")
      const packagedTools = path.join(packagedResources, "tools")
      const devTools = path.join(dir, "resources", "tools")
      const mainDir = path.join(dir, "out", "main")
      await fs.mkdir(packagedTools, { recursive: true })
      await fs.mkdir(devTools, { recursive: true })
      await fs.mkdir(mainDir, { recursive: true })

      expect(resolveBundledToolsDir({ resourcesPath: packagedResources, dirname: mainDir })).toBe(packagedTools)
    })
  })

  test("applyBundledToolsEnv writes both tools env vars", async () => {
    await withTempDir(async (dir) => {
      const toolsDir = path.join(dir, "resources", "tools")
      const mainDir = path.join(dir, "out", "main")
      await fs.mkdir(toolsDir, { recursive: true })
      await fs.mkdir(mainDir, { recursive: true })

      const env: NodeJS.ProcessEnv = {}
      expect(applyBundledToolsEnv(env, { dirname: mainDir })).toBe(toolsDir)
      expect(env.FLASHCODE_TOOLS_DIR).toBe(toolsDir)
      expect(env.NI_CIC_TOOLS_DIR).toBe(toolsDir)
    })
  })
})