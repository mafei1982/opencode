# OpenCode

The `packages/opencode` package contains the standalone OpenCode CLI and headless server.

## Install

```bash
bun install
```

## Common Commands

Run from `packages/opencode`:

```bash
bun run build
bun run dev
```

If you want to run the CLI entrypoint directly during development:

```bash
bun run --conditions=browser ./src/index.ts serve
```

## Standalone Server

The standalone web server is started through the normal CLI entrypoint, so env-file loading happens before `serve`, `web`, `acp`, and other commands execute.

Example:

```bash
opencode serve
```

or in local development:

```bash
bun run --conditions=browser ./src/index.ts serve
```

## Env File Loading

When OpenCode starts from the standalone CLI, it loads env files in this order:

1. `OPENCODE_ENV_FILE`
2. `LLM_ENV_FILE`
3. `.env` in the current working directory
4. `llm.env` in the current working directory

Existing process environment variables take precedence and are not overwritten by values from these files.

That means you can start the standalone server with either a general `.env` file or a dedicated `llm.env` file in `packages/opencode` or your current launch directory.

Example `.env`:

```dotenv
LLM_PROVIDER=local_tcp
LLM_MODEL_PATH=Jackrong/Qwopus3.6-27B-v2-MTP-GGUF:Q4_K_M
LLM_N_CTX=262144
LLM_N_GPU_LAYERS=65
LLM_MAX_THREADS=7
LLM_BATCH_SIZE=512
LLM_MAX_CONCURRENCY=1
LLM_FLASH_ATTENTION=true
LLM_USE_MMAP=true
LLM_USE_MLOCK=true
# Sampling: reasoning models can loop when decoding is too greedy. Use
# Qwen-style thinking-model defaults.
LLM_TEMPERATURE=0.8
LLM_TOP_P=0.95
LLM_TOP_K=40
LLM_MIN_P=0.5
LLM_CACHE_TYPE_K=q8_0
LLM_CACHE_TYPE_V=q8_0
LLM_INFERENCE_TIMEOUT=0
LLM_REPEAT_PENALTY=1.1
```

For `LLM_PROVIDER=local_tcp`, OpenCode starts a local llama.cpp server. It first uses `LLM_TCP_SERVER_PATH` when set, then checks packaged/build-time locations, and on Windows x64 downloads the pinned llama.cpp server on first use if it is missing. The server is cached under the user's app cache directory and reused on later starts.

Then start the standalone server:

```bash
opencode serve
```

or:

```bash
bun run --conditions=browser ./src/index.ts serve
```

## Using A Custom Env File

If you do not want to rely on the current working directory, point OpenCode at a specific file:

```powershell
$Env:OPENCODE_ENV_FILE = "D:\dev\fma\opencode\packages\opencode\llm.env"
opencode serve
```

You can also keep using `LLM_ENV_FILE`:

```powershell
$Env:LLM_ENV_FILE = "D:\dev\fma\opencode\packages\opencode\llm.env"
opencode serve
```

## Notes

- Desktop packaging uses its own bundled `resources/llm.env` flow.
- Standalone CLI/server startup does not need the desktop packaging path; it now reads env files directly at process start.
- If both shell env vars and `.env` define the same key, the shell env var wins.
