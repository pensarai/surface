import type { EndpointInfo, MapResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Color system — respects NO_COLOR, FORCE_COLOR, and TTY detection
// ---------------------------------------------------------------------------

const HAS_COLOR =
  process.env.FORCE_COLOR !== undefined ||
  (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);

function ansi(code: string): string {
  return HAS_COLOR ? code : "";
}

const C = {
  reset: ansi("\x1b[0m"),
  dim: ansi("\x1b[2m"),
  bold: ansi("\x1b[1m"),
  white: ansi("\x1b[37m"),
  black: ansi("\x1b[30m"),
  gray: ansi("\x1b[90m"),
  yellow: ansi("\x1b[33m"),
  green: ansi("\x1b[32m"),
  red: ansi("\x1b[31m"),
  magenta: ansi("\x1b[35m"),
  cyan: ansi("\x1b[36m"),
  blue: ansi("\x1b[34m"),
  bgGreen: ansi("\x1b[42m"),
  bgYellow: ansi("\x1b[43m"),
  bgBlue: ansi("\x1b[44m"),
  bgCyan: ansi("\x1b[46m"),
  bgRed: ansi("\x1b[41m"),
  bgMagenta: ansi("\x1b[45m"),
  bgGray: ansi("\x1b[100m"),
};

const METHOD_STYLE: Record<string, { bg: string; fg: string }> = {
  GET: { bg: C.bgGreen, fg: C.black },
  POST: { bg: C.bgYellow, fg: C.black },
  PUT: { bg: C.bgBlue, fg: C.white },
  PATCH: { bg: C.bgCyan, fg: C.black },
  DELETE: { bg: C.bgRed, fg: C.white },
  ANY: { bg: C.bgGray, fg: C.white },
  WS: { bg: C.bgMagenta, fg: C.white },
  ACTION: { bg: C.bgMagenta, fg: C.white },
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatParams(ep: EndpointInfo): string {
  if (ep.params.length === 0) return "";
  const pathParams = ep.params.filter((p) => p.location === "path");
  const otherParams = ep.params.filter((p) => p.location !== "path");
  const parts: string[] = [];
  if (pathParams.length) parts.push(pathParams.map((p) => p.name).join(", "));
  if (otherParams.length > 3) {
    parts.push(`${otherParams.length} params`);
  } else if (otherParams.length) {
    parts.push(otherParams.map((p) => p.name).join(", "));
  }
  return parts.join(", ");
}

function shortenPath(fullPath: string): string {
  const home = process.env.HOME ?? "";
  if (home && fullPath.startsWith(home))
    return "~" + fullPath.slice(home.length);
  return fullPath;
}

function methodBadge(method: string): string {
  const style = METHOD_STYLE[method] ?? { bg: C.bgGray, fg: C.white };
  if (!HAS_COLOR) return ` ${method.padEnd(6)} `;
  return `${style.bg}${style.fg}${C.bold} ${method.padEnd(6)} ${C.reset}`;
}

// ---------------------------------------------------------------------------
// Table format — human-readable, designed for terminal
// ---------------------------------------------------------------------------

export function formatTable(result: MapResult): string {
  const lines: string[] = [];
  const { endpoints } = result;
  const fwCounts = endpoints.frameworkCounts();
  const displayPath = shortenPath(result.repoPath);

  // Header
  lines.push("");
  lines.push(`  ${C.bold}Surface${C.reset}`);
  lines.push("");
  lines.push(`  ${C.dim}${displayPath}${C.reset}`);

  const fwSummary = [...fwCounts.entries()]
    .map(([fw, n]) => `${C.bold}${fw}${C.reset} ${C.dim}${n}${C.reset}`)
    .join("   ");
  lines.push(
    `  ${result.filesScanned} files ${C.dim}//${C.reset} ${C.bold}${endpoints.length}${C.reset} endpoints ${C.dim}//${C.reset} ${fwSummary}`,
  );

  if (endpoints.length === 0) {
    lines.push("");
    lines.push(`  ${C.yellow}No endpoints discovered.${C.reset}`);
    lines.push(
      `  ${C.dim}Try --framework to force a specific framework.${C.reset}`,
    );
    lines.push("");
    return lines.join("\n");
  }

  // Column widths
  let maxPath = 20;
  let maxHandler = 10;
  for (const ep of endpoints) {
    if (ep.path.length > maxPath) maxPath = ep.path.length;
    if (ep.handler.length > maxHandler) maxHandler = ep.handler.length;
  }
  const pathW = Math.min(48, maxPath);
  const handlerW = Math.min(26, maxHandler);
  const lineW = 8 + 1 + pathW + 1 + handlerW + 2;

  // Sections
  for (const [framework, fwEndpoints] of endpoints.groupByFramework()) {
    const countStr = `${fwEndpoints.length} endpoints`;
    const dashLen = Math.max(0, lineW - framework.length - countStr.length - 2);

    lines.push("");
    lines.push(
      `  ${C.bold}${framework}${C.reset} ${C.dim}${"─".repeat(dashLen)}${C.reset} ${C.dim}${countStr}${C.reset}`,
    );

    for (const ep of fwEndpoints) {
      const badge = methodBadge(ep.method);
      const path =
        ep.path.length > pathW
          ? ep.path.slice(0, pathW - 1) + "…"
          : ep.path.padEnd(pathW);
      const handler =
        ep.handler.length > handlerW
          ? ep.handler.slice(0, handlerW - 1) + "…"
          : ep.handler.padEnd(handlerW);

      const suffix: string[] = [];
      if (ep.auth.length) suffix.push(`${C.yellow}auth${C.reset}`);
      const params = formatParams(ep);
      if (params) suffix.push(`${C.dim}${params}${C.reset}`);

      const extra = suffix.length ? `  ${suffix.join(" ")}` : "";

      lines.push(
        `  ${badge} ${path} ${C.dim}${handler}${C.reset}  ${C.gray}${ep.file}:${ep.line}${C.reset}${extra}`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON format (structured, agent-friendly)
// ---------------------------------------------------------------------------

export function formatJson(result: MapResult): string {
  const { endpoints } = result;

  return JSON.stringify(
    {
      $schema: "surface/v1",
      target: result.repoPath,
      summary: {
        total: endpoints.length,
        filesScanned: result.filesScanned,
        byFramework: Object.fromEntries(endpoints.frameworkCounts()),
        byMethod: endpoints.methodCounts(),
      },
      endpoints: endpoints.all.map((e) => ({
        method: e.method,
        path: e.path,
        handler: e.handler,
        file: e.file,
        line: e.line,
        framework: e.framework,
        params: e.params.length ? e.params : undefined,
        auth: e.auth.length ? e.auth : undefined,
        internal: e.internal || undefined,
      })),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// NDJSON format (one JSON object per line — ideal for streaming/piping/agents)
// ---------------------------------------------------------------------------

export function formatNdjson(result: MapResult): string {
  const { endpoints } = result;
  const lines: string[] = [];

  lines.push(
    JSON.stringify({
      _meta: true,
      schema: "surface/v1",
      target: result.repoPath,
      total: endpoints.length,
      filesScanned: result.filesScanned,
      frameworks: Object.fromEntries(endpoints.frameworkCounts()),
    }),
  );

  for (const e of endpoints) {
    const obj: Record<string, unknown> = {
      method: e.method,
      path: e.path,
      handler: e.handler,
      file: e.file,
      line: e.line,
      framework: e.framework,
    };
    if (e.params.length) obj.params = e.params;
    if (e.auth.length) obj.auth = e.auth;
    if (e.internal) obj.internal = true;
    lines.push(JSON.stringify(obj));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown format
// ---------------------------------------------------------------------------

export function formatMarkdown(result: MapResult): string {
  const { endpoints } = result;
  const fwCounts = endpoints.frameworkCounts();
  const fwSummary = [...fwCounts.entries()]
    .map(([fw, n]) => `${fw} (${n})`)
    .join(", ");

  const lines = [
    `# Endpoint Map`,
    "",
    `**Target:** ${result.repoPath}`,
    `**Endpoints:** ${endpoints.length} — ${fwSummary}`,
    `**Files scanned:** ${result.filesScanned}`,
  ];

  for (const [framework, fwEndpoints] of endpoints.groupByFramework()) {
    lines.push("", `## ${framework} (${fwEndpoints.length})`, "");
    lines.push("| Method | Path | Handler | Location | Auth |");
    lines.push("|--------|------|---------|----------|------|");

    for (const ep of fwEndpoints) {
      const auth = ep.auth.join(", ");
      lines.push(
        `| ${ep.method} | \`${ep.path}\` | ${ep.handler} | ${ep.file}:${ep.line} | ${auth} |`,
      );
    }
  }

  return lines.join("\n");
}
