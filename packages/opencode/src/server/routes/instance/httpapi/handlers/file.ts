import * as InstanceState from "@/effect/instance-state"
import { File } from "@/file"
import { Ripgrep } from "@/file/ripgrep"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* File.Service
    const ripgrep = yield* Ripgrep.Service

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .search({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).items
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      return yield* svc.search({
        query: ctx.query.query,
        limit: ctx.query.limit ?? 10,
        dirs: ctx.query.dirs !== "false",
        type: ctx.query.type,
      })
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      return yield* svc.list(ctx.query.path)
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      return yield* svc.read(ctx.query.path)
    })

    const write = Effect.fn("FileHttpApi.write")(function* (ctx: {
      query: { path: string }
      payload: { content: string }
    }) {
      return yield* svc.write(ctx.query.path, ctx.payload.content)
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return yield* svc.status()
    })

    const rename = Effect.fn("FileHttpApi.rename")(function* (ctx: {
      query: { path: string }
      payload: { to: string }
    }) {
      yield* svc.rename(ctx.query.path, ctx.payload.to)
      return { ok: true }
    })

    const remove = Effect.fn("FileHttpApi.remove")(function* (ctx: { query: { path: string } }) {
      yield* svc.remove(ctx.query.path)
      return { ok: true }
    })

    const copy = Effect.fn("FileHttpApi.copy")(function* (ctx: {
      query: { path: string }
      payload: { to: string }
    }) {
      yield* svc.copy(ctx.query.path, ctx.payload.to)
      return { ok: true }
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("write", write)
      .handle("rename", rename)
      .handle("remove", remove)
      .handle("copy", copy)
      .handle("status", status)
  }),
)
