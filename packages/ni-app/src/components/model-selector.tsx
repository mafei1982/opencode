import { createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useNiStore } from "../context/store"

export function ModelSelector() {
  const { store, actions } = useNiStore()
  const [open, setOpen] = createSignal(false)
  const [search, setSearch] = createSignal("")
  let panelRef: HTMLDivElement | undefined

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

  const selectedLabel = createMemo(() => {
    const sel = store.selectedModel
    if (!sel) return "Select model"
    const provider = (store.providers.all ?? []).find((p) => p.id === sel.providerID)
    if (!provider) return sel.modelID
    const model = provider.models[sel.modelID]
    return model?.name || sel.modelID
  })

  const selectedProviderId = createMemo(() => store.selectedModel?.providerID)

  const handleSelect = (providerID: string, modelID: string) => {
    actions.setSelectedModel({ providerID, modelID })
    setOpen(false)
    setSearch("")
  }

  onMount(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (panelRef && !panelRef.contains(e.target as Node)) {
        setOpen(false)
        setSearch("")
      }
    }
    document.addEventListener("click", onClickOutside)
    onCleanup(() => document.removeEventListener("click", onClickOutside))
  })

  return (
    <div
      class="relative"
      ref={panelRef}
    >
      <button
        type="button"
        class="flex items-center gap-1.5 px-2 py-1 rounded-md text-12-regular text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
        onClick={() => {
          setOpen(!open())
          if (!open()) setSearch("")
        }}
      >
        <Show when={selectedProviderId()}>
          {(id) => <ProviderIcon id={id()} class="w-3.5 h-3.5" />}
        </Show>
        <span class="max-w-[180px] truncate">{selectedLabel()}</span>
        <Icon name="chevron-down" class="w-3 h-3 shrink-0" />
      </button>

      <Show when={open()}>
        <div
          class="absolute bottom-full left-0 mb-1 w-72 max-h-80 overflow-hidden rounded-lg border border-border-base bg-surface-base shadow-lg z-50 flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="p-2 border-b border-border-base">
            <input
              type="text"
              class="w-full rounded-md border border-border-base bg-background-base px-2 py-1 text-13-regular text-text-base placeholder:text-text-weak focus:outline-none focus:ring-1 focus:ring-border-info-base"
              placeholder="Search models..."
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              autofocus
            />
          </div>
          <div class="overflow-y-auto flex-1">
            <Show
              when={filteredProviders().length > 0}
              fallback={
                <p class="text-12-regular text-text-weak py-4 text-center">No models available</p>
              }
            >
              <For each={filteredProviders()}>
                {(provider) => (
                  <div class="py-1">
                    <div class="flex items-center gap-1.5 px-3 py-1">
                      <ProviderIcon id={provider.id} class="w-3.5 h-3.5" />
                      <span class="text-11-medium text-text-weak uppercase tracking-wide">{provider.name}</span>
                    </div>
                    <For each={Object.entries(provider.models)}>
                      {([modelId, model]) => {
                        const isSelected = () =>
                          store.selectedModel?.providerID === provider.id &&
                          store.selectedModel?.modelID === modelId
                        return (
                          <button
                            type="button"
                            class="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-surface-raised-base-hover transition-colors"
                            classList={{
                              "bg-surface-raised-base": isSelected(),
                            }}
                            onClick={() => handleSelect(provider.id, modelId)}
                          >
                            <span class="text-13-regular text-text-base truncate">{model.name || modelId}</span>
                            <Show when={isSelected()}>
                              <Icon name="check" class="w-3.5 h-3.5 text-text-info-base shrink-0" />
                            </Show>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
