import type { EndpointInfo, Extractor } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  normalizePath,
} from "../utils.ts";
import { join } from "path";

export const laravel: Extractor = {
  id: "laravel",
  detect: {
    depKeywords: ["laravel/framework"],
    markers: ["routes/web.php", "routes/api.php"],
    scope: "all",
  },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const routeFiles = [
      join(ctx.repoPath, "routes", "web.php"),
      join(ctx.repoPath, "routes", "api.php"),
    ];

    const routeRe =
      /Route\s*::\s*(get|post|put|patch|delete|any|match)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(.*?)\)/gs;
    const prefixGroupRe = /Route\s*::\s*prefix\s*\(\s*['"]([^'"]+)['"]/g;
    const middlewareGroupRe =
      /Route\s*::\s*middleware\s*\(\s*['"]([^'"]+)['"]/g;

    for (const rf of routeFiles) {
      const content = ctx.readFile(rf);
      if (!content) continue;
      ctx.filesScanned++;
      const rel = ctx.rel(rf);

      const filePrefix = rf.endsWith("api.php") ? "/api" : "";

      const groupPrefixes: string[] = [];
      for (const pm of content.matchAll(prefixGroupRe)) {
        groupPrefixes.push(pm[1]!);
      }
      const prefix =
        filePrefix +
        (groupPrefixes.length ? "/" + groupPrefixes.join("/") : "");

      const fileAuth: string[] = [];
      for (const mm of content.matchAll(middlewareGroupRe)) {
        if (mm[1]!.toLowerCase().includes("auth")) {
          fileAuth.push(`middleware(${mm[1]})`);
        }
      }

      const lines = buildLineIndex(content);
      for (const m of content.matchAll(routeRe)) {
        let httpMethod = m[1]!.toUpperCase();
        if (httpMethod === "MATCH") httpMethod = "ANY";

        const fullPath = normalizePath(prefix + "/" + m[2]!);
        const handlerRef = m[3]!.trim();
        const handlerMatch = handlerRef.match(/['"](\w+)['"]/);

        endpoints.push(
          endpoint({
            method: httpMethod,
            path: fullPath,
            handler: handlerMatch ? handlerMatch[1]! : handlerRef.slice(0, 40),
            file: rel,
            line: lines.lineAt(m.index),
            framework: "laravel",
            params: extractPathParams(fullPath),
            auth: [...fileAuth],
          }),
        );
      }
    }

    return endpoints;
  },
};
