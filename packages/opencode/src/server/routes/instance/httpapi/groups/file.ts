import { File } from "@/file"
import { Ripgrep } from "@/file/ripgrep"
import { LSP } from "@/lsp/lsp"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

export const FileQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
})

export const FileWritePayload = Schema.Struct({
  content: Schema.String,
})

export const FileRenamePayload = Schema.Struct({
  to: Schema.String,
})

export const FileCopyPayload = Schema.Struct({
  to: Schema.String,
})

export const FindTextQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  pattern: Schema.String,
})

export const FindFileQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  query: Schema.String,
  dirs: Schema.optional(Schema.Literals(["true", "false"])),
  type: Schema.optional(Schema.Literals(["file", "directory"])),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ),
})

export const FindSymbolQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  query: Schema.String,
})

export const FilePaths = {
  findText: "/find",
  findFile: "/find/file",
  findSymbol: "/find/symbol",
  list: "/file",
  content: "/file/content",
  write: "/file/write",
  rename: "/file/rename",
  remove: "/file/remove",
  copy: "/file/copy",
  status: "/file/status",
} as const

export const FileApi = HttpApi.make("file")
  .add(
    HttpApiGroup.make("file")
      .add(
        HttpApiEndpoint.get("findText", FilePaths.findText, {
          query: FindTextQuery,
          success: described(Schema.Array(Ripgrep.SearchMatch), "Matches"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.text",
            summary: "Find text",
            description: "Search for text patterns across files in the project using ripgrep.",
          }),
        ),
        HttpApiEndpoint.get("findFile", FilePaths.findFile, {
          query: FindFileQuery,
          success: described(Schema.Array(Schema.String), "File paths"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.files",
            summary: "Find files",
            description: "Search for files or directories by name or pattern in the project directory.",
          }),
        ),
        HttpApiEndpoint.get("findSymbol", FilePaths.findSymbol, {
          query: FindSymbolQuery,
          success: described(Schema.Array(LSP.Symbol), "Symbols"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.symbols",
            summary: "Find symbols",
            description: "Search for workspace symbols like functions, classes, and variables using LSP.",
          }),
        ),
        HttpApiEndpoint.get("list", FilePaths.list, {
          query: FileQuery,
          success: described(Schema.Array(File.Node), "Files and directories"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.list",
            summary: "List files",
            description: "List files and directories in a specified path.",
          }),
        ),
        HttpApiEndpoint.get("content", FilePaths.content, {
          query: FileQuery,
          success: described(File.Content, "File content"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.read",
            summary: "Read file",
            description: "Read the content of a specified file.",
          }),
        ),
        HttpApiEndpoint.post("write", FilePaths.write, {
          query: FileQuery,
          payload: FileWritePayload,
          success: described(File.Content, "File written"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.write",
            summary: "Write file",
            description: "Write content to a file in the project directory.",
          }),
        ),
        HttpApiEndpoint.get("status", FilePaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(File.Info), "File status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.status",
            summary: "Get file status",
            description: "Get the git status of all files in the project.",
          }),
        ),
        HttpApiEndpoint.post("rename", FilePaths.rename, {
          query: FileQuery,
          payload: FileRenamePayload,
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Rename result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.rename",
            summary: "Rename file",
            description: "Rename or move a file or directory.",
          }),
        ),
        HttpApiEndpoint.delete("remove", FilePaths.remove, {
          query: FileQuery,
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Delete result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.remove",
            summary: "Delete file",
            description: "Delete a file or directory.",
          }),
        ),
        HttpApiEndpoint.post("copy", FilePaths.copy, {
          query: FileQuery,
          payload: FileCopyPayload,
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Copy result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.copy",
            summary: "Copy file",
            description: "Copy a file or directory.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "file",
          description: "Experimental HttpApi file routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
