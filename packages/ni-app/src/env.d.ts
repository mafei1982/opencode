/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENCODE_SERVER_HOST?: string
  readonly VITE_OPENCODE_SERVER_PORT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "*.svg" {
  const src: string
  export default src
}
