import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@/utils/toast"
import { useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { createPathHelpers } from "./file/path"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"
import { createFileViewCache } from "./file/view-cache"
import { useServerSDK } from "./server-sdk"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { createFileTreeStore } from "./file/tree-store"
import { invalidateFromWatcher } from "./file/watcher"
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "./file/types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

function stringifyLogValue(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const { use: useFile, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    useSync()
    const params = useParams()
    const serverSDK = useServerSDK()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk().directory)
    const path = createPathHelpers(scope)
    const tabs = layout.tabs(() =>
      SessionStateKey.from(serverSDK().scope, SessionRouteKey.fromRoute(base64Encode(sdk().directory), params.id)),
    )
    const logFileListFailure = (input: { dir: string; error: unknown; message: string }) => {
      const details = {
        scope: scope(),
        requestedDir: input.dir,
        isRoot: input.dir === "",
        sessionID: params.id ?? null,
        href: window.location.href,
        errorType: input.error instanceof Error ? input.error.name : typeof input.error,
        errorMessage: input.message,
        errorStack: input.error instanceof Error ? input.error.stack : undefined,
        errorCause: input.error instanceof Error ? stringifyLogValue(input.error.cause) : undefined,
        errorRaw: input.error instanceof Error ? undefined : stringifyLogValue(input.error),
      }
      console.error("[file-tree] failed to list files", details)
      void serverSDK().client.app
        .log({
          directory: scope(),
          service: "app.file-tree",
          level: "error",
          message: "file list failed",
          extra: details,
        })
        .catch(() => undefined)
    }

    const inflight = new Map<string, Promise<void>>()
    const [dirtyFiles, setDirtyFiles] = createStore<Record<string, boolean>>({})
    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: {},
    })

    const tree = createFileTreeStore({
      scope,
      normalizeDir: path.normalizeDir,
      list: (dir) =>
        sdk()
          .client.file.list({ path: dir })
          .then((x) => x.data ?? []),
      onError: (input) => {
        logFileListFailure(input)
        showToast({
          variant: "error",
          title: language.t("toast.file.listFailed.title"),
          description: input.message,
        })
      },
    })

    const evictContent = (keep?: Set<string>) => {
      evictContentLru(keep, (target) => {
        if (!store.file[target]) return
        setStore(
          "file",
          target,
          produce((draft) => {
            draft.content = undefined
            draft.loaded = false
          }),
        )
      })
    }

    createEffect(() => {
      scope()
      inflight.clear()
      resetFileContentLru()
      batch(() => {
        setStore("file", reconcile({}))
        tree.reset()
      })
    })

    const viewCache = createFileViewCache(serverSDK().scope)
    const view = createMemo(() => viewCache.load(scope(), params.id))

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore("file", file, { path: file, name: getFilename(file) })
    }

    const setLoading = (file: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = true
          draft.error = undefined
        }),
      )
    }

    const setLoaded = (file: string, content: FileState["content"]) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loaded = true
          draft.loading = false
          draft.content = content
        }),
      )
    }

    const setLoadError = (file: string, message: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.error = message
        }),
      )
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: message,
      })
    }

    const load = (input: string, options?: { force?: boolean }) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()

      const directory = scope()
      const key = `${directory}\n${file}`
      ensure(file)

      const current = store.file[file]
      if (!options?.force && current?.loaded) return Promise.resolve()

      const pending = inflight.get(key)
      if (pending) return pending

      setLoading(file)

      const promise = sdk()
        .client.file.read({ path: file }, { cache: "no-store" })
        .then((x) => {
          if (scope() !== directory) return
          const content = x.data
          setLoaded(file, content)

          if (!content) return
          touchFileContent(file, approxBytes(content))
          evictContent(new Set([file]))
        })
        .catch((e) => {
          if (scope() !== directory) return
          setLoadError(file, errorMessage(e, language.t("error.chain.unknown")))
        })
        .finally(() => {
          inflight.delete(key)
        })

      inflight.set(key, promise)
      return promise
    }

    const search = (query: string, dirs: "true" | "false") =>
      sdk()
        .client.find.files({ query, dirs })
        .then(
          (x) => (x.data ?? []).map(path.normalize),
          () => [],
        )

    const stop = sdk().event.listen((e) => {
      invalidateFromWatcher(e.details, {
        normalize: path.normalize,
        hasFile: (file) => Boolean(store.file[file]),
        isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
        loadFile: (file) => {
          void load(file, { force: true })
        },
        node: tree.node,
        isDirLoaded: tree.isLoaded,
        refreshDir: (dir) => {
          void tree.listDir(dir, { force: true })
        },
      })
    })

    const reloadActive = () => {
      const active = tabs.active()
      const file = active ? path.pathFromTab(active) : undefined
      if (!file) return
      void load(file, { force: true })
    }
    const reloadVisible = () => {
      if (document.visibilityState !== "visible") return
      reloadActive()
    }
    window.addEventListener("focus", reloadActive)
    document.addEventListener("visibilitychange", reloadVisible)

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(file)) {
        touchFileContent(file)
        return state
      }
      touchFileContent(file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))

    onCleanup(() => {
      stop()
      window.removeEventListener("focus", reloadActive)
      document.removeEventListener("visibilitychange", reloadVisible)
      viewCache.clear()
    })

    return {
      ready: () => view().ready(),
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: tree.listDir,
        refresh: (input: string) => tree.listDir(input, { force: true }),
        refreshAll: tree.refreshLoaded,
        state: tree.dirState,
        children: tree.children,
        expand: tree.expandDir,
        collapse: tree.collapseDir,
        toggle(input: string) {
          if (tree.dirState(input)?.expanded) {
            tree.collapseDir(input)
            return
          }
          tree.expandDir(input)
        },
      },
      get,
      load,
      write: async (input: string, content: string) => {
        const file = path.normalize(input)
        if (!file) return
        setLoaded(file, (await sdk().client.file.write({ path: file, content })).data)
      },
      scrollTop,
      scrollLeft,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      searchFiles: (query: string) => search(query, "false"),
      searchFilesAndDirectories: (query: string) => search(query, "true"),
      isDirty: (input: string) => dirtyFiles[path.normalize(input)] ?? false,
      setDirty: (input: string, dirty: boolean) => {
        const file = path.normalize(input)
        if (!file) return
        setDirtyFiles(file, dirty)
      },
      rename: async (from: string, to: string) => {
        const source = path.normalize(from)
        const target = path.normalize(to)
        if (!source || !target) return
        await sdk().client.file.rename({ path: source, to: target })
        const parent = path.normalizeDir(getDirectory(source))
        const targetParent = path.normalizeDir(getDirectory(target))
        void tree.listDir(parent, { force: true })
        if (targetParent !== parent) void tree.listDir(targetParent, { force: true })
      },
      remove: async (input: string) => {
        const file = path.normalize(input)
        if (!file) return
        await sdk().client.file.remove({ path: file })
        void tree.listDir(path.normalizeDir(getDirectory(file)), { force: true })
      },
      copy: async (from: string, to: string) => {
        const source = path.normalize(from)
        const target = path.normalize(to)
        if (!source || !target) return
        await sdk().client.file.copy({ path: source, to: target })
        void tree.listDir(path.normalizeDir(getDirectory(target)), { force: true })
      },
    }
  },
})
