// @refresh reload

import { render } from "solid-js/web"
import { NiApp } from "./app"
import { getNiWorkspacePath } from "./utils/workspace"

const DEFAULT_SERVER_URL_KEY = "ni-opencode.settings.dat:defaultServerUrl"

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const getCurrentUrl = () => {
  return location.origin
}

const getDefaultUrl = () => {
  const stored = getStorage(DEFAULT_SERVER_URL_KEY)
  if (stored) return stored
  return getCurrentUrl()
}

const root = document.getElementById("root")
if (root instanceof HTMLElement) {
  const serverUrl = getCurrentUrl()
  const defaultServerUrl = getDefaultUrl()
  const workspacePath = getNiWorkspacePath()

  render(
    () => (
      <NiApp
        serverUrl={serverUrl}
        defaultServerUrl={defaultServerUrl}
        workspacePath={workspacePath}
        onDefaultServerUrlChange={(url) => setStorage(DEFAULT_SERVER_URL_KEY, url)}
      />
    ),
    root,
  )
}
