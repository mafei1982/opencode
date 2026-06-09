import { describe, expect, test } from "bun:test"
import { filterSummaryDiffs, sanitizeMessageSummary } from "../../src/session/summary-diff-filter"

describe("summary diff filtering", () => {
  test("drops plugin-generated subagent prompt files from summary diffs", () => {
    const diffs = filterSummaryDiffs([
      {
        file: "workspaces\\task_foo\\_subagent_prompts\\flow-planner.prompt.json",
        additions: 7,
        deletions: 0,
        patch: "prompt payload",
        status: "added" as const,
      },
      {
        file: "src/report.ts",
        additions: 3,
        deletions: 1,
        patch: "real change",
        status: "modified" as const,
      },
    ])

    expect(diffs).toHaveLength(1)
    expect(diffs[0]?.file).toBe("src/report.ts")
  })

  test("removes empty user summaries when they only contain internal prompt diffs", () => {
    const summary = sanitizeMessageSummary({
      diffs: [
        {
          file: "workspaces/task_foo/_subagent_prompts/component-worker_step_1.prompt.json",
          additions: 1,
          deletions: 0,
          patch: "prompt payload",
          status: "added" as const,
        },
      ],
    })

    expect(summary).toBeUndefined()
  })

  test("preserves non-diff summary fields while stripping internal prompt diffs", () => {
    const summary = sanitizeMessageSummary({
      title: "Files changed",
      diffs: [
        {
          file: "workspaces/task_foo/_subagent_prompts/flow-planner.prompt.json",
          additions: 7,
          deletions: 0,
          patch: "prompt payload",
          status: "added" as const,
        },
      ],
    })

    expect(summary).toEqual({ title: "Files changed", diffs: [] })
  })
})