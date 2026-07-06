import { onMount, onCleanup, createEffect } from "solid-js"
import { useTheme } from "@opencode-ai/ui/theme"
import * as monaco from "monaco-editor"

// Configure Monaco workers
self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "json") {
      return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), {
        type: "module",
      })
    }
    if (label === "css" || label === "scss" || label === "less") {
      return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), {
        type: "module",
      })
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), {
        type: "module",
      })
    }
    if (label === "typescript" || label === "javascript") {
      return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), {
        type: "module",
      })
    }
    return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" })
  },
}

const extToLanguage: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  toml: "ini",
  ini: "ini",
  lua: "lua",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  r: "r",
  vue: "html",
  svelte: "html",
  dockerfile: "dockerfile",
  makefile: "makefile",
}

function languageFromPath(filePath: string): string {
  const name = filePath.split("/").pop() ?? filePath
  const lower = name.toLowerCase()
  if (lower === "dockerfile") return "dockerfile"
  if (lower === "makefile") return "makefile"
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return extToLanguage[ext] ?? "plaintext"
}

export function MonacoEditor(props: {
  path: string
  content: string
  onSave?: (content: string) => void
  onDirty?: (dirty: boolean) => void
}) {
  let container!: HTMLDivElement
  let editor: monaco.editor.IStandaloneCodeEditor | undefined
  let initialContent = props.content
  let lastExternalContent = props.content
  const theme = useTheme()

  onMount(() => {
    const lang = languageFromPath(props.path)
    const monacoTheme = theme.mode() === "dark" ? "vs-dark" : "vs"

    editor = monaco.editor.create(container, {
      value: props.content,
      language: lang,
      theme: monacoTheme,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      wordWrap: "on",
      tabSize: 2,
      renderWhitespace: "selection",
      smoothScrolling: true,
      cursorBlinking: "smooth",
      padding: { top: 8 },
    })

    editor.addAction({
      id: "opencode-save",
      label: "Save File",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        if (!editor) return
        props.onSave?.(editor.getValue())
        initialContent = editor.getValue()
        props.onDirty?.(false)
      },
    })

    editor.onDidChangeModelContent(() => {
      if (!editor) return
      props.onDirty?.(editor.getValue() !== initialContent)
    })
  })

  createEffect(() => {
    const monacoTheme = theme.mode() === "dark" ? "vs-dark" : "vs"
    monaco.editor.setTheme(monacoTheme)
  })

  createEffect(() => {
    const content = props.content
    if (!editor) return
    if (content === lastExternalContent) return
    lastExternalContent = content
    const current = editor.getValue()
    const isDirty = current !== initialContent
    if (!isDirty) {
      initialContent = content
      editor.setValue(content)
      props.onDirty?.(false)
      return
    }
    if (content === current) return
    const reload = window.confirm(
      "This file has been modified externally. Reload the file? (OK = reload, Cancel = keep your changes)",
    )
    if (reload) {
      initialContent = content
      editor.setValue(content)
      props.onDirty?.(false)
    }
  })

  onCleanup(() => {
    editor?.dispose()
    editor = undefined
  })

  return <div ref={container} class="size-full" data-prevent-autofocus />
}
