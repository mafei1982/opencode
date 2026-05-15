import type { FileContent } from "@opencode-ai/sdk/v2"
import DOMPurify from "dompurify"
import { createEffect, createMemo, createResource, Match, on, Show, Switch, type JSX } from "solid-js"
import { useI18n } from "../context/i18n"
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

export function FileMedia(props: { media?: FileMediaOptions; fallback: () => JSX.Element }) {
  const i18n = useI18n()
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

  const [loaded] = createResource(request, async (input) => {
    return input.readFile(input.path).then(
      (result) => {
        const src = dataUrlFromMediaValue(result as any, input.kind)
        if (!src) {
          input.onError?.({ kind: input.kind })
          return { key: input.key, error: true as const }
        }

        return {
          key: input.key,
          src,
          mime: input.kind === "audio" ? normalizeMimeType(result?.mimeType) : undefined,
        }
      },
      () => {
        input.onError?.({ kind: input.kind })
        return { key: input.key, error: true as const }
      },
    )
  })

  const remote = createMemo(() => {
    const input = request()
    const value = loaded()
    if (!input || !value || value.key !== input.key) return
    return value
  })

  const src = createMemo(() => {
    const value = remote()
    return direct() ?? (value && "src" in value ? value.src : undefined)
  })
  const status = createMemo(() => {
    if (direct()) return "ready" as const
    if (!request()) return "idle" as const
    if (loaded.loading) return "loading" as const
    if (remote()?.error) return "error" as const
    if (src()) return "ready" as const
    return "idle" as const
  })
  const audioMime = createMemo(() => {
    const value = remote()
    return value && "mime" in value ? value.mime : undefined
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

  const docxBuffer = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "docx") return
    return docxArrayBufferFromValue(media.current as any)
  })

  const docxRequest = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "docx") return
    if (docxBuffer()) return
    if (!media.path || !media.readFile) return
    return { path: media.path, readFile: media.readFile }
  })

  const [docxRemote] = createResource(docxRequest, async (input) => {
    const result = await input.readFile(input.path)
    return docxArrayBufferFromValue(result as any)
  })

  const docxInput = createMemo(() => docxBuffer() ?? docxRemote())

  const [docxHtml] = createResource(docxInput, async (buffer) => {
    const mammoth = await import("mammoth")
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer })
    return DOMPurify.sanitize(result.value)
  })

  const pdfBuffer = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "pdf") return
    return pdfArrayBufferFromValue(media.current as any)
  })

  const pdfRequest = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "pdf") return
    if (pdfBuffer()) return
    if (!media.path || !media.readFile) return
    return { path: media.path, readFile: media.readFile }
  })

  const [pdfRemote] = createResource(pdfRequest, async (input) => {
    const result = await input.readFile(input.path)
    return pdfArrayBufferFromValue(result as any)
  })

  const pdfInput = createMemo(() => pdfBuffer() ?? pdfRemote())

  const [pdfPages] = createResource(pdfInput, async (buffer) => {
    const pdfjsLib = await import("pdfjs-dist")
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString()
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const scale = 1.5
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement("canvas")
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext("2d")!
      await page.render({ canvasContext: ctx, viewport }).promise
      pages.push(canvas.toDataURL())
    }
    return pages
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
          <Match when={docxHtml.loading}>
            <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
              {i18n.t("common.loading")}...
            </div>
          </Match>
          <Match when={docxHtml.error}>
            <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
              Failed to load document preview
            </div>
          </Match>
          <Match when={docxHtml()}>
            {(html) => <div class="docx-preview px-6 py-4 text-text-strong" innerHTML={html()} />}
          </Match>
          <Match when={!docxInput() && !docxRequest()}>
            <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
              Document preview unavailable
            </div>
          </Match>
        </Switch>
      </Match>
      <Match when={kind() === "pdf"}>
        <Switch>
          <Match when={pdfPages.loading}>
            <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
              {i18n.t("common.loading")}...
            </div>
          </Match>
          <Match when={pdfPages.error}>
            <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
              Failed to load PDF preview
            </div>
          </Match>
          <Match when={pdfPages()}>
            {(pages) => (
              <div class="flex flex-col items-center gap-4 px-6 py-4 bg-background-stronger">
                {pages().map((src) => (
                  <img
                    src={src}
                    class="max-w-full rounded border border-border-weak-base bg-background-base shadow-sm"
                    onLoad={onLoad}
                  />
                ))}
              </div>
            )}
          </Match>
          <Match when={!pdfInput() && !pdfRequest()}>
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
