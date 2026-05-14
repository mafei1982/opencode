import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useNiStore } from "../context/store"
import { SessionList } from "../components/session-list"
import { ChatView } from "../components/chat-view"
import { ChatInput } from "../components/chat-input"
import { NiSettingsDialog } from "../components/settings-dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Splash } from "@opencode-ai/ui/logo"

export default function MainPage() {
  const params = useParams()
  const navigate = useNavigate()
  const dialog = useDialog()
  const { store, actions } = useNiStore()
  const [sidebarWidth] = createSignal(280)

  const activeSessionId = createMemo(() => params.id ?? store.activeSessionId)

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (id && id !== store.activeSessionId) {
          actions.setActiveSession(id)
          void actions.loadMessages(id)
        }
      },
    ),
  )

  const handleNewSession = async () => {
    const session = await actions.createSession()
    if (session) {
      actions.setActiveSession(session.id)
      navigate(`/session/${session.id}`)
    }
  }

  const handleSelectSession = (sessionId: string) => {
    actions.setActiveSession(sessionId)
    navigate(`/session/${sessionId}`)
    void actions.loadMessages(sessionId)
  }

  const handleDeleteSession = async (sessionId: string) => {
    await actions.deleteSession(sessionId)
    if (activeSessionId() === sessionId) {
      const first = store.sessions[0]
      if (first) {
        handleSelectSession(first.id)
      } else {
        navigate("/")
      }
    }
  }

  const handleSendMessage = async (content: string) => {
    const id = activeSessionId()
    if (!id) return
    await actions.sendMessage(id, content, store.selectedModel)
  }

  const handleAbort = async () => {
    const id = activeSessionId()
    if (!id) return
    await actions.abortSession(id)
  }

  return (
    <div class="flex h-dvh w-screen bg-background-base">
      {/* Sidebar */}
      <div
        class="flex flex-col h-full border-r border-border-base bg-surface-base shrink-0"
        style={{ width: `${sidebarWidth()}px` }}
      >
        {/* Sidebar header */}
        <div class="flex items-center justify-between px-3 py-2 border-b border-border-base">
          <div class="flex items-center gap-2">
            <Splash class="w-5 h-6" />
            <span class="text-14-medium text-text-strong">NI OpenCode</span>
          </div>
          <div class="flex items-center gap-1">
            <Tooltip placement="bottom" value="Settings">
              <IconButton
                icon="settings-gear"
                size="small"
                onClick={() => dialog.show(() => <NiSettingsDialog />)}
              />
            </Tooltip>
            <Tooltip placement="bottom" value="New Session">
              <IconButton
                icon="new-session"
                size="small"
                onClick={handleNewSession}
              />
            </Tooltip>
          </div>
        </div>

        {/* Session list */}
        <div class="flex-1 min-h-0 overflow-y-auto">
          <SessionList
            sessions={store.sessions}
            activeSessionId={activeSessionId()}
            onSelect={handleSelectSession}
            onDelete={handleDeleteSession}
          />
        </div>
      </div>

      {/* Main chat area */}
      <div class="flex flex-col flex-1 min-w-0 h-full">
        <Show
          when={activeSessionId()}
          fallback={
            <div class="flex flex-col items-center justify-center flex-1 gap-4">
              <Splash class="w-16 h-20 opacity-30" />
              <p class="text-14-regular text-text-weak">Start a conversation</p>
              <p class="text-12-regular text-text-weak">
                Create a new session or select an existing one to begin chatting.
              </p>
              <button
                class="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-info-base text-text-info-base text-14-medium hover:bg-surface-info-base-hover transition-colors"
                onClick={handleNewSession}
              >
                <Icon name="edit" class="w-4 h-4" />
                New Session
              </button>
            </div>
          }
        >
          {(sessionId) => (
            <>
              <ChatView sessionId={sessionId()} onNavigateToSession={handleSelectSession} />
              <ChatInput
                onSend={handleSendMessage}
                onAbort={handleAbort}
                sessionId={sessionId()}
              />
            </>
          )}
        </Show>
      </div>
    </div>
  )
}
