import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>, init?: RequestInit) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  const headers = new Headers(init?.headers)
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(new Request(url, { ...init, headers }), context)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([])
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const [text, symbols] = await Promise.all([
      request(FilePaths.findText, tmp.path, { pattern: "needle" }),
      request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
    ])
    const files = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" })
          const body = await response.json()
          return body.includes("hello.txt") ? { response, body } : undefined
        }),
        "file search index was not ready",
      ),
    )

    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

    expect(files.response.status).toBe(200)
    expect(files.body).toContain("hello.txt")

    expect(symbols.status).toBe(200)
    expect(await symbols.json()).toEqual([])
  })

  test("serves file mutation endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const write = await request(
      FilePaths.write,
      tmp.path,
      { path: "hello.txt" },
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "updated" }) },
    )
    const rename = await request(
      FilePaths.rename,
      tmp.path,
      { path: "hello.txt" },
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "renamed.txt" }) },
    )
    const copy = await request(
      FilePaths.copy,
      tmp.path,
      { path: "renamed.txt" },
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "copied.txt" }) },
    )
    const remove = await request(FilePaths.remove, tmp.path, { path: "renamed.txt" }, { method: "DELETE" })

    expect(write.status).toBe(200)
    expect(await write.json()).toMatchObject({ type: "text", content: "updated" })
    expect(rename.status).toBe(200)
    expect(copy.status).toBe(200)
    expect(remove.status).toBe(200)
    expect(await Bun.file(path.join(tmp.path, "copied.txt")).text()).toBe("updated")
    expect(await Bun.file(path.join(tmp.path, "renamed.txt")).exists()).toBe(false)
  })
})
