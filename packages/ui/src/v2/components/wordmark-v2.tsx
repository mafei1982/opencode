import { type ComponentProps } from "solid-js"
import metaXtestLogo from "../../assets/images/metaxtest-logo.png"

export function WordmarkV2(props: Pick<ComponentProps<"img">, "class">) {
  return (
    <img
      src={metaXtestLogo}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-component="wordmark-v2"
      class={props.class}
      style={{ "object-fit": "contain" }}
    />
  )
}
