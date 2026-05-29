import { drizzle } from "drizzle-orm/node-sqlite/driver"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import * as tls from "node:tls"
import embeddedConfig from "virtual:embedded-config"

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  needsMigration: boolean
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | { type: "sqlite"; progress: { type: "InProgress"; value: number } | { type: "Done" } }
  | { type: "llm"; progress: { type: "InProgress"; percent: number; downloadedSize: number; totalSize: number } | { type: "Done" } | { type: "Error"; message: string } }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

const parentPort = getParentPort()
let listener: Listener | undefined

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    loadBundledEnv()
    ensureModelDir()
    prepareSidecarEnv(command.password, command.userDataPath)
    extractEmbeddedConfig()
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    const { Database, JsonMigration, Log, Server } = await import("virtual:opencode-server")
    await Log.init({ level: "WARN" })

    if (command.needsMigration) {
      await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
        progress: (event: { current: number; total: number }) => {
          parentPort.postMessage({
            type: "sqlite",
            progress: {
              type: "InProgress",
              value: event.total === 0 ? 100 : Math.round((event.current / event.total) * 100),
            },
          })
        },
      })
      parentPort.postMessage({ type: "sqlite", progress: { type: "Done" } })
    }

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "opencode",
      password: command.password,
      cors: ["oc://renderer"],
    })
    parentPort.postMessage({ type: "ready" })

    // Load local LLM model after server is ready (non-blocking)
    // Download progress is reported; model loading in memory happens in background
    if ((process.env.LLM_PROVIDER ?? "").toLowerCase() === "local") {
      console.log("[sidecar] Loading local LLM model (llama.cpp)...")
      import("virtual:opencode-server")
        .then(({ loadLocalModel }) =>
          loadLocalModel(undefined, (p: { totalSize: number; downloadedSize: number }) => {
            const percent = p.totalSize > 0 ? Math.round((p.downloadedSize / p.totalSize) * 100) : 0
            parentPort.postMessage({
              type: "llm",
              progress: { type: "InProgress", percent, downloadedSize: p.downloadedSize, totalSize: p.totalSize },
            })
          }),
        )
        .then(() => {
          parentPort.postMessage({ type: "llm", progress: { type: "Done" } })
          console.log("[sidecar] Local LLM model loaded successfully.")
        })
        .catch((llmError: unknown) => {
          const msg = llmError instanceof Error ? llmError.message : String(llmError)
          console.error("[sidecar] Failed to load local LLM model, continuing without it:", llmError)
          parentPort.postMessage({ type: "llm", progress: { type: "Error", message: msg } })
        })
    }
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    await listener?.stop()
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

/**
 * Load a bundled `llm.env` file from the app's resources directory.
 *
 * During desktop app build, a `.env` file can be copied to `resources/llm.env`
 * (via `LLM_ENV_FILE` env var or manually). This function reads it at startup
 * and sets the environment variables — but does NOT override variables that
 * are already set (so runtime env takes precedence over bundled defaults).
 *
 * The file format is standard `.env`: KEY=VALUE lines, `#` comments, blank lines.
 */
function loadBundledEnv() {
  // In packaged app: process.resourcesPath (e.g. .../resources/)
  // In dev mode: ../../resources/ relative to out/main/
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "llm.env") : "",
    path.resolve(__dirname, "../../resources/llm.env"),
  ].filter(Boolean)

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue

    console.log(`[sidecar] Loading bundled LLM config from ${envPath}`)
    const content = fs.readFileSync(envPath, "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIdx = trimmed.indexOf("=")
      if (eqIdx === -1) continue

      const key = trimmed.slice(0, eqIdx).trim()
      let value = trimmed.slice(eqIdx + 1).trim()
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
        value = value.slice(1, -1)

      // Don't override existing env vars — runtime env takes precedence
      if (process.env[key] === undefined) process.env[key] = value
    }

    return
  }
}

/**
 * Ensure LLM_MODEL_DIR points to a persistent directory on the same drive
 * as the packaged app, but outside the app bundle so it survives repackaging.
 */
function ensureModelDir() {
  if (process.env.LLM_MODEL_DIR) return
  const appRoot = process.resourcesPath
    ? path.dirname(process.resourcesPath)
    : path.resolve(__dirname, "../..")
  // Put models at drive root (e.g. D:\.opencode\models) so they persist
  // across app rebuilds — the old <app-root>/models got wiped by package:win
  const drive = path.parse(appRoot).root
  process.env.LLM_MODEL_DIR = path.join(drive, ".opencode", "models")
  console.log(`[sidecar] LLM_MODEL_DIR auto-set to ${process.env.LLM_MODEL_DIR}`)
}

function extractEmbeddedConfig() {
  if (!embeddedConfig) return

  const tmpDir = path.join(os.tmpdir(), `ni-cic-code-embedded-${process.pid}`)
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 })

  for (const [relPath, content] of Object.entries(embeddedConfig)) {
    const filePath = path.join(tmpDir, relPath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(filePath, content, { mode: 0o400 })
  }

  try {
    fs.chmodSync(tmpDir, 0o500)
  } catch {}

  process.env.OPENCODE_EMBEDDED_CONFIG_DIR = tmpDir

  const refsDir = path.join(tmpDir, "references")
  if (fs.existsSync(refsDir))
    process.env.NI_CIC_REFERENCES_DIR = refsDir

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  }
  process.on("exit", cleanup)
  process.on("SIGTERM", cleanup)
  process.on("SIGINT", cleanup)
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  if (typeof command.needsMigration !== "boolean") return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    needsMigration: command.needsMigration,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
