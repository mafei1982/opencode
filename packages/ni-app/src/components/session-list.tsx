import type { Session } from "@opencode-ai/sdk/v2/client"
import { For, Show, createMemo } from "solid-js"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { Icon } from "@opencode-ai/ui/icon"

function formatTime(ts: number) {
  const date = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString()
}

export function SessionList(props: {
  sessions: Session[]
  activeSessionId: string | undefined
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <div class="flex flex-col py-1">
      <Show
        when={props.sessions.length > 0}
        fallback={
          <div class="flex flex-col items-center justify-center py-8 px-4">
            <p class="text-12-regular text-text-weak text-center">No sessions yet</p>
          </div>
        }
      >
        <For each={props.sessions.filter((s) => !s.parentID)}>
          {(session) => {
            const isActive = createMemo(() => session.id === props.activeSessionId)
            return (
              <ContextMenu>
                <ContextMenu.Trigger>
                  <button
                    type="button"
                    class="flex flex-col gap-0.5 w-full px-3 py-2 text-left transition-colors hover:bg-surface-raised-base-hover"
                    classList={{
                      "bg-surface-raised-base": isActive(),
                    }}
                    onClick={() => props.onSelect(session.id)}
                  >
                    <div class="flex items-center justify-between w-full">
                      <span class="text-13-regular text-text-strong truncate flex-1 min-w-0">
                        {session.title || "Untitled"}
                      </span>
                    </div>
                    <span class="text-11-regular text-text-weak">
                      {formatTime(session.time.updated)}
                    </span>
                  </button>
                </ContextMenu.Trigger>
                <ContextMenu.Content>
                  <ContextMenu.Item onSelect={() => props.onDelete(session.id)}>
                    <Icon name="trash" class="w-4 h-4" />
                    Delete
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu>
            )
          }}
        </For>
      </Show>
    </div>
  )
}
