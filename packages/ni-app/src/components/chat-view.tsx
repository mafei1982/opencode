import type { Message, UserMessage } from "@opencode-ai/sdk/v2/client"
import { For, Show, createEffect, createMemo, on } from "solid-js"
import { DataProvider } from "@opencode-ai/ui/context"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { Splash } from "@opencode-ai/ui/logo"
import { Icon } from "@opencode-ai/ui/icon"
import { useNiStore } from "../context/store"
import { useNiSDK } from "../context/sdk"

export function ChatView(props: {
  sessionId: string
  onNavigateToSession?: (sessionId: string) => void
}) {
  let scrollRef: HTMLDivElement | undefined
  const { store } = useNiStore()
  const sdk = useNiSDK()

  const messages = createMemo(() => store.messages[props.sessionId] ?? [])
  const userMessages = createMemo(() =>
    messages().filter((m): m is UserMessage => m.role === "user"),
  )

  const activeSession = createMemo(() =>
    store.sessions.find((s) => s.id === props.sessionId),
  )

  const parentSession = createMemo(() => {
    const pid = activeSession()?.parentID
    if (!pid) return
    return store.sessions.find((s) => s.id === pid)
  })

  // Build data for DataProvider matching the Data type expected by SessionTurn
  const data = createMemo(() => ({
    session: store.sessions,
    session_status: store.session_status,
    session_diff: {} as Record<string, never>,
    message: store.messages,
    part: store.parts,
    part_text_accum_delta: store.part_text_accum_delta,
  }))

  // Auto-scroll to bottom on new messages/parts
  createEffect(
    on(
      () => {
        const msgs = messages()
        const lastMsg = msgs[msgs.length - 1]
        const partCount = lastMsg ? (store.parts[lastMsg.id]?.length ?? 0) : 0
        return [msgs.length, partCount] as const
      },
      () => {
        requestAnimationFrame(() => {
          scrollRef?.scrollTo({ top: scrollRef.scrollHeight, behavior: "smooth" })
        })
      },
    ),
  )

  return (
    <div class="flex flex-col flex-1 min-h-0">
      {/* Session header */}
      <div class="flex items-center px-4 py-2 border-b border-border-base shrink-0 min-h-[40px]">
        <Show when={parentSession()}>
          {(parent) => (
            <>
              <button
                type="button"
                class="flex items-center gap-1 min-w-0 max-w-[40%] text-14-medium text-text-weak hover:text-text-base transition-colors"
                onClick={() => props.onNavigateToSession?.(parent().id)}
              >
                <Icon name="arrow-left" size="small" />
                <span class="truncate">{parent().title || "Untitled Session"}</span>
              </button>
              <span class="px-2 text-14-medium text-text-weak" aria-hidden="true">/</span>
            </>
          )}
        </Show>
        <span class="text-14-medium text-text-strong truncate flex-1 min-w-0">
          {activeSession()?.title || "Untitled Session"}
        </span>
        <Show when={activeSession()?.model}>
          {(model) => (
            <span class="ml-2 text-11-regular text-text-weak">
              {model().id}
            </span>
          )}
        </Show>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        class="flex-1 overflow-y-auto"
      >
        <Show
          when={userMessages().length > 0}
          fallback={
            <div class="flex flex-col items-center justify-center h-full gap-3 opacity-50">
              <Splash class="w-10 h-12" />
              <p class="text-13-regular text-text-weak">Send a message to start</p>
            </div>
          }
        >
          <DataProvider
            data={data()}
            directory={sdk.directory}
            onNavigateToSession={props.onNavigateToSession}
            onSessionHref={(id: string) => `/session/${id}`}
          >
            <div class="flex flex-col px-4 py-4 max-w-4xl mx-auto w-full">
              <For each={userMessages()}>
                {(userMsg, index) => (
                  <SessionTurn
                    sessionID={props.sessionId}
                    messageID={userMsg.id}
                    active={index() === userMessages().length - 1}
                  />
                )}
              </For>
            </div>
          </DataProvider>
        </Show>
      </div>
    </div>
  )
}
