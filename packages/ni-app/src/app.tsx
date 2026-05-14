import "@/index.css"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { Router, Route, Navigate } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { type ParentProps, Show, Suspense, createSignal, createEffect, onCleanup, lazy } from "solid-js"
import { NiSDKProvider, useNiSDK } from "./context/sdk"
import { NiStoreProvider } from "./context/store"
import { dict } from "./i18n"

const MainPage = lazy(() => import("./pages/main"))

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function I18nBridge(props: ParentProps) {
  const t = (key: string, params?: Record<string, string | number | boolean>) => {
    const value = (dict as Record<string, string>)[key] ?? key
    if (!params) return value
    return value.replace(/{{\s*([^}]+?)\s*}}/g, (_, k) => {
      const v = params[String(k)]
      return v === undefined ? "" : String(v)
    })
  }
  return (
    <I18nProvider value={{ locale: () => "en", t: t as any }}>
      {props.children}
    </I18nProvider>
  )
}

function HealthGate(props: ParentProps<{ serverUrl: string }>) {
  const sdk = useNiSDK()
  const [healthy, setHealthy] = createSignal<boolean | undefined>(undefined)

  const check = async () => {
    try {
      const res = await fetch(`${props.serverUrl}/health`)
      setHealthy(res.ok)
    } catch {
      setHealthy(false)
    }
  }

  createEffect(() => {
    void check()
    const interval = setInterval(() => void check(), 10_000)
    onCleanup(() => clearInterval(interval))
  })

  return (
    <Show
      when={healthy()}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-4">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
          <Show when={healthy() === false}>
            <p class="text-14-regular text-text-weak">
              Cannot reach server at {props.serverUrl}
            </p>
            <p class="text-12-regular text-text-weak">Retrying...</p>
          </Show>
        </div>
      }
    >
      {props.children}
    </Show>
  )
}

export function NiApp(props: {
  serverUrl: string
  defaultServerUrl: string
  workspacePath: string
  onDefaultServerUrlChange?: (url: string | null) => void
}) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider>
        <I18nBridge>
          <QueryProvider>
            <DialogProvider>
              <MarkedProvider>
                <FileComponentProvider component={() => null}>
                  <NiSDKProvider serverUrl={props.serverUrl} directory={props.workspacePath}>
                    <HealthGate serverUrl={props.serverUrl}>
                      <NiStoreProvider directory={props.workspacePath}>
                        <Suspense
                          fallback={
                            <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
                              <Splash class="w-16 h-20 opacity-50 animate-pulse" />
                            </div>
                          }
                        >
                          <Router>
                            <Route path="/" component={MainPage} />
                            <Route path="/session/:id" component={MainPage} />
                            <Route path="*" component={() => <Navigate href="/" />} />
                          </Router>
                        </Suspense>
                      </NiStoreProvider>
                    </HealthGate>
                  </NiSDKProvider>
                </FileComponentProvider>
              </MarkedProvider>
            </DialogProvider>
          </QueryProvider>
        </I18nBridge>
      </ThemeProvider>
    </MetaProvider>
  )
}
