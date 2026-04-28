import { readdirSync, readFileSync, lstatSync, realpathSync } from "fs";
import { join } from "path";
import type { EndpointInfo, Extractor, ParamInfo } from "../types.ts";
import { buildLineIndex, endpoint } from "../utils.ts";
import { SKIP_DIRS } from "../scan-context.ts";

const SA_DIR_NAMES = new Set(["serveractions"]);

export function findServerActionDirs(root: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    let entries: import("fs").Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith("."))
        continue;
      const fullDir = join(dir, e.name);
      // Skip symlinked directories to prevent path traversal
      try {
        if (lstatSync(fullDir).isSymbolicLink()) continue;
        if (!realpathSync(fullDir).startsWith(root)) continue;
      } catch {
        continue;
      }
      const normalized = e.name.toLowerCase().replace(/[_-]/g, "");
      if (SA_DIR_NAMES.has(normalized)) {
        let tsFiles: string[];
        try {
          tsFiles = readdirSync(fullDir).filter(
            (f) => /\.(ts|tsx|js|jsx)$/.test(f) && !f.startsWith("_"),
          );
        } catch {
          continue;
        }
        if (tsFiles.length < 2) continue;

        let useServerCount = 0;
        for (const fname of tsFiles) {
          try {
            const head = readFileSync(join(fullDir, fname), "utf-8").slice(
              0,
              80,
            );
            if (head.includes("'use server'") || head.includes('"use server"'))
              useServerCount++;
          } catch {
            /* skip */
          }
        }
        if (useServerCount >= 2) results.push(fullDir);
      }
      walk(fullDir);
    }
  }

  walk(root);
  return results;
}

// Matches `export async function name(args)`
const exportFnRe = /export\s+async\s+function\s+(\w+)\s*\(([\s\S]*?)\)\s*[:{]/g;
// Matches `export const name = async (args)` (with optional `: Type` annotation)
const exportArrowRe =
  /export\s+const\s+(\w+)\b(?:\s*:\s*[^=]+?)?\s*=\s*async\s*\(([\s\S]*?)\)\s*(?::|=>)/g;

interface RawExport {
  index: number;
  name: string;
  params: string;
}

function findExports(content: string): RawExport[] {
  const out: RawExport[] = [];
  for (const m of content.matchAll(exportFnRe)) {
    out.push({ index: m.index!, name: m[1]!, params: m[2]! });
  }
  for (const m of content.matchAll(exportArrowRe)) {
    out.push({ index: m.index!, name: m[1]!, params: m[2]! });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/**
 * Split a string at top-level commas — depth-aware over <>{}[]() so that
 * generics like `Pick<T, 'a' | 'b'>` and destructure patterns don't get
 * torn apart at internal commas.
 */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "<" || c === "{" || c === "[" || c === "(") depth++;
    else if (c === ">" || c === "}" || c === "]" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/**
 * Find the index of the first occurrence of any character in `targets` at
 * top-level depth (ignoring chars nested inside <>{}[]()).
 */
function findTopLevelChar(s: string, targets: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "<" || c === "{" || c === "[" || c === "(") depth++;
    else if (c === ">" || c === "}" || c === "]" || c === ")") depth--;
    else if (depth === 0 && targets.includes(c)) return i;
  }
  return -1;
}

/** Extract just the binding name from a param fragment (e.g. `id?: string` → `id`). */
function paramName(part: string): string | null {
  let s = part.trim();
  if (!s) return null;
  if (s.startsWith("...")) s = s.slice(3).trimStart();
  const cut = findTopLevelChar(s, ":=");
  const head = (cut === -1 ? s : s.slice(0, cut)).trim();
  const name = head.replace(/\?$/, "").trim();
  return name || null;
}

function parseParams(funcParams: string): ParamInfo[] {
  const params: ParamInfo[] = [];
  for (const part of splitTopLevel(funcParams)) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("{")) {
      // Destructured object — recover property names
      let depth = 0;
      let close = -1;
      for (let i = 0; i < trimmed.length; i++) {
        const c = trimmed[i];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      if (close === -1) continue;
      const inside = trimmed.slice(1, close);
      // Optionality is generally per-field at the call site; default to required
      // unless the destructured arg itself has a default value (e.g. `{ x } = {}`).
      const required = !/=/.test(trimmed.slice(close + 1));
      for (const field of splitTopLevel(inside)) {
        const name = paramName(field);
        if (name) params.push({ name, location: "body", required });
      }
      continue;
    }

    const name = paramName(trimmed);
    if (!name) continue;
    // `?:` annotation or `=` default → optional
    const optional = /\?\s*:/.test(trimmed) || /=/.test(trimmed);
    params.push({ name, location: "body", required: !optional });
  }
  return params;
}

export const serverActions: Extractor = {
  id: "server_actions",
  detect(repoPath: string): boolean {
    return findServerActionDirs(repoPath).length > 0;
  },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const dirs = findServerActionDirs(ctx.repoPath);
    if (!dirs.length) return endpoints;

    for (const saDir of dirs) {
      let files: string[];
      try {
        files = readdirSync(saDir).filter(
          (f) =>
            /\.(ts|tsx|js|jsx)$/.test(f) &&
            !f.startsWith("_") &&
            f.replace(/\.\w+$/, "") !== "types",
        );
      } catch {
        continue;
      }

      for (const fname of files) {
        const fullPath = join(saDir, fname);
        ctx.filesScanned++;
        const content = ctx.readFile(fullPath);
        if (!content) continue;
        if (
          !content.includes("'use server'") &&
          !content.includes('"use server"')
        )
          continue;

        const rel = ctx.rel(fullPath);
        const moduleName = fname.replace(/\.\w+$/, "");
        const lines = buildLineIndex(content);

        for (const exp of findExports(content)) {
          endpoints.push(
            endpoint({
              method: "ACTION",
              path: `/${moduleName}/${exp.name}`,
              handler: exp.name,
              file: rel,
              line: lines.lineAt(exp.index),
              framework: "server_actions",
              params: parseParams(exp.params),
            }),
          );
        }
      }
    }

    return endpoints;
  },
};
