import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
export const ENABLE_LICENSE_CHECK = import.meta.env.ENABLE_LICENSE_CHECK
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"
