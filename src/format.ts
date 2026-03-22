import type { EndpointInfo, MapResult, ServiceInfo } from "./types.ts";
import { C, methodBadge, shortenPath } from "./format-util.ts";

// ---------------------------------------------------------------------------
// Public options — controls grouping behavior across all formatters
// ---------------------------------------------------------------------------

export type GroupBy = "auto" | "service" | "framework";

export interface FormatOptions {
  groupBy?: GroupBy;
}

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

/**
 * Resolve "auto" grouping: use service if services were detected and
 * at least one endpoint has a service assignment, otherwise framework.
 */
function resolveGroupBy(
  result: MapResult,
  options?: FormatOptions,
): "service" | "framework" {
  const mode = options?.groupBy ?? "auto";
  if (mode === "service") return "service";
  if (mode === "framework") return "framework";
  // auto: use service grouping if services were detected
  return result.services.length > 0 ? "service" : "framework";
}

/**
 * Build a lookup from service name → ServiceInfo for O(1) access.
 */
function serviceMap(services: ServiceInfo[]): Map<string, ServiceInfo> {
  return new Map(services.map((s) => [s.name, s]));
}

// ---------------------------------------------------------------------------
// Shared section rendering — endpoint rows used by table formatter
// ---------------------------------------------------------------------------

function renderEndpointRows(
  endpoints: EndpointInfo[],
  pathW: number,
  handlerW: number,
): string[] {
  const lines: string[] = [];
  for (const ep of endpoints) {
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
  return lines;
}

/**
 * Compute column widths from endpoints.
 */
function columnWidths(endpoints: Iterable<EndpointInfo>): {
  pathW: number;
  handlerW: number;
  lineW: number;
} {
  let maxPath = 20;
  let maxHandler = 10;
  for (const ep of endpoints) {
    if (ep.path.length > maxPath) maxPath = ep.path.length;
    if (ep.handler.length > maxHandler) maxHandler = ep.handler.length;
  }
  const pathW = Math.min(48, maxPath);
  const handlerW = Math.min(26, maxHandler);
  const lineW = 8 + 1 + pathW + 1 + handlerW + 2;
  return { pathW, handlerW, lineW };
}

// ---------------------------------------------------------------------------
// Table format — human-readable, designed for terminal
// ---------------------------------------------------------------------------

export function formatTable(
  result: MapResult,
  options?: FormatOptions,
): string {
  const lines: string[] = [];
  const { endpoints } = result;
  const displayPath = shortenPath(result.repoPath);
  const groupBy = resolveGroupBy(result, options);

  // Header
  lines.push("");
  lines.push(`  ${C.bold}Surface${C.reset}`);
  lines.push("");
  lines.push(`  ${C.dim}${displayPath}${C.reset}`);

  // Summary line — show service counts if grouping by service, else framework
  const counts =
    groupBy === "service" && result.services.length > 0
      ? endpoints.serviceCounts()
      : endpoints.frameworkCounts();
  const countsSummary = [...counts.entries()]
    .map(([k, n]) => `${C.bold}${k}${C.reset} ${C.dim}${n}${C.reset}`)
    .join("   ");
  lines.push(
    `  ${result.filesScanned} files ${C.dim}//${C.reset} ${C.bold}${endpoints.length}${C.reset} endpoints ${C.dim}//${C.reset} ${countsSummary}`,
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

  const { pathW, handlerW, lineW } = columnWidths(endpoints);

  if (groupBy === "service" && result.services.length > 0) {
    const svcLookup = serviceMap(result.services);
    const grouped = endpoints.groupByService();

    for (const [svcName, svcEndpoints] of grouped) {
      const info = svcLookup.get(svcName);
      const label = svcName || "unassigned";
      const typeLabel = info ? info.type : "unknown";
      const countStr = `${typeLabel}  ${svcEndpoints.length} endpoints`;
      const dashLen = Math.max(0, lineW - label.length - countStr.length - 2);

      lines.push("");
      lines.push(
        `  ${C.bold}${label}${C.reset} ${C.dim}${"─".repeat(dashLen)}${C.reset} ${C.dim}${countStr}${C.reset}`,
      );
      lines.push(...renderEndpointRows(svcEndpoints, pathW, handlerW));
    }
  } else {
    for (const [framework, fwEndpoints] of endpoints.groupByFramework()) {
      const countStr = `${fwEndpoints.length} endpoints`;
      const dashLen = Math.max(
        0,
        lineW - framework.length - countStr.length - 2,
      );

      lines.push("");
      lines.push(
        `  ${C.bold}${framework}${C.reset} ${C.dim}${"─".repeat(dashLen)}${C.reset} ${C.dim}${countStr}${C.reset}`,
      );
      lines.push(...renderEndpointRows(fwEndpoints, pathW, handlerW));
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON format (structured, agent-friendly)
// ---------------------------------------------------------------------------

export function formatJson(result: MapResult, options?: FormatOptions): string {
  const { endpoints } = result;
  const groupBy = resolveGroupBy(result, options);

  const summary: Record<string, unknown> = {
    total: endpoints.length,
    filesScanned: result.filesScanned,
    byFramework: Object.fromEntries(endpoints.frameworkCounts()),
    byMethod: endpoints.methodCounts(),
  };

  if (groupBy === "service" && result.services.length > 0) {
    summary.byService = Object.fromEntries(endpoints.serviceCounts());
  }

  const output: Record<string, unknown> = {
    $schema: "surface/v1",
    target: result.repoPath,
    summary,
    endpoints: endpoints.all.map((e) => {
      const obj: Record<string, unknown> = {
        method: e.method,
        path: e.path,
        handler: e.handler,
        file: e.file,
        line: e.line,
        framework: e.framework,
      };
      if (e.service) obj.service = e.service;
      if (e.params.length) obj.params = e.params;
      if (e.auth.length) obj.auth = e.auth;
      if (e.internal) obj.internal = true;
      return obj;
    }),
  };

  if (result.services.length > 0) {
    output.services = result.services;
  }

  return JSON.stringify(output, null, 2);
}

// ---------------------------------------------------------------------------
// NDJSON format (one JSON object per line — ideal for streaming/piping/agents)
// ---------------------------------------------------------------------------

export function formatNdjson(
  result: MapResult,
  options?: FormatOptions,
): string {
  const { endpoints } = result;
  const lines: string[] = [];

  const meta: Record<string, unknown> = {
    _meta: true,
    schema: "surface/v1",
    target: result.repoPath,
    total: endpoints.length,
    filesScanned: result.filesScanned,
    frameworks: Object.fromEntries(endpoints.frameworkCounts()),
  };

  if (result.services.length > 0) {
    meta.services = result.services;
  }

  lines.push(JSON.stringify(meta));

  for (const e of endpoints) {
    const obj: Record<string, unknown> = {
      method: e.method,
      path: e.path,
      handler: e.handler,
      file: e.file,
      line: e.line,
      framework: e.framework,
    };
    if (e.service) obj.service = e.service;
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

export function formatMarkdown(
  result: MapResult,
  options?: FormatOptions,
): string {
  const { endpoints } = result;
  const groupBy = resolveGroupBy(result, options);

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

  if (result.services.length > 0) {
    const svcSummary = result.services
      .map((s) => `${s.name} (${s.type})`)
      .join(", ");
    lines.push(`**Services:** ${svcSummary}`);
  }

  if (groupBy === "service" && result.services.length > 0) {
    const svcLookup = serviceMap(result.services);
    const grouped = endpoints.groupByService();

    for (const [svcName, svcEndpoints] of grouped) {
      const info = svcLookup.get(svcName);
      const label = svcName || "unassigned";
      const typeLabel = info ? info.type : "unknown";
      lines.push(
        "",
        `## ${label} (${typeLabel}) — ${svcEndpoints.length} endpoints`,
        "",
      );
      lines.push("| Method | Path | Handler | Location | Auth |");
      lines.push("|--------|------|---------|----------|------|");

      for (const ep of svcEndpoints) {
        const auth = ep.auth.join(", ");
        lines.push(
          `| ${ep.method} | \`${ep.path}\` | ${ep.handler} | ${ep.file}:${ep.line} | ${auth} |`,
        );
      }
    }
  } else {
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
  }

  return lines.join("\n");
}
