import { resolve, extname, join } from "path";
import { readFileSync } from "fs";
import type {
  AffectedEndpoint,
  DiffHunk,
  EndpointInfo,
  ImpactReason,
  ImpactResult,
} from "./types.ts";
import type { MapOptions } from "./mapper.ts";
import { mapRaw } from "./mapper.ts";
import { findFunctions } from "./function-finder.ts";

export type ImpactOptions = MapOptions;

/**
 * Determine which endpoints are affected by a set of diff hunks.
 *
 * Runs the full map pipeline (via mapRaw) to discover all endpoints,
 * then cross-references changed lines against endpoint locations
 * using three-tier matching: territory → handler → file fallback.
 */
export function impact(
  repoPath: string,
  hunks: DiffHunk[],
  options: ImpactOptions = {},
): ImpactResult {
  const resolved = resolve(repoPath);
  const raw = mapRaw(resolved, { ...options, includeInternal: true });

  const hunksByFile = groupBy(hunks, (h) => h.file);
  const epsByFile = groupBy(raw.endpoints, (ep) => ep.file);

  const matched = new Map<string, AffectedEndpoint>();
  let filesWithEndpoints = 0;

  for (const [file, fileHunks] of hunksByFile) {
    const fileEndpoints = epsByFile.get(file);
    if (!fileEndpoints || fileEndpoints.length === 0) continue;
    filesWithEndpoints++;

    matchFile(resolved, file, fileHunks, fileEndpoints, matched);
  }

  const affected = [...matched.values()];
  affected.sort(
    (a, b) =>
      a.endpoint.file.localeCompare(b.endpoint.file) ||
      a.endpoint.line - b.endpoint.line,
  );

  const finalAffected = options.includeInternal
    ? affected
    : affected.filter((a) => !a.endpoint.internal);

  return {
    repoPath: resolved,
    affected: finalAffected,
    summary: {
      totalEndpoints: raw.endpoints.length,
      affectedEndpoints: finalAffected.length,
      filesChanged: hunksByFile.size,
      filesWithEndpoints,
      hunksAnalyzed: hunks.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-file matching — three-tier: territory → handler → file fallback
// ---------------------------------------------------------------------------

function matchFile(
  repoRoot: string,
  file: string,
  hunks: DiffHunk[],
  endpoints: EndpointInfo[],
  matched: Map<string, AffectedEndpoint>,
): void {
  const sorted = [...endpoints].sort((a, b) => a.line - b.line);
  const territories = buildTerritories(sorted);
  const content = readFileSafe(join(repoRoot, file));
  const funcs = content ? findFunctions(content, extname(file)) : [];

  const firstFuncLine = funcs.length > 0 ? funcs[0]!.line : 0;

  for (const hunk of hunks) {
    // Tier 1: Territory match
    if (matchByTerritory(hunk, territories, matched)) continue;

    // Tier 2: Handler match — find enclosing function, match to handler
    if (matchByHandler(hunk, funcs, endpoints, matched)) continue;

    // Tier 3: File fallback
    // Hunk above first function def → likely imports/routing config → flag all
    // Hunk inside an unmatched function → utility/middleware → flag all
    // Both use "file" reason to signal lower confidence
    for (const ep of endpoints) {
      recordMatch(matched, ep, hunk, "file");
    }
  }
}

/**
 * Build endpoint territories. Each endpoint owns lines from its definition
 * to the next endpoint's definition - 1.
 *
 * Returns empty array for routing-config files where all endpoints are
 * clustered within 5 lines (territory matching degenerates there).
 */
function buildTerritories(
  sorted: EndpointInfo[],
): { ep: EndpointInfo; start: number; end: number }[] {
  if (sorted.length <= 1) {
    return sorted.map((ep) => ({ ep, start: ep.line, end: Infinity }));
  }

  const lineSpread = sorted[sorted.length - 1]!.line - sorted[0]!.line;
  if (lineSpread < 5) return []; // routing-config file, skip territory matching

  const territories: { ep: EndpointInfo; start: number; end: number }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const ep = sorted[i]!;
    const end = i + 1 < sorted.length ? sorted[i + 1]!.line - 1 : Infinity;
    territories.push({ ep, start: ep.line, end });
  }
  return territories;
}

function matchByTerritory(
  hunk: DiffHunk,
  territories: { ep: EndpointInfo; start: number; end: number }[],
  matched: Map<string, AffectedEndpoint>,
): boolean {
  let found = false;
  for (const t of territories) {
    if (hunk.startLine <= t.end && hunk.endLine >= t.start) {
      recordMatch(matched, t.ep, hunk, "direct");
      found = true;
    }
  }
  return found;
}

function matchByHandler(
  hunk: DiffHunk,
  funcs: { name: string; line: number }[],
  endpoints: EndpointInfo[],
  matched: Map<string, AffectedEndpoint>,
): boolean {
  const enclosing = findEnclosingFunction(funcs, hunk.startLine);
  if (!enclosing) return false;

  let found = false;
  for (const ep of endpoints) {
    if (handlerMatches(ep.handler, enclosing.name)) {
      recordMatch(matched, ep, hunk, "handler", enclosing.name);
      found = true;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Match recording — deduplicates by endpoint, upgrades reason on collision
// ---------------------------------------------------------------------------

const REASON_PRIORITY: Record<ImpactReason, number> = {
  direct: 3,
  handler: 2,
  file: 1,
};

function recordMatch(
  matched: Map<string, AffectedEndpoint>,
  ep: EndpointInfo,
  hunk: DiffHunk,
  reason: ImpactReason,
  funcName?: string,
): void {
  const key = `${ep.method}::${ep.path}`;
  const existing = matched.get(key);

  if (existing) {
    if (REASON_PRIORITY[reason] > REASON_PRIORITY[existing.reason]) {
      existing.reason = reason;
      if (funcName) existing.matchedFunction = funcName;
    }
    if (
      !existing.matchedHunks.some(
        (h) => h.startLine === hunk.startLine && h.file === hunk.file,
      )
    ) {
      existing.matchedHunks.push(hunk);
    }
  } else {
    const entry: AffectedEndpoint = {
      endpoint: ep,
      matchedHunks: [hunk],
      reason,
    };
    if (funcName) entry.matchedFunction = funcName;
    matched.set(key, entry);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findEnclosingFunction(
  funcs: { name: string; line: number }[],
  line: number,
): { name: string; line: number } | null {
  let result: { name: string; line: number } | null = null;
  for (const f of funcs) {
    if (f.line <= line) result = f;
    else break; // funcs are sorted by line
  }
  return result;
}

/**
 * Match a function name against an endpoint handler field.
 * Handles framework-specific conventions:
 * - Skip <anonymous> handlers
 * - Rails "resource#action" → match against the action part
 * - Django dotted names → match against the last segment
 */
function handlerMatches(handler: string, funcName: string): boolean {
  if (handler === "<anonymous>" || !handler || !funcName) return false;

  if (handler === funcName) return true;

  // Rails: "users#create" → match against "create"
  if (handler.includes("#")) {
    return handler.split("#").pop() === funcName;
  }

  // Django/dotted: "views.create_user" → match against "create_user"
  if (handler.includes(".")) {
    return handler.split(".").pop() === funcName;
  }

  return false;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
