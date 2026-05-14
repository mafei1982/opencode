// @refresh reload

import { render } from "solid-js/web"
import { createResource, Show } from "solid-js"
import { NiApp } from "@opencode-ai/ni-app"
import { getNiWorkspacePathForPlatform } from "@opencode-ai/ni-app/utils/workspace"
import "./styles.css"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error("Root element not found")
}

const os = (() => {
  const ua = navigator.userAgent
  if (ua.includes("Mac")) return "macos" as const
  if (ua.includes("Windows")) return "windows" as const
  if (ua.includes("Linux")) return "linux" as const
  return undefined
})()

render(() => {
  const [sidecar] = createResource(() => window.api.awaitInitialization(() => undefined))

  const serverUrl = () => sidecar()?.url ?? ""
  const workspacePath = getNiWorkspacePathForPlatform(os)

  return (
    <Show when={!sidecar.loading && sidecar()}>
      <NiApp
        serverUrl={serverUrl()}
        defaultServerUrl={serverUrl()}
        workspacePath={workspacePath}
      />
    </Show>
  )
}, root!)
