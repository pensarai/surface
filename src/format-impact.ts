import type { AffectedEndpoint, ImpactResult } from "./types.ts";
import { C, methodBadge, shortenPath } from "./format-util.ts";

// ---------------------------------------------------------------------------
// Impact-specific display helpers
// ---------------------------------------------------------------------------

const REASON_STYLE: Record<string, string> = {
  direct: C.green,
  handler: C.yellow,
  file: C.gray,
};

function reasonTag(reason: string): string {
  const color = REASON_STYLE[reason] ?? C.gray;
  return `${color}${reason}${C.reset}`;
}

// ---------------------------------------------------------------------------
// Table format — grouped by file
// ---------------------------------------------------------------------------

export function formatImpactTable(result: ImpactResult): string {
  const lines: string[] = [];
  const { affected, summary } = result;
  const displayPath = shortenPath(result.repoPath);

  lines.push("");
  lines.push(`  ${C.bold}Surface — diff${C.reset}`);
  lines.push("");
  lines.push(`  ${C.dim}${displayPath}${C.reset}`);
  lines.push(
    `  ${C.bold}${summary.affectedEndpoints}${C.reset} affected endpoints ${C.dim}//${C.reset} ${summary.totalEndpoints} total ${C.dim}//${C.reset} ${summary.filesChanged} files changed`,
  );

  if (affected.length === 0) {
    lines.push("");
    lines.push(`  ${C.dim}No endpoints affected by this diff.${C.reset}`);
    lines.push("");
    return lines.join("\n");
  }

  // Compute column widths
  let maxPath = 20;
  let maxHandler = 10;
  for (const a of affected) {
    if (a.endpoint.path.length > maxPath) maxPath = a.endpoint.path.length;
    if (a.endpoint.handler.length > maxHandler)
      maxHandler = a.endpoint.handler.length;
  }
  const pathW = Math.min(48, maxPath);
  const handlerW = Math.min(26, maxHandler);
  const lineW = 8 + 1 + pathW + 1 + handlerW + 2;

  // Group by file
  const byFile = new Map<string, AffectedEndpoint[]>();
  for (const a of affected) {
    const list = byFile.get(a.endpoint.file) ?? [];
    list.push(a);
    byFile.set(a.endpoint.file, list);
  }

  for (const [file, fileAffected] of byFile) {
    const countStr = `${fileAffected.length} affected`;
    const dashLen = Math.max(0, lineW - file.length - countStr.length - 2);

    lines.push("");
    lines.push(
      `  ${C.bold}${file}${C.reset} ${C.dim}${"─".repeat(dashLen)}${C.reset} ${C.dim}${countStr}${C.reset}`,
    );

    for (const a of fileAffected) {
      const ep = a.endpoint;
      const badge = methodBadge(ep.method);
      const path =
        ep.path.length > pathW
          ? ep.path.slice(0, pathW - 1) + "…"
          : ep.path.padEnd(pathW);
      const handler =
        ep.handler.length > handlerW
          ? ep.handler.slice(0, handlerW - 1) + "…"
          : ep.handler.padEnd(handlerW);

      const suffix: string[] = [reasonTag(a.reason)];
      if (ep.auth.length) suffix.push(`${C.yellow}auth${C.reset}`);
      if (a.matchedFunction)
        suffix.push(`${C.dim}fn:${a.matchedFunction}${C.reset}`);

      lines.push(
        `  ${badge} ${path} ${C.dim}${handler}${C.reset}  ${C.gray}${ep.file}:${ep.line}${C.reset}  ${suffix.join(" ")}`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

export function formatImpactJson(result: ImpactResult): string {
  const output = {
    $schema: "surface-diff/v1",
    target: result.repoPath,
    summary: result.summary,
    affected: result.affected.map((a) => {
      const obj: Record<string, unknown> = {
        method: a.endpoint.method,
        path: a.endpoint.path,
        handler: a.endpoint.handler,
        file: a.endpoint.file,
        line: a.endpoint.line,
        framework: a.endpoint.framework,
        reason: a.reason,
        hunks: a.matchedHunks.map((h) => ({
          file: h.file,
          startLine: h.startLine,
          endLine: h.endLine,
        })),
      };
      if (a.matchedFunction) obj.matchedFunction = a.matchedFunction;
      if (a.endpoint.service) obj.service = a.endpoint.service;
      if (a.endpoint.params.length) obj.params = a.endpoint.params;
      if (a.endpoint.auth.length) obj.auth = a.endpoint.auth;
      if (a.endpoint.internal) obj.internal = true;
      return obj;
    }),
  };

  return JSON.stringify(output, null, 2);
}

// ---------------------------------------------------------------------------
// NDJSON format
// ---------------------------------------------------------------------------

export function formatImpactNdjson(result: ImpactResult): string {
  const lines: string[] = [];

  lines.push(
    JSON.stringify({
      _meta: true,
      schema: "surface-diff/v1",
      target: result.repoPath,
      ...result.summary,
    }),
  );

  for (const a of result.affected) {
    const obj: Record<string, unknown> = {
      method: a.endpoint.method,
      path: a.endpoint.path,
      handler: a.endpoint.handler,
      file: a.endpoint.file,
      line: a.endpoint.line,
      framework: a.endpoint.framework,
      reason: a.reason,
      hunks: a.matchedHunks,
    };
    if (a.matchedFunction) obj.matchedFunction = a.matchedFunction;
    if (a.endpoint.service) obj.service = a.endpoint.service;
    if (a.endpoint.params.length) obj.params = a.endpoint.params;
    if (a.endpoint.auth.length) obj.auth = a.endpoint.auth;
    if (a.endpoint.internal) obj.internal = true;
    lines.push(JSON.stringify(obj));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown format
// ---------------------------------------------------------------------------

export function formatImpactMarkdown(result: ImpactResult): string {
  const { affected, summary } = result;

  const lines = [
    `# Impact Analysis`,
    "",
    `**Target:** ${result.repoPath}`,
    `**Affected:** ${summary.affectedEndpoints} of ${summary.totalEndpoints} endpoints`,
    `**Files changed:** ${summary.filesChanged} (${summary.filesWithEndpoints} with endpoints)`,
    `**Hunks analyzed:** ${summary.hunksAnalyzed}`,
  ];

  if (affected.length === 0) {
    lines.push("", "No endpoints affected by this diff.");
    return lines.join("\n");
  }

  // Group by file
  const byFile = new Map<string, AffectedEndpoint[]>();
  for (const a of affected) {
    const list = byFile.get(a.endpoint.file) ?? [];
    list.push(a);
    byFile.set(a.endpoint.file, list);
  }

  for (const [file, fileAffected] of byFile) {
    lines.push("", `## ${file} (${fileAffected.length} affected)`, "");
    lines.push("| Method | Path | Handler | Location | Reason | Auth |");
    lines.push("|--------|------|---------|----------|--------|------|");

    for (const a of fileAffected) {
      const ep = a.endpoint;
      const auth = ep.auth.join(", ");
      const reason = a.matchedFunction
        ? `${a.reason} (${a.matchedFunction})`
        : a.reason;
      lines.push(
        `| ${ep.method} | \`${ep.path}\` | ${ep.handler} | ${ep.file}:${ep.line} | ${reason} | ${auth} |`,
      );
    }
  }

  return lines.join("\n");
}
