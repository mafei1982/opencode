import { Effect } from "effect"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { isLocalTcpProviderEnabled, loadLocalTcpServer } from "../../provider/sdk/local-tcp/local-tcp-provider"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs, { hostnameDefault: "0.0.0.0" }),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (!Flag.FLASHCODE_SERVER_PASSWORD) {
      console.log("Warning: FLASHCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)

    if (isLocalTcpProviderEnabled()) {
      console.log("Starting local llama.cpp server (first run may download it)...")
      yield* Effect.promise(() => loadLocalTcpServer())
      console.log("Local llama.cpp server is ready.")
    }

    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
