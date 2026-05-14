import type {
  Session,
  Message,
  Part,
  ProviderListResponse,
  ProviderAuthResponse,
  SessionStatus,
  Agent,
} from "@opencode-ai/sdk/v2/client"
import { Binary } from "@opencode-ai/core/util/binary"
import { createContext, useContext, type ParentProps, onMount, onCleanup, batch } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useNiSDK } from "./sdk"

type NiStore = {
  ready: boolean
  sessions: Session[]
  messages: Record<string, Message[]>
  parts: Record<string, Part[]>
  session_status: Record<string, SessionStatus>
  part_text_accum_delta: Record<string, string>
  providers: ProviderListResponse
  providerAuth: ProviderAuthResponse
  agents: Agent[]
  defaultAgent: string | undefined
  activeSessionId: string | undefined
  selectedModel: { providerID: string; modelID: string } | undefined
}

type NiStoreActions = {
  loadSessions: () => Promise<void>
  loadMessages: (sessionId: string) => Promise<void>
  createSession: () => Promise<Session | undefined>
  deleteSession: (sessionId: string) => Promise<void>
  sendMessage: (sessionId: string, content: string, model?: { providerID: string; modelID: string }) => Promise<void>
  abortSession: (sessionId: string) => Promise<void>
  setActiveSession: (sessionId: string | undefined) => void
  setSelectedModel: (model: { providerID: string; modelID: string } | undefined) => void
  loadProviders: () => Promise<void>
  refreshProviders: () => Promise<void>
}

type NiStoreContextValue = {
  store: NiStore
  actions: NiStoreActions
}

const Context = createContext<NiStoreContextValue>()

export function NiStoreProvider(props: ParentProps<{ directory: string }>) {
  const sdk = useNiSDK()

  const [store, setStore] = createStore<NiStore>({
    ready: false,
    sessions: [],
    messages: {},
    parts: {},
    session_status: {},
    part_text_accum_delta: {},
    providers: {
      all: [],
      default: {},
      connected: [],
    },
    providerAuth: {},
    agents: [],
    defaultAgent: undefined,
    activeSessionId: undefined,
    selectedModel: undefined,
  })

  const loadSessions = async () => {
    const res = await sdk.client.session.list()
    if (res.data) {
      const sessions = [...res.data].sort((a, b) => b.time.updated - a.time.updated)
      setStore("sessions", reconcile(sessions))
    }
  }

  const loadMessages = async (sessionId: string) => {
    const res = await sdk.client.session.messages({ sessionID: sessionId })
    if (res.data) {
      batch(() => {
        // Response shape: Array<{ info: Message, parts: Part[] }>
        const items = res.data!
        setStore("messages", sessionId, items.map((item) => item.info))
        for (const item of items) {
          if (item.parts?.length) {
            setStore("parts", item.info.id, item.parts)
          }
        }
      })
    }
  }

  const createSession = async () => {
    const res = await sdk.client.session.create({
      ...(store.defaultAgent ? { agent: store.defaultAgent } : {}),
    })
    if (res.data) {
      await loadSessions()
      return res.data
    }
  }

  const deleteSession = async (sessionId: string) => {
    await sdk.client.session.delete({ sessionID: sessionId })
    setStore(
      produce((s) => {
        s.sessions = s.sessions.filter((session) => session.id !== sessionId)
        delete s.messages[sessionId]
        if (s.activeSessionId === sessionId) s.activeSessionId = undefined
      }),
    )
  }

  const sendMessage = async (
    sessionId: string,
    content: string,
    model?: { providerID: string; modelID: string },
  ) => {
    await sdk.client.session.promptAsync({
      sessionID: sessionId,
      parts: [{ type: "text", text: content }],
      ...(model ? { model } : {}),
      ...(store.defaultAgent ? { agent: store.defaultAgent } : {}),
    })
  }

  const abortSession = async (sessionId: string) => {
    await sdk.client.session.abort({ sessionID: sessionId })
  }

  const setActiveSession = (sessionId: string | undefined) => {
    setStore("activeSessionId", sessionId)
  }

  const setSelectedModel = (model: { providerID: string; modelID: string } | undefined) => {
    setStore("selectedModel", model ? { ...model } : undefined)
  }

  const loadProviders = async () => {
    const [provRes, authRes] = await Promise.all([
      sdk.client.provider.list(),
      sdk.client.provider.auth(),
    ])
    batch(() => {
      if (provRes.data) setStore("providers", reconcile(provRes.data))
      if (authRes.data) setStore("providerAuth", reconcile(authRes.data))
    })
  }

  const refreshProviders = loadProviders

  const actions: NiStoreActions = {
    loadSessions,
    loadMessages,
    createSession,
    deleteSession,
    sendMessage,
    abortSession,
    setActiveSession,
    setSelectedModel,
    loadProviders,
    refreshProviders,
  }

  // SSE event stream for real-time updates
  let eventAbort: AbortController | undefined

  const resync = () => {
    void loadSessions()
    const activeId = store.activeSessionId
    if (activeId) {
      void loadMessages(activeId)
      setStore("session_status", activeId, reconcile({ type: "idle" } as SessionStatus))
    }
  }

  const startEventStream = () => {
    eventAbort = new AbortController()
    const url = `${sdk.url}/global/event?directory=${encodeURIComponent(sdk.directory)}`
    const eventSource = new EventSource(url)

    eventSource.onmessage = (e) => {
      try {
        const globalEvent = JSON.parse(e.data)
        // /global/event wraps events in {directory, payload: Event}
        const event = globalEvent.payload ?? globalEvent
        handleEvent(event)
      } catch {
        // ignore parse errors
      }
    }

    eventSource.onerror = () => {
      eventSource.close()
      // Reconnect after delay and re-sync state to recover missed events
      setTimeout(() => {
        if (!eventAbort?.signal.aborted) {
          resync()
          startEventStream()
        }
      }, 2000)
    }

    eventAbort.signal.addEventListener("abort", () => eventSource.close())
  }

  const handleEvent = (event: { type: string; properties?: Record<string, unknown> }) => {
    switch (event.type) {
      case "session.created":
      case "session.updated":
      case "session.deleted":
        void loadSessions()
        break
      case "session.status": {
        const props = event.properties as { sessionID: string; status: SessionStatus }
        setStore("session_status", props.sessionID, reconcile(props.status))
        break
      }
      case "message.updated": {
        const info = (event.properties as { info: Message }).info
        const messages = store.messages[info.sessionID]
        if (!messages) {
          setStore("messages", info.sessionID, [info])
          break
        }
        const result = Binary.search(messages, info.id, (m) => m.id)
        if (result.found) {
          setStore("messages", info.sessionID, result.index, reconcile(info))
        } else {
          setStore(
            "messages",
            info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, info)
            }),
          )
        }
        break
      }
      case "message.removed": {
        const props = event.properties as { sessionID: string; messageID: string }
        setStore(
          produce((draft) => {
            const messages = draft.messages[props.sessionID]
            if (messages) {
              const result = Binary.search(messages, props.messageID, (m) => m.id)
              if (result.found) messages.splice(result.index, 1)
            }
            const parts = draft.parts[props.messageID]
            if (parts) {
              for (const part of parts) {
                delete draft.part_text_accum_delta[part.id]
              }
            }
            delete draft.parts[props.messageID]
          }),
        )
        break
      }
      case "message.part.updated": {
        const part = (event.properties as { part: Part }).part
        setStore(
          produce((draft) => {
            delete draft.part_text_accum_delta[part.id]
          }),
        )
        const parts = store.parts[part.messageID]
        if (!parts) {
          setStore("parts", part.messageID, [part])
          break
        }
        const result = Binary.search(parts, part.id, (p) => p.id)
        if (result.found) {
          setStore("parts", part.messageID, result.index, reconcile(part))
        } else {
          setStore(
            "parts",
            part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, part)
            }),
          )
        }
        break
      }
      case "message.part.removed": {
        const props = event.properties as { messageID: string; partID: string }
        setStore(
          produce((draft) => {
            delete draft.part_text_accum_delta[props.partID]
          }),
        )
        const parts = store.parts[props.messageID]
        if (!parts) break
        const result = Binary.search(parts, props.partID, (p) => p.id)
        if (result.found) {
          setStore(
            "parts",
            props.messageID,
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        break
      }
      case "message.part.delta": {
        const props = event.properties as { messageID: string; partID: string; field: string; delta: string }
        const parts = store.parts[props.messageID]
        if (!parts) break
        const result = Binary.search(parts, props.partID, (p) => p.id)
        if (!result.found) break
        setStore("part_text_accum_delta", props.partID, (existing) => (existing ?? "") + props.delta)
        setStore(
          "parts",
          props.messageID,
          produce((draft) => {
            const part = draft[result.index]
            const field = props.field as keyof typeof part
            const existing = part[field] as string | undefined
            ;(part[field] as string) = (existing ?? "") + props.delta
          }),
        )
        break
      }
      case "provider.updated":
      case "provider.configured":
        void loadProviders()
        break
      case "permission.asked": {
        const permission = event.properties as { id: string; sessionID: string }
        void sdk.client.permission.respond({
          sessionID: permission.sessionID,
          permissionID: permission.id,
          response: "always",
        })
        break
      }
    }
  }

  onMount(async () => {
    const [, , agentsRes, configRes] = await Promise.all([
      loadSessions(),
      loadProviders(),
      sdk.client.app.agents().catch(() => ({ data: undefined })),
      sdk.client.config.get().catch(() => ({ data: undefined })),
    ])
    batch(() => {
      if (agentsRes.data) {
        setStore("agents", agentsRes.data.filter((a) => a.mode !== "subagent" && !a.hidden))
      }
      if (configRes.data?.default_agent) {
        setStore("defaultAgent", configRes.data.default_agent)
      } else if (agentsRes.data) {
        // Fall back to first primary/visible agent
        const first = agentsRes.data.find((a) => a.mode !== "subagent" && !a.hidden)
        if (first) setStore("defaultAgent", first.name)
      }
    })
    // Auto-select first available model from a connected provider
    if (!store.selectedModel && store.providers.all) {
      const connectedSet = new Set(store.providers.connected ?? [])
      for (const provider of store.providers.all) {
        if (!connectedSet.has(provider.id)) continue
        const firstModel = Object.keys(provider.models)[0]
        if (firstModel) {
          setStore("selectedModel", { providerID: provider.id, modelID: firstModel })
          break
        }
      }
    }
    setStore("ready", true)
    startEventStream()

    // Re-sync when tab becomes visible again to recover from missed events
    const handleVisibility = () => {
      if (document.visibilityState === "visible") resync()
    }
    document.addEventListener("visibilitychange", handleVisibility)
    onCleanup(() => document.removeEventListener("visibilitychange", handleVisibility))
  })

  onCleanup(() => {
    eventAbort?.abort()
  })

  return (
    <Context.Provider value={{ store, actions }}>
      {props.children}
    </Context.Provider>
  )
}

export function useNiStore() {
  const ctx = useContext(Context)
  if (!ctx) throw new Error("useNiStore must be used within NiStoreProvider")
  return ctx
}
