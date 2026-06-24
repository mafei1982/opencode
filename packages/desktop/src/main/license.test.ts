import { describe, expect, test } from "bun:test"
import { createCipheriv, createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { checkDesktopLicense, getDefaultLicensePath, LICENSE_STATUS, type LicenseSnapshot } from "./license"

const LICENSE_KEY = "`N!I@C#C$S%M^E&T*A(L)I_C=E-N+S,E.K<E>Y?"
const LICENSE_HASH = createHash("sha256").update(LICENSE_KEY).digest()
const AES_KEY = LICENSE_HASH.subarray(0, 16)
const AES_IV = LICENSE_HASH.subarray(16)

const snapshot: LicenseSnapshot = {
  platformCode: 11,
  nowNs: 1_800_000_000_000_000_000n,
  machineId: "machine-id_ccs_machine_id",
  pxieSerial: "PXIE-SERIAL_ccs_pxie_serial",
  osDiskSize: "123456789_bytes_OS_disk",
  rdmaMac: "AABBCCDDEEFF0000_ccs_mac",
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flashcode-license-"))
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest()
}

function encryptLicense(payload: Buffer) {
  const paddingSize = 16 - (payload.length % 16) || 16
  const padded = Buffer.concat([payload, Buffer.alloc(paddingSize, paddingSize)])
  const cipher = createCipheriv("aes-128-cbc", AES_KEY, AES_IV)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()])
}

function buildLicense(version: 1 | 2 | 3, overrides: Partial<LicenseSnapshot> = {}, expiresAt = snapshot.nowNs + 60_000_000_000n) {
  const current = { ...snapshot, ...overrides }
  const payload = Buffer.alloc(256)
  payload.writeUInt8(version, 0)
  payload.writeUInt8(current.platformCode, 1)
  payload.writeBigUInt64LE(expiresAt, 2)
  sha256(current.pxieSerial).copy(payload, 10)
  if (version >= 2) sha256(current.osDiskSize).copy(payload, 42)
  if (version >= 3) sha256(current.rdmaMac).copy(payload, 74)
  return encryptLicense(payload)
}

describe("license", () => {
  test("checks the default packaged license path", async () => {
    await withTempDir(async (dir) => {
      const exePath = path.join(dir, "FlashCode.exe")
      const licensePath = getDefaultLicensePath({ exePath, username: "alice" })
      await fs.writeFile(licensePath, buildLicense(3))

      expect(checkDesktopLicense({ exePath, username: "alice", snapshot })).toEqual({
        code: LICENSE_STATUS.PASS,
        path: licensePath,
      })
    })
  })

  test("returns expire for an expired license", async () => {
    await withTempDir(async (dir) => {
      const licensePath = path.join(dir, "expired.lic")
      await fs.writeFile(licensePath, buildLicense(3, {}, snapshot.nowNs - 1n))

      expect(checkDesktopLicense({ licensePath, snapshot })).toEqual({
        code: LICENSE_STATUS.EXPIRE,
        path: licensePath,
      })
    })
  })

  test("returns corrupt when the license file is missing", async () => {
    await withTempDir(async (dir) => {
      const licensePath = path.join(dir, "missing.lic")

      expect(checkDesktopLicense({ licensePath, snapshot })).toEqual({
        code: LICENSE_STATUS.CORRUPT,
        path: licensePath,
      })
    })
  })
})