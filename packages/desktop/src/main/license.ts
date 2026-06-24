import { spawnSync } from "node:child_process"
import { createDecipheriv, createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { userInfo } from "node:os"
import path from "node:path"

export const LICENSE_STATUS = {
  PASS: 0,
  CORRUPT: -5000,
  EXPIRE: -5001,
  UNKNOWN_VER: -5002,
  MISMATCH_OS: -5003,
  MISMATCH_ID: -5004,
  MISMATCH_HW_A: -5005,
  MISMATCH_HW_B: -5006,
} as const

const LICENSE_KEY = "`N!I@C#C$S%M^E&T*A(L)I_C=E-N+S,E.K<E>Y?"
const LICENSE_PAYLOAD_SIZE = 256
const AES_BLOCK_SIZE = 16
const RDMA_FALLBACK = 0xFF1AFF2BFF3CFF4Dn
const LICENSE_KEY_HASH = createHash("sha256").update(LICENSE_KEY).digest()
const LICENSE_AES_KEY = LICENSE_KEY_HASH.subarray(0, AES_BLOCK_SIZE)
const LICENSE_AES_IV = LICENSE_KEY_HASH.subarray(AES_BLOCK_SIZE)

export type LicenseSnapshot = {
  platformCode: number
  nowNs: bigint
  machineId: string
  pxieSerial: string
  osDiskSize: string
  rdmaMac: string
}

export type LicenseCheckOptions = {
  licensePath?: string
  exePath?: string
  username?: string
  snapshot?: Partial<LicenseSnapshot>
}

export type LicenseCheckResult = {
  code: number
  path: string
}

export function getDefaultLicensePath(options: Pick<LicenseCheckOptions, "exePath" | "username"> = {}) {
  return path.join(path.dirname(options.exePath ?? process.execPath), `license_${options.username ?? getUsername()}.lic`)
}

export function checkDesktopLicense(options: LicenseCheckOptions = {}): LicenseCheckResult {
  const licensePath = options.licensePath ?? getDefaultLicensePath(options)
  const encrypted = readBinaryFile(licensePath)
  if (!encrypted) return { code: LICENSE_STATUS.CORRUPT, path: licensePath }

  const decrypted = decryptLicense(encrypted)
  if (!decrypted || decrypted.length !== LICENSE_PAYLOAD_SIZE) {
    return { code: LICENSE_STATUS.CORRUPT, path: licensePath }
  }

  const version = decrypted.readUInt8(0)
  if (version < 1 || version > 3) {
    return { code: LICENSE_STATUS.UNKNOWN_VER, path: licensePath }
  }

  const v1Result = checkV1(decrypted, options.snapshot)
  if (v1Result !== LICENSE_STATUS.PASS) return { code: v1Result, path: licensePath }

  if (version >= 2) {
    const v2Result = checkV2(decrypted, options.snapshot)
    if (v2Result !== LICENSE_STATUS.PASS) return { code: v2Result, path: licensePath }
  }

  if (version >= 3) {
    const v3Result = checkV3(decrypted, options.snapshot)
    if (v3Result !== LICENSE_STATUS.PASS) return { code: v3Result, path: licensePath }
  }

  return { code: LICENSE_STATUS.PASS, path: licensePath }
}

export function describeLicenseFailure(result: LicenseCheckResult) {
  const reason = (() => {
    switch (result.code) {
      case LICENSE_STATUS.CORRUPT:
        return "License file is missing or invalid."
      case LICENSE_STATUS.EXPIRE:
        return "License has expired."
      case LICENSE_STATUS.UNKNOWN_VER:
        return "License version is not supported."
      case LICENSE_STATUS.MISMATCH_OS:
        return "License does not match this operating system."
      case LICENSE_STATUS.MISMATCH_ID:
        return "License does not match this machine."
      case LICENSE_STATUS.MISMATCH_HW_A:
        return "License does not match the OS disk."
      case LICENSE_STATUS.MISMATCH_HW_B:
        return "License does not match the RDMA adapter."
      default:
        return "License validation failed."
    }
  })()

  return `${reason}\n\nExpected license file:\n${result.path}\n\nError code: ${result.code}`
}

function checkV1(decrypted: Buffer, snapshot?: Partial<LicenseSnapshot>) {
  if (decrypted.readUInt8(1) !== (snapshot?.platformCode ?? getPlatformCode())) {
    return LICENSE_STATUS.MISMATCH_OS
  }

  if ((snapshot?.nowNs ?? getCurrentTimeNs()) > decrypted.readBigUInt64LE(2)) {
    return LICENSE_STATUS.EXPIRE
  }

  const expected = decrypted.subarray(10, 42)
  const pxieSerial = snapshot?.pxieSerial ?? getPXIeSerial()
  if (pxieSerial && sha256(pxieSerial).equals(expected)) {
    return LICENSE_STATUS.PASS
  }

  if (sha256(snapshot?.machineId ?? getMachineId()).equals(expected)) {
    return LICENSE_STATUS.PASS
  }

  return LICENSE_STATUS.MISMATCH_ID
}

function checkV2(decrypted: Buffer, snapshot?: Partial<LicenseSnapshot>) {
  if (sha256(snapshot?.osDiskSize ?? getOSDiskSize()).equals(decrypted.subarray(42, 74))) {
    return LICENSE_STATUS.PASS
  }

  return LICENSE_STATUS.MISMATCH_HW_A
}

function checkV3(decrypted: Buffer, snapshot?: Partial<LicenseSnapshot>) {
  if (sha256(snapshot?.rdmaMac ?? getRdmaMac()).equals(decrypted.subarray(74, 106))) {
    return LICENSE_STATUS.PASS
  }

  return LICENSE_STATUS.MISMATCH_HW_B
}

function getPlatformCode() {
  if (process.platform === "win32") return 11
  if (process.platform === "linux") return 22
  if (process.platform === "darwin") return 33
  return -1
}

function getCurrentTimeNs() {
  return BigInt(Date.now()) * 1_000_000n
}

function getUsername() {
  if (process.platform === "win32") return process.env.USERNAME ?? readUserInfo()
  return process.env.USER ?? readUserInfo()
}

function readUserInfo() {
  try {
    return userInfo().username
  } catch {
    return "unknown"
  }
}

function readBinaryFile(filePath: string) {
  if (!existsSync(filePath)) return null

  try {
    return readFileSync(filePath)
  } catch {
    return null
  }
}

function readTextFile(filePath: string) {
  if (!existsSync(filePath)) return null

  try {
    return readFileSync(filePath, "utf8")
  } catch {
    return null
  }
}

function decryptLicense(encrypted: Buffer) {
  if (encrypted.length === 0 || encrypted.length % AES_BLOCK_SIZE !== 0) return null

  try {
    const decipher = createDecipheriv("aes-128-cbc", LICENSE_AES_KEY, LICENSE_AES_IV)
    decipher.setAutoPadding(false)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
    const paddingSize = decrypted.at(-1) ?? 0
    if (paddingSize <= 0 || paddingSize > AES_BLOCK_SIZE || paddingSize >= decrypted.length) {
      return null
    }

    return decrypted.subarray(0, decrypted.length - paddingSize)
  } catch {
    return null
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest()
}

function getMachineId() {
  if (process.platform === "win32") {
    const result = spawnSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
      encoding: "utf8",
      windowsHide: true,
    })
    const match = result.status === 0 ? result.stdout.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i) : null
    return `${match?.[1]?.trim() || "Unknown Platform"}_ccs_machine_id`
  }

  if (process.platform === "linux") {
    return `${readFirstLine("/etc/machine-id") ?? readFirstLine("/var/lib/dbus/machine-id") ?? "Unknown Platform"}_ccs_machine_id`
  }

  if (process.platform === "darwin") {
    const result = spawnSync("sysctl", ["-n", "hw.uuid"], { encoding: "utf8" })
    return `${result.status === 0 ? result.stdout.trim() || "Unknown Platform" : "Unknown Platform"}_ccs_machine_id`
  }

  return "Unknown Platform_ccs_machine_id"
}

function getPXIeSerial() {
  if (process.platform === "win32") {
    const serial = readIniValue("C:\\Windows\\pxiesys.ini", "Chassis1Slot1", "SerialNumber")
    return serial ? `${serial}_ccs_pxie_serial` : ""
  }

  if (process.platform === "linux") {
    const serial = readIniValue("/etc/pxiesys.ini", "Chassis1Slot1", "SerialNumber")
    return serial ? `${serial}_ccs_pxie_serial` : ""
  }

  return ""
}

function readIniValue(filePath: string, section: string, key: string) {
  const content = readTextFile(filePath)
  if (!content) return ""

  let inSection = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === `[${section}]`) {
      inSection = true
      continue
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inSection = false
      continue
    }
    if (!inSection) continue

    const split = line.indexOf("=")
    if (split === -1) continue
    if (line.slice(0, split).trim() !== key) continue
    return line.slice(split + 1).trim()
  }

  return ""
}

function readFirstLine(filePath: string) {
  const content = readTextFile(filePath)
  if (!content) return null

  const [line] = content.split(/\r?\n/)
  return line?.trim() || null
}

function getOSDiskSize() {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        [
          "$ErrorActionPreference = 'Stop'",
          "$disk = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='$env:SystemDrive'\" | Get-CimAssociatedInstance -ResultClassName Win32_DiskPartition | Select-Object -First 1 | Get-CimAssociatedInstance -ResultClassName Win32_DiskDrive | Select-Object -First 1 -ExpandProperty Size",
          "if ($disk) { [Console]::Write($disk) }",
        ].join("; "),
      ],
      { encoding: "utf8", windowsHide: true },
    )
    return `${parseUnsignedBigInt(result.status === 0 ? result.stdout : "")}_bytes_OS_disk`
  }

  if (process.platform === "linux") {
    const rootDevice = readRootDevice()
    if (!rootDevice) return "0_bytes_OS_disk"

    const sysBlockPath = resolveLinuxDiskSysBlock(rootDevice)
    if (!sysBlockPath) return "0_bytes_OS_disk"

    const sectors = parseUnsignedBigInt(readTextFile(path.join(sysBlockPath, "size")) ?? "")
    return `${sectors * 512n}_bytes_OS_disk`
  }

  return "0_bytes_OS_disk"
}

function readRootDevice() {
  const mounts = readTextFile("/proc/mounts")
  if (!mounts) return ""

  for (const line of mounts.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields[1] === "/") {
      return fields[0] ?? ""
    }
  }

  return ""
}

function resolveLinuxDiskSysBlock(rootDevice: string) {
  const devicePath = safeRealPath(rootDevice) ?? rootDevice
  const blockPath = safeRealPath(path.join("/sys/class/block", path.basename(devicePath)))
  if (!blockPath) return ""

  let current = blockPath.includes("/virtual/block/") ? resolveLinuxVirtualBlock(blockPath) : blockPath
  while (current) {
    const sysBlockPath = path.join("/sys/class/block", path.basename(current))
    if (existsSync(path.join(sysBlockPath, "device")) && !existsSync(path.join(sysBlockPath, "partition"))) {
      return sysBlockPath
    }

    const parent = path.dirname(current)
    if (parent === current) return ""
    current = parent
  }

  return ""
}

function resolveLinuxVirtualBlock(blockPath: string) {
  const slavesPath = path.join(blockPath, "slaves")
  try {
    const [first] = readdirSync(slavesPath)
    if (!first) return blockPath
    return safeRealPath(path.join(slavesPath, first)) ?? blockPath
  } catch {
    return blockPath
  }
}

function safeRealPath(target: string) {
  try {
    return realpathSync(target)
  } catch {
    return null
  }
}

function getRdmaMac() {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        [
          "$ErrorActionPreference = 'Stop'",
          "Get-NetAdapter | Where-Object { $_.InterfaceDescription -like 'Mellanox*' } | ForEach-Object { [Console]::WriteLine($_.MacAddress) }",
        ].join("; "),
      ],
      { encoding: "utf8", windowsHide: true },
    )
    return formatRdmaMac(parseMacLines(result.status === 0 ? result.stdout : ""), true)
  }

  if (process.platform === "linux") {
    try {
      const matches = readdirSync("/sys/class/net").flatMap((name) => {
        const vendor = readTextFile(path.join("/sys/class/net", name, "device", "vendor"))?.trim().toLowerCase()
        if (vendor !== "0x15b3") return []
        const mac = readTextFile(path.join("/sys/class/net", name, "address"))?.trim()
        return mac ? [mac] : []
      })
      return formatRdmaMac(matches, true)
    } catch {
      return formatRdmaMac([], true)
    }
  }

  return ""
}

function parseMacLines(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => Boolean(line))
}

function formatRdmaMac(macAddresses: string[], useFallback: boolean) {
  if (macAddresses.length === 0) {
    return useFallback ? `${toLittleEndianHex(RDMA_FALLBACK)}_ccs_mac` : ""
  }

  const total = macAddresses.reduce((sum, mac) => (sum + parseMacAddress(mac)) & 0xFFFF_FFFF_FFFF_FFFFn, 0n)
  return `${toLittleEndianHex(total)}_ccs_mac`
}

function parseMacAddress(mac: string) {
  const bytes = Buffer.alloc(8)
  const parts = mac.split(/[:-]/).filter((part) => Boolean(part))
  for (let index = 0; index < Math.min(parts.length, bytes.length); index += 1) {
    bytes[index] = Number.parseInt(parts[index]!, 16) || 0
  }

  let value = 0n
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index] ?? 0)
  }
  return value
}

function toLittleEndianHex(value: bigint) {
  const normalized = value & 0xFFFF_FFFF_FFFF_FFFFn
  return Buffer.from(Array.from({ length: 8 }, (_unused, index) => Number((normalized >> BigInt(index * 8)) & 0xFFn)))
    .toString("hex")
    .toUpperCase()
}

function parseUnsignedBigInt(value: string) {
  const normalized = value.trim()
  if (!normalized) return 0n

  try {
    return BigInt(normalized)
  } catch {
    return 0n
  }
}