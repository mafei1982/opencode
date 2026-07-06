import { EMBEDDED_CONFIG_KEY_ENV, encodeEmbeddedConfigDiskFile } from "../../../core/src/embedded-config"
import { applyBundledToolsEnv, loadBundledEnv } from "./llm-config"
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
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | {
      type: "llm"
      progress:
        | { type: "InProgress"; percent: number; downloadedSize: number; totalSize: number }
        | { type: "Done" }
        | { type: "Error"; message: string }
    }
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
    const toolsDir = applyBundledToolsEnv()
    if (toolsDir) console.log(`[sidecar] Using bundled tools from ${toolsDir}`)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    const { Server } = await import("virtual:opencode-server")

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "opencode",
      password: command.password,
      cors: ["oc://renderer"],
    })
    parentPort.postMessage({ type: "ready" })

    if ((process.env.LLM_PROVIDER ?? "").toLowerCase() === "local_tcp") {
      console.log("[sidecar] Starting local llama.cpp server...")
      void import("virtual:opencode-server")
        .then(({ loadLocalTcpServer }) =>
          loadLocalTcpServer({
            downloadProgress: (progress: { downloadedSize: number; percent: number; totalSize: number }) =>
              parentPort.postMessage({ type: "llm", progress: { type: "InProgress", ...progress } }),
          }),
        )
        .then(() => {
          parentPort.postMessage({ type: "llm", progress: { type: "Done" } })
          console.log("[sidecar] Local llama.cpp server is ready.")
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error("[sidecar] Failed to start local llama.cpp server, continuing without it:", error)
          parentPort.postMessage({ type: "llm", progress: { type: "Error", message } })
        })
    }
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    if ((process.env.LLM_PROVIDER ?? "").toLowerCase() === "local_tcp") {
      const { stopLocalTcpServer } = await import("virtual:opencode-server")
      await stopLocalTcpServer()
    }
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
    FLASHCODE_SERVER_USERNAME: "opencode",
    FLASHCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

function ensureModelDir() {
  if (process.env.LLM_MODEL_DIR) return
  process.env.LLM_MODEL_DIR = path.join(
    process.resourcesPath ? path.dirname(process.resourcesPath) : path.resolve(__dirname, "../.."),
    "models",
  )
  fs.mkdirSync(process.env.LLM_MODEL_DIR, { recursive: true })
  console.log(`[sidecar] LLM_MODEL_DIR auto-set to ${process.env.LLM_MODEL_DIR}`)
}

function extractEmbeddedConfig() {
  if (!embeddedConfig) return
  const dir = path.join(os.tmpdir(), `flashcode-embedded-${process.pid}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  process.env[EMBEDDED_CONFIG_KEY_ENV] = embeddedConfig.key

  Object.entries(embeddedConfig.files).forEach(([relative, file]) => {
    const target = path.join(dir, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, encodeEmbeddedConfigDiskFile(file), { mode: 0o400 })
  })

  process.env.OPENCODE_EMBEDDED_CONFIG_DIR = dir
  process.env.FLASHCODE_EMBEDDED_CONFIG_DIR = dir
  if (fs.existsSync(path.join(dir, "references"))) {
    process.env.FLASHCODE_REFERENCES_DIR = path.join(dir, "references")
    process.env.NI_CIC_REFERENCES_DIR = path.join(dir, "references")
  }

  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
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
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
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
