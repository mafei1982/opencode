import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { gunzipSync, gzipSync } from "node:zlib"

const EMBEDDED_CONFIG_ALGORITHM = "aes-256-gcm"
const EMBEDDED_CONFIG_FILE_PREFIX = "FLASHCODE_EMBEDDED_CONFIG_V1\n"
const EMBEDDED_CONFIG_IV_BYTES = 12
const EMBEDDED_CONFIG_KEY_BYTES = 32

export const EMBEDDED_CONFIG_KEY_ENV = "FLASHCODE_EMBEDDED_CONFIG_KEY"

export type EmbeddedConfigFile = {
  version: 1
  algorithm: typeof EMBEDDED_CONFIG_ALGORITHM
  iv: string
  tag: string
  content: string
}

export type EmbeddedConfigBundle = {
  version: 1
  algorithm: typeof EMBEDDED_CONFIG_ALGORITHM
  key: string
  files: Record<string, EmbeddedConfigFile>
}

export function createEmbeddedConfigBundle(files: Record<string, string>): EmbeddedConfigBundle {
  const key = randomBytes(EMBEDDED_CONFIG_KEY_BYTES)
  return {
    version: 1,
    algorithm: EMBEDDED_CONFIG_ALGORITHM,
    key: key.toString("base64"),
    files: Object.fromEntries(
      Object.entries(files).map(([relPath, content]) => [relPath, encryptEmbeddedConfigFile(key, content)]),
    ),
  }
}

export function decodeEmbeddedConfigFile(bundle: EmbeddedConfigBundle, file: EmbeddedConfigFile) {
  return decryptEmbeddedConfigFile(bundle.key, file)
}

export function encodeEmbeddedConfigDiskFile(file: EmbeddedConfigFile) {
  return `${EMBEDDED_CONFIG_FILE_PREFIX}${JSON.stringify(file)}`
}

export function isEmbeddedConfigDiskFileText(text: string) {
  return text.startsWith(EMBEDDED_CONFIG_FILE_PREFIX)
}

export function maybeDecodeEmbeddedConfigText(text: string, key = process.env[EMBEDDED_CONFIG_KEY_ENV]) {
  const file = parseEmbeddedConfigDiskFile(text)
  if (!file) return text
  if (!key) throw new Error(`Missing ${EMBEDDED_CONFIG_KEY_ENV} for embedded config decryption`)
  return decryptEmbeddedConfigFile(key, file)
}

export async function resolveEmbeddedConfigModuleImport(spec: string) {
  const filePath = moduleImportFilePath(spec)
  if (!filePath) return spec

  const text = await readFile(filePath, "utf8")
  if (!isEmbeddedConfigDiskFileText(text)) return spec

  const decoded = maybeDecodeEmbeddedConfigText(text)
  const source = pathToFileURL(filePath).href
  return `data:text/javascript;base64,${Buffer.from(`${decoded}\n//# sourceURL=${source}`).toString("base64")}`
}

function encryptEmbeddedConfigFile(key: Buffer, content: string): EmbeddedConfigFile {
  const iv = randomBytes(EMBEDDED_CONFIG_IV_BYTES)
  const cipher = createCipheriv(EMBEDDED_CONFIG_ALGORITHM, key, iv)
  const compressed = gzipSync(Buffer.from(content, "utf8"))
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()])
  return {
    version: 1,
    algorithm: EMBEDDED_CONFIG_ALGORITHM,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    content: encrypted.toString("base64"),
  }
}

function decryptEmbeddedConfigFile(key: string, file: EmbeddedConfigFile) {
  if (file.version !== 1 || file.algorithm !== EMBEDDED_CONFIG_ALGORITHM) {
    throw new Error(`Unsupported embedded config bundle format: ${file.version}/${file.algorithm}`)
  }

  const decipher = createDecipheriv(
    file.algorithm,
    Buffer.from(key, "base64"),
    Buffer.from(file.iv, "base64"),
  )
  decipher.setAuthTag(Buffer.from(file.tag, "base64"))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(file.content, "base64")),
    decipher.final(),
  ])
  return gunzipSync(decrypted).toString("utf8")
}

function parseEmbeddedConfigDiskFile(text: string) {
  if (!isEmbeddedConfigDiskFileText(text)) return

  const value = JSON.parse(text.slice(EMBEDDED_CONFIG_FILE_PREFIX.length))
  if (!value || typeof value !== "object") {
    throw new Error("Invalid embedded config disk file payload")
  }
  if (
    value.version !== 1 ||
    value.algorithm !== EMBEDDED_CONFIG_ALGORITHM ||
    typeof value.iv !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.content !== "string"
  ) {
    throw new Error("Invalid embedded config disk file payload")
  }

  return value as EmbeddedConfigFile
}

function moduleImportFilePath(spec: string) {
  if (spec.startsWith("data:")) return
  if (spec.startsWith("file://")) return fileURLToPath(spec)
  if (spec.startsWith("/") || /^[A-Za-z]:[\\/]/.test(spec)) return spec
}