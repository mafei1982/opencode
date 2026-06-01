# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

## Scripts

- `bun run dev`: run the Electron app in development mode
- `bun run build`: build renderer, main, and preload output with `electron-vite`
- `bun run package`: package the current build with `electron-builder`
- `bun run package:win`: build the Windows installer only
- `bun run package:mac`: build the macOS artifacts only
- `bun run package:linux`: build the Linux artifacts only

## Build Flow

`bun run build` runs in two phases:

1. `prebuild`
2. `build`

`prebuild` does the preparation work that the packager depends on:

- copies channel-specific icons
- bundles `llm.env` into `resources/llm.env` when `LLM_ENV_FILE` is provided, or when a local `llm.env` file exists
- removes stale bundled `resources/llm.env` when no env file should be embedded
- runs `../opencode/script/build-node.ts` so the sidecar/server bundle used by desktop is up to date

`build` then runs `electron-vite build`, which emits the desktop app output into `out/`.

## Package Flow

`bun run package` uses `electron-builder --config electron-builder.config.ts`.

The packager takes the build output and produces installable artifacts in `dist/`.
Current Windows output is an NSIS installer:

```bash
dist/ni-cic-code-desktop-win-x64.exe
```

The builder config currently does all of the following:

- reads `out/**/*` and `resources/**/*`
- bundles `resources/llm.env` into the packaged app when present
- optionally bundles tools from `NI_CIC_TOOLS_DIR` into `resources/tools/`
- selects product name, app id, and publish target from `OPENCODE_CHANNEL`
- signs Windows binaries in CI through `script/sign-windows.ps1`

## Standard Local Build

Run these commands from `packages/desktop`:

```powershell
bun install
bun run build
bun run package
```

If you only want the Windows installer:

```powershell
bun run build
bun run package:win
```

## NI CIC Embedded Build

For the NI CIC desktop build, two environment variables matter:

- `OPENCODE_EMBED_CONFIG_DIR`: points at the config directory that should be embedded into the packaged app
- `NI_CIC_TOOLS_DIR`: points at the tools directory copied into `resources/tools/`

Typical Windows packaging command:

```powershell
$Env:OPENCODE_EMBED_CONFIG_DIR = "D:\dev\fma\teststand-opencode-skill\.opencode"
$Env:NI_CIC_TOOLS_DIR = "D:\dev\fma\teststand-opencode-skill\.opencode\tools"
bun run build
bun run package
```

This produces a desktop app that contains:

- the desktop Electron build output
- embedded OpenCode config from `.opencode`
- bundled NI CIC tools from `.opencode/tools`
- optional local-LLM env config from `llm.env` or `LLM_ENV_FILE`

## Runtime Logic For Embedded Config

At runtime the desktop sidecar does the following:

1. loads bundled `llm.env` from the app resources directory when present
2. auto-sets `LLM_MODEL_DIR` if it is not already set
3. extracts the embedded config payload into a temporary directory
4. sets `OPENCODE_EMBEDDED_CONFIG_DIR` to that extracted directory
5. sets `NI_CIC_REFERENCES_DIR` when the extracted config contains a `references/` folder
6. starts the embedded OpenCode server
7. if `LLM_PROVIDER=local`, begins local model loading in the background

Because the embedded config is extracted to a temp directory at runtime, agent prompts and config should not hardcode source-repo paths. Use environment-backed references such as:

```text
{env:NI_CIC_REFERENCES_DIR}\dsl-graph-schema.json
```

instead of assuming the runtime path is still `.opencode\references\...`.

## Useful Environment Variables

- `OPENCODE_CHANNEL`: `dev`, `beta`, or `prod`; changes app id, product name, and publish target
- `LLM_ENV_FILE`: path to a `.env` file to bundle as `resources/llm.env`
- `LLM_PROVIDER`: when set to `local`, the sidecar preloads the local llama.cpp model after startup
- `LLM_MODEL_DIR`: overrides where local GGUF models are stored
- `OPENCODE_EMBED_CONFIG_DIR`: embeds a config directory into the desktop build
- `NI_CIC_TOOLS_DIR`: bundles extra tools into the packaged app

## Troubleshooting

- If packaging fails with `Access is denied` under `dist/win-unpacked`, close the running packaged app and remove `dist/win-unpacked` before retrying.
- If the app starts without local LLM settings, verify that `resources/llm.env` was produced during `prebuild`.
- If embedded agents cannot resolve reference files, confirm the prompt uses `{env:NI_CIC_REFERENCES_DIR}` instead of hardcoded `.opencode` paths.
