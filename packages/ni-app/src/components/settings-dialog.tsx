import { createSignal, For, Show, createMemo } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useNiStore } from "../context/store"
import { useNiSDK } from "../context/sdk"

export function NiSettingsDialog() {
  const [tab, setTab] = createSignal<"providers" | "models">("providers")

  return (
    <Dialog size="x-large" transition>
      <div class="flex gap-4 min-h-[500px]">
        {/* Tab sidebar */}
        <div class="flex flex-col gap-1 w-40 shrink-0 border-r border-border-base pr-4">
          <button
            type="button"
            class="text-left px-3 py-1.5 rounded-md text-13-regular transition-colors"
            classList={{
              "bg-surface-raised-base text-text-strong": tab() === "providers",
              "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": tab() !== "providers",
            }}
            onClick={() => setTab("providers")}
          >
            Providers
          </button>
          <button
            type="button"
            class="text-left px-3 py-1.5 rounded-md text-13-regular transition-colors"
            classList={{
              "bg-surface-raised-base text-text-strong": tab() === "models",
              "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": tab() !== "models",
            }}
            onClick={() => setTab("models")}
          >
            Models
          </button>
        </div>

        {/* Tab content */}
        <div class="flex-1 min-w-0 overflow-y-auto">
          <Show when={tab() === "providers"}>
            <ProvidersTab />
          </Show>
          <Show when={tab() === "models"}>
            <ModelsTab />
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

function ProvidersTab() {
  const { store, actions } = useNiStore()
  const sdk = useNiSDK()
  const [connectingProvider, setConnectingProvider] = createSignal<string | null>(null)
  const [apiKey, setApiKey] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const allProviders = createMemo(() => store.providers.all ?? [])
  const connectedIds = createMemo(() => new Set(store.providers.connected ?? []))

  const connected = createMemo(() => allProviders().filter((p) => connectedIds().has(p.id)))
  const available = createMemo(() => allProviders().filter((p) => !connectedIds().has(p.id)))

  const handleConnect = async (providerId: string) => {
    const key = apiKey().trim()
    if (!key || saving()) return
    setSaving(true)
    try {
      await sdk.client.auth.set({
        providerID: providerId,
        auth: { type: "api", key },
      })
      await sdk.client.global.dispose()
      setApiKey("")
      setConnectingProvider(null)
      await actions.refreshProviders()
    } finally {
      setSaving(false)
    }
  }

  const handleDisconnect = async (providerId: string) => {
    await sdk.client.auth.remove({ providerID: providerId })
    await sdk.client.global.dispose()
    await actions.refreshProviders()
  }

  return (
    <div class="flex flex-col gap-6 py-2">
      <div>
        <h3 class="text-14-medium text-text-strong mb-3">Connected Providers</h3>
        <Show
          when={connected().length > 0}
          fallback={
            <p class="text-13-regular text-text-weak py-2">No providers connected yet. Connect a provider below to get started.</p>
          }
        >
          <div class="flex flex-col gap-1">
            <For each={connected()}>
              {(provider) => (
                <div class="group flex items-center justify-between px-3 py-2.5 rounded-lg bg-surface-raised-base">
                  <div class="flex items-center gap-2.5">
                    <ProviderIcon id={provider.id} class="w-5 h-5" />
                    <span class="text-13-medium text-text-strong">{provider.name || provider.id}</span>
                    <span class="text-11-regular text-text-weak px-1.5 py-0.5 rounded bg-surface-base">
                      {provider.source}
                    </span>
                    <span class="text-11-regular text-text-weak">
                      {Object.keys(provider.models).length} models
                    </span>
                  </div>
                  <Show when={provider.source !== "env"}>
                      <Button
                        size="small"
                      variant="ghost"
                      class="opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => void handleDisconnect(provider.id)}
                    >
                      Disconnect
                    </Button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div>
        <h3 class="text-14-medium text-text-strong mb-3">Available Providers</h3>
        <Show
          when={available().length > 0}
          fallback={
            <p class="text-13-regular text-text-weak py-2">All providers are connected.</p>
          }
        >
          <div class="flex flex-col gap-1">
            <For each={available()}>
              {(provider) => (
                <div class="flex flex-col">
                  <div class="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-surface-raised-base-hover transition-colors">
                    <div class="flex items-center gap-2.5">
                      <ProviderIcon id={provider.id} class="w-5 h-5" />
                      <span class="text-13-medium text-text-strong">{provider.name || provider.id}</span>
                    </div>
                    <Show
                      when={connectingProvider() === provider.id}
                      fallback={
                        <Button size="small" onClick={() => setConnectingProvider(provider.id)}>
                          Connect
                        </Button>
                      }
                    >
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() => {
                          setConnectingProvider(null)
                          setApiKey("")
                        }}
                      >
                        Cancel
                      </Button>
                    </Show>
                  </div>
                  <Show when={connectingProvider() === provider.id}>
                    <div class="flex items-center gap-2 px-3 pb-3 pt-1">
                      <input
                        type="password"
                        placeholder="Enter API Key"
                        value={apiKey()}
                        onInput={(e) => setApiKey(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleConnect(provider.id)
                          if (e.key === "Escape") {
                            setConnectingProvider(null)
                            setApiKey("")
                          }
                        }}
                        class="flex-1 rounded-md border border-border-base bg-background-base px-3 py-1.5 text-13-regular text-text-base placeholder:text-text-weak focus:outline-none focus:ring-1 focus:ring-border-info-base"
                        autofocus
                      />
                      <Button
                        size="small"
                        disabled={!apiKey().trim() || saving()}
                        onClick={() => void handleConnect(provider.id)}
                      >
                        {saving() ? "Saving..." : "Save"}
                      </Button>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

function ModelsTab() {
  const { store, actions } = useNiStore()
  const [search, setSearch] = createSignal("")

  const connectedIds = createMemo(() => new Set(store.providers.connected ?? []))
  const providers = createMemo(() =>
    (store.providers.all ?? []).filter((p) => connectedIds().has(p.id) && Object.keys(p.models).length > 0),
  )

  const filteredProviders = createMemo(() => {
    const q = search().toLowerCase()
    if (!q) return providers()
    return providers()
      .map((p) => ({
        ...p,
        models: Object.fromEntries(
          Object.entries(p.models).filter(([id, model]) =>
            id.toLowerCase().includes(q) ||
            (model.name ?? "").toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q),
          ),
        ),
      }))
      .filter((p) => Object.keys(p.models).length > 0)
  })

  return (
    <div class="flex flex-col gap-3 py-2">
      <input
        type="text"
        placeholder="Search models..."
        value={search()}
        onInput={(e) => setSearch(e.currentTarget.value)}
        class="w-full rounded-md border border-border-base bg-background-base px-3 py-1.5 text-13-regular text-text-base placeholder:text-text-weak focus:outline-none focus:ring-1 focus:ring-border-info-base"
      />

      <Show
        when={filteredProviders().length > 0}
        fallback={
          <p class="text-13-regular text-text-weak py-4 text-center">No models available</p>
        }
      >
        <For each={filteredProviders()}>
          {(provider) => (
            <div class="flex flex-col gap-0.5">
              <div class="flex items-center gap-2 px-1 py-1.5">
                <ProviderIcon id={provider.id} class="w-4 h-4" />
                <span class="text-12-medium text-text-weak uppercase tracking-wide">{provider.name}</span>
              </div>
              <div class="flex flex-col">
                <For each={Object.entries(provider.models)}>
                  {([modelId, model]) => {
                    const isSelected = () =>
                      store.selectedModel?.providerID === provider.id &&
                      store.selectedModel?.modelID === modelId
                    return (
                      <button
                        type="button"
                        class="w-full flex items-center justify-between px-3 py-2 rounded-md text-left transition-colors"
                        classList={{
                          "bg-surface-info-base/10": isSelected(),
                          "hover:bg-surface-raised-base-hover": !isSelected(),
                        }}
                        onClick={() => actions.setSelectedModel({ providerID: provider.id, modelID: modelId })}
                      >
                        <div class="flex flex-col gap-0.5">
                          <span class="text-13-regular text-text-strong">{model.name || modelId}</span>
                          <span class="text-11-regular text-text-weak">{modelId}</span>
                        </div>
                        <div class="flex items-center gap-2">
                          <Show when={model.cost}>
                            {(cost) => (
                              <span class="text-11-regular text-text-weak">
                                ${cost().input}/{cost().output}
                              </span>
                            )}
                          </Show>
                          <Show when={isSelected()}>
                            <Icon name="check" class="w-4 h-4 text-text-info-base" />
                          </Show>
                        </div>
                      </button>
                    )
                  }}
                </For>
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}
