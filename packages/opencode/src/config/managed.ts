export * as ConfigManaged from "./managed"

import { existsSync } from "fs"
import os from "os"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Process } from "@/util/process"

const log = Log.create({ service: "config" })

const MANAGED_PLIST_DOMAINS = ["com.flashcode.managed", "com.ni.cic-code.managed"] as const

// Keys injected by macOS/MDM into the managed plist that are not OpenCode config
const PLIST_META = new Set([
  "PayloadDisplayName",
  "PayloadIdentifier",
  "PayloadType",
  "PayloadUUID",
  "PayloadVersion",
  "_manualProfile",
])

function systemManagedConfigDir(app: string): string {
  switch (process.platform) {
    case "darwin":
      return path.join("/Library/Application Support", app)
    case "win32":
      return path.join(process.env.ProgramData || "C:\\ProgramData", app)
    default:
      return path.join("/etc", app)
  }
}

export function managedConfigDir() {
  if (process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR) return process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR

  const next = systemManagedConfigDir("flashcode")
  if (existsSync(next)) return next

  const legacy = systemManagedConfigDir("ni-cic-code")
  if (existsSync(legacy)) return legacy

  return next
}

export function parseManagedPlist(json: string): string {
  const raw = JSON.parse(json)
  for (const key of Object.keys(raw)) {
    if (PLIST_META.has(key)) delete raw[key]
  }
  return JSON.stringify(raw)
}

export async function readManagedPreferences() {
  if (process.platform !== "darwin") return

  const user = os.userInfo().username
  const paths = MANAGED_PLIST_DOMAINS.flatMap((domain) => [
    path.join("/Library/Managed Preferences", user, `${domain}.plist`),
    path.join("/Library/Managed Preferences", `${domain}.plist`),
  ])

  for (const plist of paths) {
    if (!existsSync(plist)) continue
    log.info("reading macOS managed preferences", { path: plist })
    const result = await Process.run(["plutil", "-convert", "json", "-o", "-", plist], { nothrow: true })
    if (result.code !== 0) {
      log.warn("failed to convert managed preferences plist", { path: plist })
      continue
    }
    return {
      source: `mobileconfig:${plist}`,
      text: parseManagedPlist(result.stdout.toString()),
    }
  }

  return
}
