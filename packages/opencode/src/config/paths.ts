export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const CONFIG_BASENAME = "flashcode"
export const CONFIG_BASENAMES = ["opencode", CONFIG_BASENAME] as const
export const CONFIG_DIRECTORY = ".flashcode"
export const CONFIG_DIRECTORIES = [".opencode", CONFIG_DIRECTORY] as const

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string | readonly string[],
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  const names = Array.isArray(name) ? [...name] : [name]
  return (yield* afs.up({
    targets: names.toReversed().flatMap((item) => [`${item}.jsonc`, `${item}.json`]),
    start: directory,
    stop: worktree,
  })).toReversed()
})

export function isConfigDirectory(dir: string) {
  return CONFIG_DIRECTORIES.some((target) => dir.endsWith(target))
}

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [...CONFIG_DIRECTORIES],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [...CONFIG_DIRECTORIES],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string | readonly string[]) {
  const names = Array.isArray(name) ? [...name] : [name]
  return names.flatMap((item) => [path.join(dir, `${item}.json`), path.join(dir, `${item}.jsonc`)])
}
