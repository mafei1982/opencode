import { type ComponentProps } from "solid-js"
import metaXtestLogo from "../assets/images/metaxtest-logo.png"
import metaXtestMark from "../assets/images/metaxtest-mark.png"

export const Mark = (props: { class?: string }) => {
  return (
    <img
      src={metaXtestMark}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-component="logo-mark"
      class={props.class}
      style={{ "object-fit": "contain" }}
    />
  )
}

export const Splash = (props: Pick<ComponentProps<"img">, "ref" | "class">) => {
  return (
    <img
      ref={props.ref}
      src={metaXtestLogo}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-component="logo-splash"
      class={props.class}
      style={{ "object-fit": "contain" }}
    />
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <img
      src={metaXtestLogo}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-component="logo-wordmark"
      class={props.class}
      style={{ "object-fit": "contain" }}
    />
  )
}
