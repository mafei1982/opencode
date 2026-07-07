import type { FileContent } from "@opencode-ai/sdk/v2"
import DOMPurify from "dompurify"
import {
  createEffect,
  createMemo,
  createResource,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  untrack,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import {
  dataUrlFromMediaValue,
  docxArrayBufferFromValue,
  hasMediaValue,
  isBinaryContent,
  mediaKindFromPath,
  normalizeMimeType,
  pdfArrayBufferFromValue,
  svgTextFromValue,
} from "../pierre/media"

const mammothModule = import("mammoth")

export type FileMediaOptions = {
  mode?: "auto" | "off"
  path?: string
  current?: unknown
  before?: unknown
  after?: unknown
  deleted?: boolean
  readFile?: (path: string) => Promise<FileContent | undefined>
  onLoad?: () => void
  onError?: (ctx: { kind: "image" | "audio" | "svg" }) => void
}

function mediaValue(cfg: FileMediaOptions, mode: "image" | "audio") {
  if (cfg.current !== undefined) return cfg.current
  if (mode === "image") return cfg.after ?? cfg.before
  return cfg.after ?? cfg.before
}

async function renderPdf(buffer: ArrayBuffer) {
  const pdfjs = await import("pdfjs-dist")
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString()
  const pdfDocument = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
  const pages: string[] = []
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
    const page = await pdfDocument.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1.5 })
    const canvas = document.createElement("canvas")
    canvas.width = viewport.width
    canvas.height = viewport.height
    const context = canvas.getContext("2d")
    if (!context) continue
    await page.render({ canvas, canvasContext: context, viewport }).promise
    pages.push(canvas.toDataURL())
  }
  return pages
}

export function FileMedia(props: { media?: FileMediaOptions; fallback: () => JSX.Element }) {
  const i18n = useI18n()
  const [remote, setRemote] = createStore<{
    key?: string
    loading?: boolean
    error?: boolean
    src?: string
    mime?: string
  }>({})
  const cfg = () => props.media
  const kind = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return
    return mediaKindFromPath(media.path)
  })

  const isBinary = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return false
    if (kind()) return false
    return isBinaryContent(media.current as any)
  })

  const onLoad = () => props.media?.onLoad?.()

  const deleted = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || !k) return false
    if (media.deleted) return true
    if (k === "svg") return false
    if (media.current !== undefined) return false
    return !hasMediaValue(media.after as any) && hasMediaValue(media.before as any)
  })

  const direct = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio")) return
    return dataUrlFromMediaValue(mediaValue(media, k), k)
  })

  const request = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio")) return
    if (media.current !== undefined) return
    if (deleted()) return
    if (direct()) return
    if (!media.path || !media.readFile) return

    return {
      key: `${k}:${media.path}`,
      kind: k,
      path: media.path,
      readFile: media.readFile,
      onError: media.onError,
    }
  })

  createEffect(() => {
    const input = request()
    if (!input) {
      setRemote({ key: undefined, loading: false, error: false, src: undefined, mime: undefined })
      return
    }

    let active = true
    // Keep the previous media visible while re-reading the same file (e.g. a vcs
    // diff refresh); only a key change resets to the loading placeholder.
    if (untrack(() => remote.key) === input.key) setRemote({ loading: true, error: false })
    else setRemote({ key: input.key, loading: true, error: false, src: undefined, mime: undefined })
    void input.readFile(input.path).then(
      (result) => {
        if (!active) return
        const src = dataUrlFromMediaValue(result as any, input.kind)
        if (!src) {
          input.onError?.({ kind: input.kind })
          setRemote({ key: input.key, loading: false, error: true, src: undefined, mime: undefined })
          return
        }

        setRemote({
          key: input.key,
          loading: false,
          error: false,
          src,
          mime: input.kind === "audio" ? normalizeMimeType(result?.mimeType) : undefined,
        })
      },
      () => {
        if (!active) return
        input.onError?.({ kind: input.kind })
        setRemote({ key: input.key, loading: false, error: true, src: undefined, mime: undefined })
      },
    )

    onCleanup(() => {
      active = false
    })
  })

  const src = createMemo(() => {
    const input = request()
    if (!input || remote.key !== input.key || remote.error) return direct()
    return direct() ?? remote.src
  })
  const status = createMemo(() => {
    if (direct()) return "ready" as const
    const input = request()
    if (!input) return "idle" as const
    if (remote.key !== input.key || remote.loading) return "loading" as const
    if (remote.error) return "error" as const
    if (src()) return "ready" as const
    return "idle" as const
  })
  const audioMime = createMemo(() => {
    const input = request()
    if (!input || remote.key !== input.key) return
    return remote.mime
  })

  const svgSource = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    return svgTextFromValue(media.current as any)
  })
  const svgSrc = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    return dataUrlFromMediaValue(media.current as any, "svg")
  })
  const svgInvalid = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    if (svgSource() !== undefined) return
    if (!hasMediaValue(media.current as any)) return
    return [media.path, media.current] as const
  })

  createEffect(
    on(
      svgInvalid,
      (value) => {
        if (!value) return
        cfg()?.onError?.({ kind: "svg" })
      },
      { defer: true },
    ),
  )

  const docxSource = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "docx") return
    const buffer = docxArrayBufferFromValue(media.current as any)
    if (buffer) return { key: `docx:inline:${media.path ?? ""}`, buffer }
    if (deleted()) return
    if (!media.path || !media.readFile) return
    return { key: `docx:${media.path}`, path: media.path, readFile: media.readFile }
  })
  const [docxPreview] = createResource(docxSource, async (input) => {
    const buffer =
      "buffer" in input
        ? input.buffer
        : await input.readFile(input.path).then((result) => docxArrayBufferFromValue(result as any))
    if (!buffer) throw new Error("Failed to decode DOCX preview")
    const mammoth = await mammothModule
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer })
    return { key: input.key, html: DOMPurify.sanitize(result.value) }
  })
  const docxHtml = createMemo(() => {
    const input = docxSource()
    const value = docxPreview()
    if (!input || !value || value.key !== input.key) return
    return value.html
  })
  const docxLoading = createMemo(() => !!docxSource() && docxPreview.loading)
  const docxError = createMemo(() => (docxSource() ? docxPreview.error : undefined))

  const pdfSource = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "pdf") return
    const buffer = pdfArrayBufferFromValue(media.current as any)
    if (buffer) return { key: `pdf:inline:${media.path ?? ""}`, buffer }
    if (deleted()) return
    if (!media.path || !media.readFile) return
    return { key: `pdf:${media.path}`, path: media.path, readFile: media.readFile }
  })
  const [pdfPreview] = createResource(pdfSource, async (input) => {
    const buffer =
      "buffer" in input
        ? input.buffer
        : await input.readFile(input.path).then((result) => pdfArrayBufferFromValue(result as any))
    if (!buffer) throw new Error("Failed to decode PDF preview")
    return { key: input.key, pages: await renderPdf(buffer) }
  })
  const pdfPages = createMemo(() => {
    const input = pdfSource()
    const value = pdfPreview()
    if (!input || !value || value.key !== input.key) return
    return value.pages
  })
  const pdfLoading = createMemo(() => !!pdfSource() && pdfPreview.loading)
  const pdfError = createMemo(() => (pdfSource() ? pdfPreview.error : undefined))

  const kindLabel = (value: "image" | "audio") =>
    i18n.t(value === "image" ? "ui.fileMedia.kind.image" : "ui.fileMedia.kind.audio")

  return (
    <Switch>
      <Match when={kind() === "image" || kind() === "audio"}>
        <Show
          when={src()}
          fallback={(() => {
            const media = cfg()
            const k = kind()
            if (!media || (k !== "image" && k !== "audio")) return props.fallback()
            const label = kindLabel(k)

            if (deleted()) {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.removed", { kind: label })}
                </div>
              )
            }
            if (status() === "loading") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.loading", { kind: label })}
                </div>
              )
            }
            if (status() === "error") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.error", { kind: label })}
                </div>
              )
            }
            return (
              <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                {i18n.t("ui.fileMedia.state.unavailable", { kind: label })}
              </div>
            )
          })()}
        >
          {(value) => {
            const k = kind()
            if (k !== "image" && k !== "audio") return props.fallback()
            if (k === "image") {
              return (
                <div class="flex justify-center bg-background-stronger px-6 py-4">
                  <img
                    src={value()}
                    alt={cfg()?.path}
                    class="max-h-[60vh] max-w-full rounded border border-border-weak-base bg-background-base object-contain"
                    onLoad={onLoad}
                  />
                </div>
              )
            }

            return (
              <div class="flex justify-center bg-background-stronger px-6 py-4">
                <audio class="w-full max-w-xl" controls preload="metadata" onLoadedMetadata={onLoad}>
                  <source src={value()} type={audioMime()} />
                </audio>
              </div>
            )
          }}
        </Show>
      </Match>
      <Match when={kind() === "svg"}>
        {(() => {
          if (svgSource() === undefined && svgSrc() == null) return props.fallback()

          return (
            <div class="flex flex-col gap-4 px-6 py-4">
              <Show when={svgSource() !== undefined}>{props.fallback()}</Show>
              <Show when={svgSrc()}>
                {(value) => (
                  <div class="flex justify-center">
                    <img
                      src={value()}
                      alt={cfg()?.path}
                      class="max-h-[60vh] max-w-full rounded border border-border-weak-base bg-background-base object-contain"
                      onLoad={onLoad}
                    />
                  </div>
                )}
              </Show>
            </div>
          )
        })()}
      </Match>
      <Match when={kind() === "docx"}>
        <Switch>
          <Match when={docxLoading()}>
            <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
              {i18n.t("common.loading")}...
            </div>
          </Match>
          <Match when={docxError()}>
            <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
              Failed to load document preview
            </div>
          </Match>
          <Match when={docxHtml()}>
            {(html) => <div class="docx-preview px-6 py-4 text-text-strong" innerHTML={html()} />}
          </Match>
          <Match when={!docxSource()}>
            <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
              Document preview unavailable
            </div>
          </Match>
        </Switch>
      </Match>
      <Match when={kind() === "pdf"}>
        <Switch>
          <Match when={pdfLoading()}>
            <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
              {i18n.t("common.loading")}...
            </div>
          </Match>
          <Match when={pdfError()}>
            <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
              Failed to load PDF preview
            </div>
          </Match>
          <Match when={pdfPages()}>
            {(pages) => (
              <div class="flex flex-col items-center gap-4 bg-background-stronger px-6 py-4">
                {pages().map((src) => (
                  <img
                    src={src}
                    alt={cfg()?.path}
                    class="max-w-full rounded border border-border-weak-base bg-background-base shadow-sm"
                    onLoad={onLoad}
                  />
                ))}
              </div>
            )}
          </Match>
          <Match when={!pdfSource()}>
            <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
              PDF preview unavailable
            </div>
          </Match>
        </Switch>
      </Match>
      <Match when={isBinary()}>
        <div class="flex min-h-56 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <div class="text-14-semibold text-text-strong">
            {cfg()?.path?.split("/").pop() ?? i18n.t("ui.fileMedia.binary.title")}
          </div>
          <div class="text-14-regular text-text-weak">
            {(() => {
              const path = cfg()?.path
              if (!path) return i18n.t("ui.fileMedia.binary.description.default")
              return i18n.t("ui.fileMedia.binary.description.path", { path })
            })()}
          </div>
        </div>
      </Match>
      <Match when={true}>{props.fallback()}</Match>
    </Switch>
  )
}
