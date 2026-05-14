import { createContext, useContext, type ParentProps } from "solid-js"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"

type NiSDKContextValue = {
  client: OpencodeClient
  directory: string
  url: string
}

const Context = createContext<NiSDKContextValue>()

export function NiSDKProvider(props: ParentProps<{ serverUrl: string; directory: string }>) {
  const client = createOpencodeClient({
    baseUrl: props.serverUrl,
    directory: props.directory,
  })

  const value: NiSDKContextValue = {
    client,
    directory: props.directory,
    url: props.serverUrl,
  }

  return <Context.Provider value={value}>{props.children}</Context.Provider>
}

export function useNiSDK() {
  const ctx = useContext(Context)
  if (!ctx) throw new Error("useNiSDK must be used within NiSDKProvider")
  return ctx
}
