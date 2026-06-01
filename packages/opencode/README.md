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

Example `llm.env`:

```dotenv
LLM_PROVIDER=local
LLM_MODEL_PATH=unsloth/Qwen3.5-35B-A3B-GGUF:Q3_K_M
LLM_N_CTX=262144
LLM_FLASH_ATTENTION=true
LLM_INFERENCE_TIMEOUT=120
```

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
