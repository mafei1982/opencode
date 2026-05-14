// NI_WORKSPACE_DIR is injected by Vite at build/dev time with the actual path
declare const __NI_WORKSPACE_DIR__: string

export function getNiWorkspacePath() {
  return __NI_WORKSPACE_DIR__
}

export function getNiWorkspacePathForPlatform(os?: "macos" | "windows" | "linux") {
  return __NI_WORKSPACE_DIR__
}
