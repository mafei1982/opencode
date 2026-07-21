import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`
const deepLinkSchemes = ["flashcode", "ni-cic-code", "opencode"]
const bundledToolsDir = process.env.FLASHCODE_TOOLS_DIR ?? process.env.NI_CIC_TOOLS_DIR
const bundledLlamaCppServerDir = path.join(rootDir, "packages", "opencode", "dist", "node", "llama-cpp-server")
const addLlamaCppServer = ["1", "true", "yes", "on"].includes(
  (process.env.add_llama_cpp_server ?? process.env.ADD_LLAMA_CPP_SERVER ?? "").trim().toLowerCase(),
)

if (addLlamaCppServer && !existsSync(path.join(bundledLlamaCppServerDir, "llama-server.exe"))) {
  throw new Error("add_llama_cpp_server=true requires packages/opencode/dist/node/llama-cpp-server/llama-server.exe")
}

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "com.flashcode.desktop.dev",
  beta: "com.flashcode.desktop.beta",
  prod: "com.flashcode.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  artifactName: "flashcode-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    { from: "resources/llm.env", to: "llm.env", filter: ["llm.env"] },
    ...(addLlamaCppServer
      ? [{ from: "../opencode/dist/node/llama-cpp-server", to: "llama-cpp-server", filter: ["**/*"] }]
      : []),
    ...(bundledToolsDir ? [{ from: bundledToolsDir, to: "tools/" }] : []),
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "metaXtest",
    schemes: deepLinkSchemes,
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "metaXtest Dev",
        rpm: { packageName: "flashcode-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "metaXtest Beta",
        protocols: { name: "metaXtest Beta", schemes: deepLinkSchemes },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode-beta", channel: "latest" },
        rpm: { packageName: "flashcode-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "metaXtest",
        protocols: { name: "metaXtest", schemes: deepLinkSchemes },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode", channel: "latest" },
        deb: { fpm: [legacyDesktopEntryFpm] },
        rpm: { packageName: "flashcode", fpm: [legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
