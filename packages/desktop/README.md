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
- bundles `llm.env` into `resources/llm.env` when `LLM_ENV_FILE` is provided, or when a local `llm.env` or `.env` file exists
- removes stale bundled `resources/llm.env` when no env file should be embedded
- encrypts embedded config text files from `FLASHCODE_EMBEDDED_CONFIG_DIR` before they are bundled into the desktop app
- skips embedded source `node_modules/`, `.gitignore`, `package.json`, and `package-lock.json`
- runs `../opencode/script/build-node.ts` so the sidecar/server bundle used by desktop is up to date

`build` then runs `electron-vite build`, which emits the desktop app output into `out/`.

## Package Flow

`bun run package` uses `electron-builder --config electron-builder.config.ts`.

The packager takes the build output and produces installable artifacts in `dist/`.
Current Windows output is an NSIS installer:

```bash
dist/flashcode-desktop-win-x64.exe
```

The builder config currently does all of the following:

- reads `out/**/*` and `resources/**/*`
- bundles `resources/llm.env` into the packaged app when present
- optionally bundles the pinned Windows llama.cpp server from `packages/opencode/dist/node/llama-cpp-server` when `add_llama_cpp_server=true`
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

## FlashCode Embedded Build

For the FlashCode desktop build, three environment variables matter:

- `FLASHCODE_EMBEDDED_CONFIG_DIR`: points at the config directory that should be embedded into the packaged app during build
- `FLASHCODE_TOOLS_DIR`: points at the tools directory copied into `resources/tools/`
- `add_llama_cpp_server`: when `true`, reuses or downloads the pinned Windows llama.cpp server in the app cache during prebuild, then packages it into `resources/llama-cpp-server/`; defaults to not bundling it
- `FLASHCODE_SHOW_DEFAULT_AGENTS`: optional boolean override for the built-in `build` and `plan` agents. Accepts `true/false`, `1/0`, `yes/no`, or `on/off`.

Legacy compatibility is still supported for `NI_CIC_TOOLS_DIR`.

Typical Windows packaging command:

```powershell
$Env:FLASHCODE_EMBEDDED_CONFIG_DIR = "D:\dev\fma\teststand-opencode-skill\.flashcode"
$Env:FLASHCODE_TOOLS_DIR = "D:\dev\fma\teststand-opencode-skill\.flashcode\tools"
bun run build
bun run package
```

This produces a desktop app that contains:

- the desktop Electron build output
- embedded OpenCode config from `.flashcode`
- bundled NI CIC tools from `.flashcode/tools`
- optional local-LLM env config from `llm.env`, `.env`, or `LLM_ENV_FILE`
- optional llama.cpp server binaries when `add_llama_cpp_server=true`

When `FLASHCODE_SHOW_DEFAULT_AGENTS` is unset, desktop builds that embed config hide the built-in `build` and `plan` agents by default if the embedded config provides at least one visible primary or `all` custom agent. If the variable is set, it fully controls the visibility of those two built-in agents.
Packaged desktop runs also rewrite `FLASHCODE_TOOLS_DIR` to the bundled `resources/tools` directory when that directory exists.

## Runtime Logic For Embedded Config

At runtime the desktop sidecar does the following:

1. loads bundled `llm.env` from the app resources directory when present
2. auto-sets `LLM_MODEL_DIR` to the running app directory's `models/` folder if it is not already set
3. extracts the embedded config payload into a temporary directory as encrypted files
4. sets `FLASHCODE_EMBEDDED_CONFIG_DIR` to that extracted directory
5. transparently decrypts embedded config files when loading config, agents, skills, commands, tools, and plugins
6. sets `FLASHCODE_REFERENCES_DIR` when the extracted config contains a `references/` folder
7. sets `FLASHCODE_TOOLS_DIR` to the bundled app tools directory when `resources/tools` exists
8. starts the embedded OpenCode server
9. if `LLM_PROVIDER=local_tcp`, starts the local TCP llama.cpp server in the background

Legacy compatibility is still supported for `NI_CIC_REFERENCES_DIR`.

Built-in `build` and `plan` visibility is resolved at runtime from `FLASHCODE_SHOW_DEFAULT_AGENTS` first. If that env var is absent, the desktop client auto-hides them only for embedded-config desktop runs that ship a visible custom primary agent. Non-desktop clients keep showing them by default.

Because the embedded config is extracted to a temp directory at runtime, agent prompts and config should not hardcode source-repo paths. Use environment-backed references such as:

```text
{env:FLASHCODE_REFERENCES_DIR}\dsl-graph-schema.json
```

instead of assuming the runtime path is still `.flashcode\references\...`.

Apply the same rule to bundled executables. For example:

```text
{env:FLASHCODE_TOOLS_DIR}\semantic-lint\bin\semantic-lint.exe
```

instead of `.opencode\tools\semantic-lint\bin\semantic-lint.exe`.

## Useful Environment Variables

- `OPENCODE_CHANNEL`: `dev`, `beta`, or `prod`; changes app id, product name, and publish target
- `LLM_ENV_FILE`: path to a `.env` file to bundle as `resources/llm.env`
- local `llm.env` or `.env`: fallback sources bundled into `resources/llm.env` when `LLM_ENV_FILE` is not set
- `LLM_PROVIDER`: when set to `local_tcp`, the sidecar starts the local TCP llama.cpp provider after startup
- `LLM_TCP_SERVER_PATH`: optional path to a user-provided `llama-server.exe`; when unset, `local_tcp` uses the packaged server if present, then falls back to the downloaded cache
- `LLM_MODEL_DIR`: overrides where local GGUF models are stored; defaults to the running app directory's `models/` folder when unset
- `add_llama_cpp_server`: build-time flag that copies the pinned Windows llama.cpp server from the app cache into `resources/llama-cpp-server/`; defaults to `false`, so first `local_tcp` runtime downloads the server on demand
- `FLASHCODE_EMBEDDED_CONFIG_DIR`: canonical embedded-config env var. During build it points at the source config directory to embed; at runtime the sidecar rewrites it to the extracted encrypted config directory.
- `FLASHCODE_TOOLS_DIR`: bundles extra tools into the packaged app at build time and is rewritten to the packaged `resources/tools` directory at runtime when available
- `FLASHCODE_SHOW_DEFAULT_AGENTS`: when set, explicitly shows or hides the built-in `build` and `plan` agents regardless of agent `hidden` overrides in config.

## Bundled llm.env Defaults

The desktop package currently ships with the following `llm.env` template in both `llm.env` and `resources/llm.env`:

```dotenv
LLM_PROVIDER=local_tcp
LLM_DISABLE_NON_LOCAL_PROVIDERS=true
OPENCODE_DEFAULT_THEME=ni
OPENCODE_SHOW_SETTINGS=false
SHOW_MODELS=true
LLM_MODEL_PATH=Jackrong/Qwopus3.6-27B-v2-MTP-GGUF:Q4_K_M
LLM_N_CTX=262144
LLM_N_GPU_LAYERS=65
LLM_MAX_THREADS=7
LLM_BATCH_SIZE=512
LLM_MAX_CONCURRENCY=1
LLM_KV_UNIFIED=true
LLM_CACHE_RAM=8192
LLM_CTX_CHECKPOINTS=32
LLM_CHECKPOINT_MIN_STEP=256
LLM_SPEC_TYPE=draft-mtp
LLM_SPEC_DRAFT_N_MAX=2
LLM_SPEC_DRAFT_N_MIN=0
LLM_SPEC_DRAFT_P_MIN=0.00
LLM_N_GPU_LAYERS_DRAFT=all
LLM_SPEC_DRAFT_TYPE_K=f16
LLM_SPEC_DRAFT_TYPE_V=f16
LLM_FLASH_ATTENTION=true
LLM_USE_MMAP=true
LLM_USE_MLOCK=true
LLM_TEMPERATURE=0.8
LLM_TOP_P=0.95
LLM_TOP_K=40
LLM_MIN_P=0.5
LLM_CACHE_TYPE_K=q8_0
LLM_CACHE_TYPE_V=q8_0
LLM_INFERENCE_TIMEOUT=0
LLM_REPEAT_PENALTY=1.1
LLM_REPEAT_LAST_N=1024
LLM_PARALLEL_N=1
```

Key behaviors controlled by those values:

- `LLM_PROVIDER=local_tcp`: starts the desktop build against the local TCP llama.cpp provider. Packaged apps use `resources/llama-cpp-server` when built with `add_llama_cpp_server=true`; otherwise the server is downloaded on first use and cached under the user's app cache directory.
- `LLM_DISABLE_NON_LOCAL_PROVIDERS=true`: when the provider is `local` or `local_tcp`, non-local providers are disabled by default; set this to `false` to re-enable other providers.
- `OPENCODE_DEFAULT_THEME=ni`: forces the desktop UI theme to `ni` while this key is present; remove or leave it unset to fall back to the user's saved theme.
- `OPENCODE_SHOW_SETTINGS=false`: hides the settings button and settings entry points by default; set it to `true` to show them again.
- `SHOW_MODELS=true`: keeps the model picker and variant selector visible beneath the chat input; set it to `false` to hide them.
- `LLM_MODEL_PATH`: selects the default bundled GGUF model identifier.
- `LLM_N_CTX`, `LLM_N_GPU_LAYERS`, `LLM_MAX_THREADS`, `LLM_BATCH_SIZE`, `LLM_MAX_CONCURRENCY`, `LLM_PARALLEL_N`: control llama.cpp context size, GPU offload, threading, batching, and concurrency.
- `LLM_KV_UNIFIED`, `LLM_CACHE_RAM`, `LLM_CTX_CHECKPOINTS`, `LLM_CHECKPOINT_MIN_STEP`: configure llama.cpp server-side KV sharing, cache budget, and prompt checkpoint retention behavior.
- `LLM_SPEC_TYPE`, `LLM_SPEC_DRAFT_N_MAX`, `LLM_SPEC_DRAFT_N_MIN`, `LLM_SPEC_DRAFT_P_MIN`, `LLM_N_GPU_LAYERS_DRAFT`, `LLM_SPEC_DRAFT_TYPE_K`, `LLM_SPEC_DRAFT_TYPE_V`: configure llama.cpp speculative decoding, including the draft mode, token budget, minimum draft acceptance probability, draft GPU offload, and draft KV cache types.
- `LLM_SPLIT_MODE`: optional llama.cpp multi-GPU split strategy override (`none`, `layer`, `row`, `tensor`). Leave it unset unless you explicitly want to override the bundled server default.
- `LLM_FLASH_ATTENTION`, `LLM_USE_MMAP`, `LLM_USE_MLOCK`: control llama.cpp runtime memory and attention optimizations.
- `LLM_TEMPERATURE`, `LLM_TOP_P`, `LLM_TOP_K`, `LLM_MIN_P`, `LLM_REPEAT_PENALTY`, `LLM_REPEAT_LAST_N`: sampling defaults chosen to avoid greedy repetition loops on reasoning models.
- `LLM_CACHE_TYPE_K`, `LLM_CACHE_TYPE_V`: configure the KV cache quantization mode.
- `LLM_INFERENCE_TIMEOUT=0`: disables inference timeout.

If you want to change the packaged desktop defaults, edit `packages/desktop/llm.env` before building. The `prebuild` step copies that file into `resources/llm.env` for packaging.

## Troubleshooting

- If packaging fails with `Access is denied` under `dist/win-unpacked`, close the running packaged app and remove `dist/win-unpacked` before retrying.
- If the app starts without local LLM settings, verify that `resources/llm.env` was produced during `prebuild`.
- If the first `local_tcp` startup cannot download the llama.cpp server, set `LLM_TCP_SERVER_PATH` to a local `llama-server.exe` or rebuild with `add_llama_cpp_server=true`.
- If embedded agents cannot resolve reference files, confirm the prompt uses `{env:FLASHCODE_REFERENCES_DIR}` instead of hardcoded `.flashcode` paths.
