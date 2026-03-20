import type { EndpointInfo, Extractor } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  findAuthDecorators,
  normalizePath,
} from "../utils.ts";

const JS_EXTS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"];

export const express: Extractor = {
  id: "express",
  detect: {
    depKeywords: ['"express"'],
    markers: ["app.js", "server.js", "index.js"],
    scope: "root",
    requireBoth: true,
  },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const jsFiles = ctx.iterFiles(JS_EXTS);

    // Pass 1: find router mounts
    const mountPrefixes: Record<string, string> = {};
    const mountRe =
      /(?:app|router)\s*\.\s*use\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/g;

    for (const f of jsFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      for (const m of content.matchAll(mountRe)) {
        mountPrefixes[m[2]!] = m[1]!;
      }
    }

    // Pass 2: extract route handlers
    const routeRe =
      /(\w+)\s*\.\s*(get|post|put|delete|patch|all|head|options)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(.*?)\)/gs;

    for (const f of jsFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      const rel = ctx.rel(f);
      const lines = buildLineIndex(content);

      for (const m of content.matchAll(routeRe)) {
        const varName = m[1]!;
        let httpMethod = m[2]!.toUpperCase();
        const routePath = m[3]!;
        const handlerArgs = m[4]!;
        const line = lines.lineAt(m.index);

        if (httpMethod === "ALL") httpMethod = "ANY";

        const prefix = mountPrefixes[varName] ?? "";
        const fullPath = normalizePath(prefix + routePath);
        const handlerMatch = handlerArgs.match(/(\w+)\s*[,)]/);

        endpoints.push(
          endpoint({
            method: httpMethod,
            path: fullPath,
            handler: handlerMatch ? handlerMatch[1]! : "<anonymous>",
            file: rel,
            line,
            framework: "express",
            params: extractPathParams(fullPath),
            auth: findAuthDecorators(handlerArgs),
          }),
        );
      }
    }

    return endpoints;
  },
};
