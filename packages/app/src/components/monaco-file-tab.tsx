import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Markdown } from "@opencode-ai/ui/markdown"
import { showToast } from "@opencode-ai/ui/toast"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { MonacoEditor } from "@/components/monaco-editor"

function base64ToUint8Array(base64: string) {
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function PdfPreview(props: { base64: string }) {
  const [pages] = createResource(
    () => props.base64,
    async (base64) => {
      const pdfjsLib = await import("pdfjs-dist")
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.mjs",
        import.meta.url,
      ).toString()
      const pdf = await pdfjsLib.getDocument({ data: base64ToUint8Array(base64) }).promise
      const rendered: string[] = []
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const scale = 1.5
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement("canvas")
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext("2d")!
        await page.render({ canvas, canvasContext: ctx, viewport } as any).promise
        rendered.push(canvas.toDataURL())
      }
      return rendered
    },
  )

  return (
    <Switch>
      <Match when={pages.loading}>
        <div class="px-6 py-4 text-text-weak">Loading PDF...</div>
      </Match>
      <Match when={pages.error}>
        <div class="px-6 py-4 text-text-weak">Failed to load PDF preview</div>
      </Match>
      <Match when={pages()}>
        {(imgs) => (
          <div class="size-full overflow-auto">
            <div class="flex flex-col items-center gap-4 px-6 py-4">
              <For each={imgs()}>
                {(src, i) => <img src={src} alt={`Page ${i() + 1}`} class="max-w-full shadow-md" />}
              </For>
            </div>
          </div>
        )}
      </Match>
    </Switch>
  )
}

export function MonacoFileTab(props: { tab: string }) {
  const file = useFile()
  const language = useLanguage()

  const path = () => file.pathFromTab(props.tab)
  const state = () => {
    const p = path()
    if (!p) return undefined
    return file.get(p)
  }
  const contents = () => state()?.content?.content ?? ""

  const fileExt = createMemo(() => {
    const p = path()?.toLowerCase()
    if (p?.endsWith(".docx")) return "docx"
    if (p?.endsWith(".pdf")) return "pdf"
    if (p?.endsWith(".md")) return "md"
    if (p?.endsWith(".html") || p?.endsWith(".htm")) return "html"
    return null
  })

  const isPreviewable = createMemo(() => {
    const ext = fileExt()
    return ext === "md" || ext === "html"
  })

  const htmlPreview = createMemo(() => {
    if (fileExt() !== "html") return ""

    const source = contents()
    const shim = `<script>
(() => {
  const defineStorage = (name) => {
    const data = new Map()
    const storage = {
      getItem: (key) => (data.has(String(key)) ? data.get(String(key)) : null),
      setItem: (key, value) => void data.set(String(key), String(value)),
      removeItem: (key) => void data.delete(String(key)),
      clear: () => void data.clear(),
      key: (index) => Array.from(data.keys())[index] ?? null,
    }

    Object.defineProperty(storage, "length", {
      get: () => data.size,
    })

    try {
      Object.defineProperty(window, name, {
        configurable: true,
        value: storage,
      })
    } catch {}
  }

  defineStorage("localStorage")
  defineStorage("sessionStorage")
})()
</script>`

    if (/<head[\s>]/i.test(source)) {
      return source.replace(/<head([^>]*)>/i, `<head$1>${shim}`)
    }

    if (/<html[\s>]/i.test(source)) {
      return source.replace(/<html([^>]*)>/i, `<html$1><head>${shim}</head>`)
    }

    return `<!doctype html><html><head>${shim}</head><body>${source}</body></html>`
  })

  const [viewMode, setViewMode] = createSignal<"preview" | "source">("preview")

  const previewBase64 = createMemo(() => {
    const s = state()
    if (!s?.loaded) return
    const c = s.content
    if (!c || typeof c.content !== "string" || c.encoding !== "base64") return
    return c.content
  })

  const imageSrc = createMemo(() => {
    const src = previewBase64()
    const mimeType = state()?.content?.mimeType
    if (!src || typeof mimeType !== "string" || !mimeType.startsWith("image/")) return
    return `data:${mimeType};base64,${src}`
  })

  const [docxHtml] = createResource(
    () => (fileExt() === "docx" ? previewBase64() : undefined),
    async (base64) => {
      const mammoth = await import("mammoth")
      const result = await mammoth.convertToHtml({ arrayBuffer: base64ToUint8Array(base64).buffer })
      const DOMPurify = (await import("dompurify")).default
      return DOMPurify.sanitize(result.value)
    },
  )

  const handleSave = async (content: string) => {
    const p = path()
    if (!p) return
    try {
      await file.write(p, content)
      file.setDirty(p, false)
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleDirty = (dirty: boolean) => {
    const p = path()
    if (p) file.setDirty(p, dirty)
  }

  return (
    <Tabs.Content value={props.tab} class="relative h-full">
      <Show when={isPreviewable() && state()?.loaded}>
        <div class="absolute top-2 right-4 z-20">
          <IconButton
            icon={viewMode() === "preview" ? "code" : "eye"}
            variant="ghost"
            size="small"
            class="!rounded-md bg-background-base/80 backdrop-blur-sm border border-border-weak-base"
            onClick={() => setViewMode((m) => (m === "preview" ? "source" : "preview"))}
            aria-label={viewMode() === "preview" ? "View source" : "View preview"}
          />
        </div>
      </Show>
      <Switch>
        <Match when={state()?.loaded && imageSrc()}>
          {(src) => (
            <div class="size-full overflow-auto bg-background-stronger">
              <div class="flex min-h-full items-center justify-center px-6 py-4">
                <img src={src()} alt={path() ?? "image preview"} class="max-h-full max-w-full object-contain shadow-md" />
              </div>
            </div>
          )}
        </Match>
        <Match when={fileExt() === "docx" && state()?.loaded}>
          <Switch>
            <Match when={docxHtml.loading}>
              <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
            </Match>
            <Match when={docxHtml.error}>
              <div class="px-6 py-4 text-text-weak">Failed to load document preview</div>
            </Match>
            <Match when={docxHtml()}>
              {(html) => (
                <div class="size-full overflow-auto">
                  <div class="docx-preview px-6 py-4 prose prose-sm max-w-none" innerHTML={html()} />
                </div>
              )}
            </Match>
            <Match when={true}>
              <div class="px-6 py-4 text-text-weak">Document preview unavailable</div>
            </Match>
          </Switch>
        </Match>
        <Match when={fileExt() === "pdf" && state()?.loaded && previewBase64()}>
          {(_) => <PdfPreview base64={previewBase64()!} />}
        </Match>
        <Match when={isPreviewable() && state()?.loaded && viewMode() === "preview"}>
          <div class="size-full overflow-auto">
            <Switch>
              <Match when={fileExt() === "md"}>
                <div class="px-6 py-4">
                  <Markdown text={contents()} />
                </div>
              </Match>
              <Match when={fileExt() === "html"}>
                <iframe
                  srcdoc={htmlPreview()}
                  sandbox="allow-scripts"
                  class="size-full border-0"
                  style={{ "min-height": "100%" }}
                />
              </Match>
            </Switch>
          </div>
        </Match>
        <Match when={state()?.loaded}>
          <div class="size-full relative">
            <MonacoEditor path={path()!} content={contents()} onSave={handleSave} onDirty={handleDirty} />
          </div>
        </Match>
        <Match when={state()?.loading}>
          <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
        </Match>
        <Match when={state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Match>
      </Switch>
    </Tabs.Content>
  )
}
