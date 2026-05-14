import { createSignal, createMemo, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ModelSelector } from "./model-selector"
import { useNiStore } from "../context/store"

export function ChatInput(props: {
  onSend: (content: string) => Promise<void>
  onAbort: () => Promise<void>
  sessionId: string
}) {
  const { store } = useNiStore()
  const [value, setValue] = createSignal("")

  const working = createMemo(() =>
    (store.session_status[props.sessionId]?.type ?? "idle") !== "idle",
  )
  const blank = createMemo(() => !value().trim())

  const handleSend = async () => {
    const content = value().trim()
    if (!content || working()) return
    setValue("")
    await props.onSend(content)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
      return
    }
    if (e.key === "Escape" && working()) {
      e.preventDefault()
      void props.onAbort()
    }
  }

  return (
    <div class="shrink-0 border-t border-border-base bg-surface-base px-4 py-3">
      <div class="flex items-end gap-2 max-w-4xl mx-auto">
        <div class="flex-1 min-w-0 relative">
          <textarea
            class="w-full resize-none rounded-lg border border-border-base bg-background-base px-3 py-2.5 text-14-regular text-text-base placeholder:text-text-weak focus:outline-none focus:ring-1 focus:ring-border-info-base min-h-[80px] max-h-[240px]"
            placeholder={working() ? "Waiting for response..." : "Type a message..."}
            value={value()}
            onKeyDown={handleKeyDown}
            rows={3}
            disabled={working()}
            onInput={(e) => {
              const el = e.currentTarget
              el.style.height = "auto"
              el.style.height = `${Math.min(el.scrollHeight, 240)}px`
              setValue(el.value)
            }}
          />
        </div>
        <Show
          when={!working()}
          fallback={
            <Tooltip placement="top" title="Stop (Esc)">
              <IconButton
                icon="stop"
                size="md"
                onClick={() => void props.onAbort()}
              />
            </Tooltip>
          }
        >
          <Tooltip placement="top" title="Send (Enter)">
            <IconButton
              icon="arrow-up"
              size="md"
              disabled={blank()}
              onClick={() => void handleSend()}
            />
          </Tooltip>
        </Show>
      </div>
      <div class="flex items-center mt-1.5 max-w-4xl mx-auto">
        <ModelSelector />
      </div>
    </div>
  )
}
