import type { DiffHunk } from "./types.ts";

const FILE_RE = /^\+\+\+ b\/(.+)$/;
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const DEV_NULL = "/dev/null";

/**
 * Parse a unified diff into typed hunk objects.
 *
 * Extracts changed file paths and new-side line ranges.
 * Skips deleted files and binary diffs.
 */
export function parseDiff(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentFile: string | null = null;

  for (const line of diffText.split("\n")) {
    // Binary diffs — skip until next file header
    if (line.startsWith("Binary files ")) {
      currentFile = null;
      continue;
    }

    const fileMatch = FILE_RE.exec(line);
    if (fileMatch) {
      const path = fileMatch[1]!;
      // Deleted files have no endpoints in the current codebase
      currentFile = path === DEV_NULL ? null : normalizeDiffPath(path);
      continue;
    }

    if (!currentFile) continue;

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      const start = parseInt(hunkMatch[1]!, 10);
      const count =
        hunkMatch[2] !== undefined ? parseInt(hunkMatch[2]!, 10) : 1;
      if (count === 0) continue; // pure deletion hunk, no new-side lines
      hunks.push({
        file: currentFile,
        startLine: start,
        endLine: start + count - 1,
      });
    }
  }

  return hunks;
}

/**
 * Normalize a diff file path to match endpoint file paths.
 * Repo-root-relative, forward slashes, no leading ./ or /
 */
function normalizeDiffPath(p: string): string {
  let out = p.replace(/\\/g, "/");
  if (out.startsWith("./")) out = out.slice(2);
  if (out.startsWith("/")) out = out.slice(1);
  return out;
}
