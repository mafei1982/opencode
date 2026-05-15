import { createMemo, createResource, For, Match, Switch } from "solid-js"
import { Tabs } from "@opencode-ai/ui/tabs"
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
    return null
  })

  const previewBase64 = createMemo(() => {
    if (!fileExt()) return
    const s = state()
    if (!s?.loaded) return
    const c = s.content
    if (!c || typeof c.content !== "string" || c.encoding !== "base64") return
    return c.content
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
      <Switch>
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
