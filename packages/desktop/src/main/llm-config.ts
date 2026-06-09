import * as fs from "node:fs"
import * as path from "node:path"

const truthy = new Set(["1", "true", "yes", "on"])
const falsy = new Set(["0", "false", "no", "off"])

function bundledEnvPaths() {
  return [
    process.resourcesPath ? path.join(process.resourcesPath, "llm.env") : "",
    path.resolve(__dirname, "../../resources/llm.env"),
  ].filter((item, index, list): item is string => Boolean(item) && list.indexOf(item) === index)
}

function bundledToolsPaths(input?: { resourcesPath?: string; dirname?: string }) {
  const resourcesPath = input?.resourcesPath ?? process.resourcesPath
  const dirname = input?.dirname ?? __dirname
  return [
    resourcesPath ? path.join(resourcesPath, "tools") : "",
    path.resolve(dirname, "../../resources/tools"),
  ].filter((item, index, list): item is string => Boolean(item) && list.indexOf(item) === index)
}

export function loadBundledEnv() {
  for (const envPath of bundledEnvPaths()) {
    if (!fs.existsSync(envPath)) continue

    const content = fs.readFileSync(envPath, "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue

      const eqIdx = trimmed.indexOf("=")
      if (eqIdx === -1) continue

      const key = trimmed.slice(0, eqIdx).trim()
      let value = trimmed.slice(eqIdx + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }

      if (process.env[key] === undefined) process.env[key] = value
    }

    return envPath
  }
}

export function resolveBundledToolsDir(input?: { resourcesPath?: string; dirname?: string }) {
  for (const toolsDir of bundledToolsPaths(input)) {
    if (!fs.existsSync(toolsDir)) continue
    if (!fs.statSync(toolsDir).isDirectory()) continue
    return toolsDir
  }
}

export function applyBundledToolsEnv(env = process.env, input?: { resourcesPath?: string; dirname?: string }) {
  const toolsDir = resolveBundledToolsDir(input)
  if (!toolsDir) return
  env.FLASHCODE_TOOLS_DIR = toolsDir
  env.NI_CIC_TOOLS_DIR = toolsDir
  return toolsDir
}

function readBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (truthy.has(normalized)) return true
  if (falsy.has(normalized)) return false
  return fallback
}

function localProvider(env: NodeJS.ProcessEnv) {
  const provider = (env.LLM_PROVIDER ?? "").trim().toLowerCase()
  if (provider === "local" || provider === "local_tcp") return provider
  return undefined
}

export function shouldLockLocalProviders(env = process.env) {
  if (!localProvider(env)) return false
  return readBoolean(env.LLM_DISABLE_NON_LOCAL_PROVIDERS, true)
}

export function getDesktopEnvConfig(env = process.env) {
  const defaultTheme = env.OPENCODE_DEFAULT_THEME?.trim()
  return {
    defaultTheme: defaultTheme || undefined,
    showSettings: readBoolean(env.OPENCODE_SHOW_SETTINGS, false),
    providerManagement: !shouldLockLocalProviders(env),
  }
}