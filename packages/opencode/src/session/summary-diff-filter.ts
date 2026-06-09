import { Snapshot } from "@/snapshot"

const INTERNAL_PROMPT_SEGMENT = "/_subagent_prompts/"

function normalizeSummaryDiffFile(file: string) {
  return file.replaceAll("\\", "/")
}

export function isInternalSummaryDiff(input: Pick<Snapshot.FileDiff, "file">) {
  if (!input.file) return false
  const file = normalizeSummaryDiffFile(input.file)
  return file.includes(INTERNAL_PROMPT_SEGMENT) || file.startsWith(INTERNAL_PROMPT_SEGMENT.slice(1))
}

export function filterSummaryDiffs<T extends Snapshot.FileDiff>(diffs: readonly T[]) {
  return diffs.filter((item) => !isInternalSummaryDiff(item))
}

type MessageSummary = {
  title?: string
  body?: string
  diffs: Snapshot.FileDiff[]
}

export function sanitizeMessageSummary<T extends MessageSummary>(summary: T | undefined) {
  if (!summary) return summary
  const diffs = filterSummaryDiffs(summary.diffs)
  if (diffs.length === summary.diffs.length) return summary
  if (diffs.length === 0 && summary.title === undefined && summary.body === undefined) return undefined
  return {
    ...summary,
    diffs,
  } as T
}