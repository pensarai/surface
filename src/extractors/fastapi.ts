import type { EndpointInfo, Extractor } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  findAuthDecorators,
  normalizePath,
} from "../utils.ts";

const PY_EXTS = [".py"];

export const fastapi: Extractor = {
  id: "fastapi",
  detect: { depKeywords: ["fastapi"], markers: [], scope: "root" },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const pyFiles = ctx.iterFiles(PY_EXTS);

    // Pass 1: find APIRouter declarations and include_router calls
    const routerPrefixes: Record<string, string> = {};
    const includePrefixes: Record<string, string> = {};

    const routerDeclRe =
      /(\w+)\s*=\s*APIRouter\s*\((?:.*?prefix\s*=\s*['"]([^'"]*)['"])?.*?\)/gs;
    const includeRe =
      /\.include_router\s*\(\s*(\w+)(?:.*?prefix\s*=\s*['"]([^'"]*)['"])?/gs;

    for (const f of pyFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      for (const m of content.matchAll(routerDeclRe)) {
        routerPrefixes[m[1]!] = m[2] ?? "";
      }
      for (const m of content.matchAll(includeRe)) {
        if (m[2] !== undefined) includePrefixes[m[1]!] = m[2];
      }
    }

    for (const [v, p] of Object.entries(includePrefixes)) {
      routerPrefixes[v] = p;
    }

    // Pass 2: extract routes
    const routeRe =
      /@(\w+)\.(get|post|put|delete|patch|head|options|websocket)\s*\(\s*['"]([^'"]+)['"]\s*(?:,.*?)?\)(.*?)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gs;

    for (const f of pyFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      const rel = ctx.rel(f);
      const lines = buildLineIndex(content);

      for (const m of content.matchAll(routeRe)) {
        const varName = m[1]!;
        let httpMethod = m[2]!.toUpperCase();
        const routePath = m[3]!;
        const between = m[4]!;
        const funcName = m[5]!;
        const funcParams = m[6]!;
        const line = lines.lineAt(m.index);

        if (httpMethod === "WEBSOCKET") httpMethod = "WS";

        const prefix = routerPrefixes[varName] ?? "";
        const fullPath = normalizePath(prefix + routePath);
        const auth = findAuthDecorators(between + funcParams);
        const params = extractPathParams(fullPath);

        for (const pm of funcParams.matchAll(
          /(\w+)\s*:\s*\w+\s*=\s*Query\(/g,
        )) {
          params.push({ name: pm[1]!, location: "query", required: true });
        }
        for (const pm of funcParams.matchAll(/(\w+)\s*:\s*\w+\s*=\s*Body\(/g)) {
          params.push({ name: pm[1]!, location: "body", required: true });
        }
        for (const pm of funcParams.matchAll(
          /(\w+)\s*:\s*\w+\s*=\s*Header\(/g,
        )) {
          params.push({ name: pm[1]!, location: "header", required: true });
        }

        endpoints.push(
          endpoint({
            method: httpMethod,
            path: fullPath,
            handler: funcName,
            file: rel,
            line,
            framework: "fastapi",
            params,
            auth,
          }),
        );
      }
    }

    return endpoints;
  },
};
