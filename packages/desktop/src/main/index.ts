import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow } from "electron"

import contextMenu from "electron-context-menu"

import type { InitStep, LlmDownloadProgress, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendLlmDownloadProgress, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { initLogging } from "./logging"
import { getDesktopEnvConfig, loadBundledEnv } from "./llm-config"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  getDefaultServerUrl,
  getWslConfig,
  preferAppEnv,
  setDefaultServerUrl,
  setWslConfig,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import {
  createLoadingWindow,
  createMainWindow,
  registerRendererProtocol,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { migrate } from "./migrate"
import { checkUpdate, checkForUpdates, installUpdate, setupAutoUpdater } from "./updater"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"

const APP_NAMES: Record<string, string> = {
  dev: "FlashCode Dev",
  beta: "FlashCode Beta",
  prod: "FlashCode",
}
const APP_IDS: Record<string, string> = {
  dev: "com.flashcode.desktop.dev",
  beta: "com.flashcode.desktop.beta",
  prod: "com.flashcode.desktop",
}
const LEGACY_APP_IDS: Record<string, string> = {
  dev: "com.ni.cic-code.desktop.dev",
  beta: "com.ni.cic-code.desktop.beta",
  prod: "com.ni.cic-code.desktop",
}
const DEEP_LINK_SCHEMES = ["flashcode", "ni-cic-code", "opencode"] as const
const TEST_ONBOARDING = process.env.FLASHCODE_TEST_ONBOARDING === "1"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

const pendingDeepLinks: string[] = []

function migrateLegacyUserDataPath(target: string, legacy: string) {
  if (target === legacy) return target
  if (existsSync(target)) return target
  if (!existsSync(legacy)) return target

  try {
    renameSync(legacy, target)
    return target
  } catch {
    return legacy
  }
}

function isDeepLinkUrl(input: string) {
  return DEEP_LINK_SCHEMES.some((scheme) => input.startsWith(`${scheme}://`))
}

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
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

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.FLASHCODE_DISABLE_EMBEDDED_WEB_UI = "true"
  loadBundledEnv()

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.flashcode.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `flashcode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.FLASHCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  const userDataPath = onboardingTestRoot
    ? join(onboardingTestRoot, "desktop")
    : app.isPackaged
      ? migrateLegacyUserDataPath(join(app.getPath("appData"), appId), join(app.getPath("appData"), LEGACY_APP_IDS[CHANNEL]))
      : join(app.getPath("appData"), appId)

  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "FlashCode Dev")
  app.setAppUserModelId(appId)
  app.setPath("userData", userDataPath)
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  logger = initLogging()

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => isDeepLinkUrl(arg))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    void killSidecar()
  })

  app.on("will-quit", () => {
    void killSidecar()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void killSidecar().finally(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()
  const loadingComplete = Deferred.makeUnsafe<void>()

  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    awaitInitialization: Effect.fnUntraced(
      function* (sendStep) {
        sendStep(initStep)
        const listener = (step: InitStep) => sendStep(step)
        initEmitter.on("step", listener)
        try {
          logger.log("awaiting server ready")
          const res = yield* Deferred.await(serverReady)
          logger.log("server ready", { url: res.url })
          return res
        } finally {
          initEmitter.off("step", listener)
        }
      },
      (e) => Effect.runPromise(e),
    ),
    getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED, ...getDesktopEnvConfig() }),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getWslConfig: () => Promise.resolve(getWslConfig()),
    setWslConfig: (config: WslConfig) => setWslConfig(config),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    wslPath: async (path, mode) => wslPath(path, mode),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    loadingWindowComplete: () => {
      logger.log("loading window complete")
      Deferred.doneUnsafe(loadingComplete, Effect.void)
    },
    runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail, killSidecar),
    checkUpdate: async () => checkUpdate(),
    installUpdate: async () => installUpdate(killSidecar),
    setBackgroundColor: (color) => setBackgroundColor(color),
  })

  yield* Effect.promise(() => app.whenReady())

  if (!TEST_ONBOARDING) migrate()
  for (const scheme of DEEP_LINK_SCHEMES) {
    app.setAsDefaultProtocolClient(scheme)
  }
  registerRendererProtocol()
  setDockIcon()
  setupAutoUpdater()

  const needsMigration = ((): boolean => {
    if (process.env.FLASHCODE_DB === ":memory:") return false

    const xdg = process.env.XDG_DATA_HOME
    const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
    return ![join(base, "flashcode", "opencode.db"), join(base, "ni-cic-code", "opencode.db")].some((candidate) =>
      existsSync(candidate),
    )
  })()
  let overlay: BrowserWindow | null = null

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.OPENCODE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    initEmitter.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (overlay) sendSqliteMigrationProgress(overlay, progress)
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
    })

    initEmitter.on("llm", (progress: LlmDownloadProgress) => {
      if (progress.type === "InProgress") setInitStep({ phase: "llm_downloading" })
      if (progress.type === "Done") setInitStep({ phase: "done" })
      if (progress.type === "Error") setInitStep({ phase: "done" })
      if (overlay) sendLlmDownloadProgress(overlay, progress)
      if (mainWindow) sendLlmDownloadProgress(mainWindow, progress)
    })

    logger.log("spawning sidecar", { url })
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(
        hostname,
        port,
        password,
        () => {
          ensureLoopbackNoProxy()
          useEnvProxy()
        },
        {
          needsMigration,
          userDataPath: app.getPath("userData"),
          onSqliteProgress: (progress) => initEmitter.emit("sqlite", progress),
          onLlmProgress: (progress) => initEmitter.emit("llm", progress),
          onStdout: (message) => logger.log("sidecar stdout", { message }),
          onStderr: (message) => logger.warn("sidecar stderr", { message }),
          onExit: (code) => logger.warn("sidecar exited", { code }),
        },
      ),
    )
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(Effect.forkChild)

  {
    const show = yield* loadingTask.pipe(
      Fiber.await,
      Effect.timeout("1 second"),
      Effect.as(false),
      Effect.catch(() => Effect.succeed(true)),
    )
    if (show) {
      overlay = createLoadingWindow()
      yield* Effect.sleep("1 second")
    }
  }

  const loadingExit = yield* Fiber.await(loadingTask)
  if (Exit.isFailure(loadingExit)) {
    logger.error("loading task failed", Cause.pretty(loadingExit.cause))
    if (!(yield* Deferred.isDone(serverReady))) {
      yield* Deferred.fail(serverReady, Cause.squash(loadingExit.cause))
    }
  }
  setInitStep({ phase: "done" })

  if (overlay) {
    yield* Deferred.await(loadingComplete).pipe(
      Effect.timeout("5 seconds"),
      Effect.catch(() =>
        Effect.sync(() => {
          logger.warn("loading window completion timed out; continuing startup")
        }),
      ),
    )
  }

  mainWindow = createMainWindow()
  if (mainWindow) {
    createMenu({
      trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
      checkForUpdates: () => {
        void checkForUpdates(true, killSidecar)
      },
      reload: () => mainWindow?.reload(),
      relaunch: () => {
        void killSidecar().finally(() => {
          app.relaunch()
          app.exit(0)
        })
      },
      showSettings: getDesktopEnvConfig().showSettings,
    })
  }

  overlay?.close()
})

Effect.runFork(main)
