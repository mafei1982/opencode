import path from "node:path"

import { inspectDesktopLicense } from "../src/main/license"

const licensePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined
const result = inspectDesktopLicense(licensePath ? { licensePath } : {})

console.log(
  JSON.stringify(
    {
      ...result,
      actual: {
        ...result.actual,
        nowNs: result.actual.nowNs.toString(),
      },
      license: result.license
        ? {
            ...result.license,
            expiresAtNs: result.license.expiresAtNs.toString(),
          }
        : undefined,
    },
    null,
    2,
  ),
)

process.exit(result.code === 0 ? 0 : 1)
