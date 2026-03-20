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

export const serverActions: Extractor = {
  id: "server_actions",
  detect(repoPath: string): boolean {
    return findServerActionDirs(repoPath).length > 0;
  },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const dirs = findServerActionDirs(ctx.repoPath);
    if (!dirs.length) return endpoints;

    const exportFnRe = /export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)/g;

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

        for (const m of content.matchAll(exportFnRe)) {
          const funcName = m[1]!;
          const funcParams = m[2]!;

          // Parse params — handle destructured objects cleanly
          const params: ParamInfo[] = [];
          const cleaned = funcParams
            .replace(/\{[^}]*\}/g, "_destructured_")
            .replace(/\([^)]*\)/g, "");
          for (const p of cleaned.split(",")) {
            const trimmed = p.trim();
            if (!trimmed) continue;
            const paramName = trimmed.split(":")[0]!.split("?")[0]!.trim();
            if (paramName)
              params.push({
                name: paramName,
                location: "body",
                required: !trimmed.includes("?"),
              });
          }

          endpoints.push(
            endpoint({
              method: "ACTION",
              path: `/${moduleName}/${funcName}`,
              handler: funcName,
              file: rel,
              line: lines.lineAt(m.index),
              framework: "server_actions",
              params,
            }),
          );
        }
      }
    }

    return endpoints;
  },
};
