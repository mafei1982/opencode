import { Tabs as Kobalte } from "@kobalte/core/tabs"
import { Show, splitProps, createSignal, onMount, onCleanup, type JSX } from "solid-js"
import type { ComponentProps, ParentProps, Component } from "solid-js"

export interface TabsProps extends ComponentProps<typeof Kobalte> {
  variant?: "normal" | "alt" | "pill" | "settings"
  orientation?: "horizontal" | "vertical"
}
export interface TabsListProps extends ComponentProps<typeof Kobalte.List> {}
export interface TabsTriggerProps extends ComponentProps<typeof Kobalte.Trigger> {
  classes?: {
    button?: string
  }
  hideCloseButton?: boolean
  closeButton?: JSX.Element
  onMiddleClick?: () => void
}
export interface TabsContentProps extends ComponentProps<typeof Kobalte.Content> {}

function TabsRoot(props: TabsProps) {
  const [split, rest] = splitProps(props, ["class", "classList", "variant", "orientation"])
  return (
    <Kobalte
      {...rest}
      orientation={split.orientation}
      data-component="tabs"
      data-variant={split.variant || "normal"}
      data-orientation={split.orientation || "horizontal"}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    />
  )
}

function TabsList(props: TabsListProps) {
  const [split, rest] = splitProps(props, ["class", "classList"])
  let listRef: HTMLDivElement | undefined
  const [canScrollLeft, setCanScrollLeft] = createSignal(false)
  const [canScrollRight, setCanScrollRight] = createSignal(false)

  const updateScrollState = () => {
    if (!listRef) return
    const el = listRef
    setCanScrollLeft(el.scrollLeft > 1)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }

  const scroll = (dir: -1 | 1) => {
    if (!listRef) return
    listRef.scrollBy({ left: dir * 120, behavior: "smooth" })
  }

  onMount(() => {
    if (!listRef) return
    updateScrollState()
    const observer = new ResizeObserver(updateScrollState)
    observer.observe(listRef)
    listRef.addEventListener("scroll", updateScrollState, { passive: true })
    onCleanup(() => {
      observer.disconnect()
      listRef?.removeEventListener("scroll", updateScrollState)
    })
  })

  return (
    <div data-slot="tabs-list-container">
      <Show when={canScrollLeft()}>
        <button
          data-slot="tabs-scroll-button"
          data-direction="left"
          onClick={() => scroll(-1)}
          aria-label="Scroll tabs left"
          type="button"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </Show>
      <Kobalte.List
        {...rest}
        ref={listRef}
        data-slot="tabs-list"
        classList={{
          ...split.classList,
          [split.class ?? ""]: !!split.class,
        }}
      />
      <Show when={canScrollRight()}>
        <button
          data-slot="tabs-scroll-button"
          data-direction="right"
          onClick={() => scroll(1)}
          aria-label="Scroll tabs right"
          type="button"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </Show>
    </div>
  )
}

function TabsTrigger(props: ParentProps<TabsTriggerProps>) {
  const [split, rest] = splitProps(props, [
    "class",
    "classList",
    "classes",
    "children",
    "closeButton",
    "hideCloseButton",
    "onMiddleClick",
  ])
  return (
    <div
      data-slot="tabs-trigger-wrapper"
      data-value={props.value}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      onMouseDown={(e) => {
        if (e.button === 1 && split.onMiddleClick) {
          e.preventDefault()
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && split.onMiddleClick) {
          e.preventDefault()
          split.onMiddleClick()
        }
      }}
    >
      <Kobalte.Trigger
        {...rest}
        data-slot="tabs-trigger"
        data-value={props.value}
        classList={{ [split.classes?.button ?? ""]: split.classes?.button }}
      >
        {split.children}
      </Kobalte.Trigger>
      <Show when={split.closeButton}>
        {(closeButton) => (
          <div data-slot="tabs-trigger-close-button" data-hidden={split.hideCloseButton}>
            {closeButton()}
          </div>
        )}
      </Show>
    </div>
  )
}

function TabsContent(props: ParentProps<TabsContentProps>) {
  const [split, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Content
      {...rest}
      data-slot="tabs-content"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </Kobalte.Content>
  )
}

const TabsSectionTitle: Component<ParentProps> = (props) => {
  return <div data-slot="tabs-section-title">{props.children}</div>
}

export const Tabs = Object.assign(TabsRoot, {
  List: TabsList,
  Trigger: TabsTrigger,
  Content: TabsContent,
  SectionTitle: TabsSectionTitle,
})
