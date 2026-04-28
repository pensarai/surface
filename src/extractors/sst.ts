import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import type { EndpointInfo, Extractor, ScanContext } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  normalizePath,
} from "../utils.ts";
import {
  findPackageRoot,
  resolveHandlerFile,
} from "../services/detectors/sst-shared.ts";

function detectSst(repoPath: string, ctx: ScanContext): boolean {
  // Check for sst.config.ts or "sst" in deps
  let hasSstConfig = existsSync(join(repoPath, "sst.config.ts"));
  if (!hasSstConfig) {
    // Check root dep files for '"sst"'
    const depFiles = ["package.json", "pyproject.toml", "requirements.txt"];
    for (const fname of depFiles) {
      try {
        const content = readFileSync(join(repoPath, fname), "utf-8");
        if (content.toLowerCase().includes('"sst"')) {
          hasSstConfig = true;
          break;
        }
      } catch {
        /* not found */
      }
    }
  }
  if (!hasSstConfig) return false;

  // Check infra/*.ts for .route(
  const infraDir = join(repoPath, "infra");
  if (!existsSync(infraDir)) return false;
  try {
    for (const fname of readdirSync(infraDir).filter((f) =>
      f.endsWith(".ts"),
    )) {
      const content = ctx.readFile(join(infraDir, fname));
      if (content?.includes(".route(")) return true;
    }
  } catch {
    /* skip */
  }
  return false;
}

export const sst: Extractor = {
  id: "sst",
  detect: detectSst,
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const infraDir = join(ctx.repoPath, "infra");
    if (!existsSync(infraDir)) return endpoints;

    const routeRe =
      /\.route\s*\(\s*['"](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ANY|\$default)\s+([^'"]+)['"]\s*,\s*\{(.*?)\}\s*\)/gs;
    const handlerRe = /handler\s*:\s*['"]([^'"]+)['"]/;

    let files: string[];
    try {
      files = readdirSync(infraDir)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(infraDir, f));
    } catch {
      return endpoints;
    }

    for (const f of files) {
      ctx.filesScanned++;
      const content = ctx.readFile(f);
      if (!content) continue;
      const rel = ctx.rel(f);

      const lines = buildLineIndex(content);
      for (const m of content.matchAll(routeRe)) {
        let httpMethod = m[1]!.toUpperCase();
        if (httpMethod === "$DEFAULT") httpMethod = "ANY";

        const fullPath = normalizePath(m[2]!.trim());
        const handlerMatch = handlerRe.exec(m[3]!);
        const handlerPath = handlerMatch?.[1];

        const handlerFile = handlerPath
          ? (resolveHandlerFile(ctx.repoPath, handlerPath) ?? undefined)
          : undefined;
        const serviceRoot = handlerPath
          ? (findPackageRoot(ctx.repoPath, handlerPath) ?? undefined)
          : undefined;

        endpoints.push(
          endpoint({
            method: httpMethod,
            path: fullPath,
            handler: handlerPath ? handlerPath.split(".").pop()! : "<lambda>",
            file: rel,
            line: lines.lineAt(m.index),
            framework: "sst",
            params: extractPathParams(fullPath),
            handlerFile,
            serviceRoot,
          }),
        );
      }
    }

    return endpoints;
  },
};
