import type { EndpointInfo, Extractor, FrameworkId } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  findAuthDecorators,
  normalizePath,
} from "../utils.ts";

const GO_EXTS = [".go"];
const GO_GROUP_RE = /(\w+)\s*[:=]+\s*(\w+)\.Group\s*\(\s*['"]([^'"]+)['"]/g;

function extractGoFramework(
  ctx: Parameters<Extractor["extract"]>[0],
  framework: FrameworkId,
  routeRe: RegExp,
): EndpointInfo[] {
  const endpoints: EndpointInfo[] = [];
  const goFiles = ctx.iterFiles(GO_EXTS);

  // Pass 1: find group definitions
  const groupPrefixes: Record<string, string> = {};
  const groupParents: Record<string, string> = {};

  for (const f of goFiles) {
    const content = ctx.readFile(f);
    if (!content) continue;
    for (const m of content.matchAll(GO_GROUP_RE)) {
      groupParents[m[1]!] = m[2]!;
      groupPrefixes[m[1]!] = m[3]!;
    }
  }

  function resolvePrefix(v: string, depth = 0): string {
    if (depth > 10 || !(v in groupPrefixes)) return "";
    const own = groupPrefixes[v]!;
    const parent = groupParents[v];
    if (parent && parent in groupPrefixes)
      return resolvePrefix(parent, depth + 1) + own;
    return own;
  }

  const resolved: Record<string, string> = {};
  for (const v of Object.keys(groupPrefixes)) resolved[v] = resolvePrefix(v);

  // Pass 2: extract routes
  for (const f of goFiles) {
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

      if (httpMethod === "ANY" || httpMethod === "ALL") httpMethod = "ANY";

      const prefix = resolved[varName] ?? "";
      const fullPath = normalizePath(prefix + routePath);
      const handlerMatch = handlerArgs.match(/(\w+)\s*[,)]/);

      endpoints.push(
        endpoint({
          method: httpMethod,
          path: fullPath,
          handler: handlerMatch ? handlerMatch[1]! : "<anonymous>",
          file: rel,
          line,
          framework,
          params: extractPathParams(fullPath),
          auth: findAuthDecorators(handlerArgs),
        }),
      );
    }
  }

  return endpoints;
}

export const gin: Extractor = {
  id: "gin",
  detect: {
    depKeywords: ["github.com/gin-gonic/gin"],
    markers: [],
    scope: "root",
  },
  extract(ctx) {
    return extractGoFramework(
      ctx,
      "gin",
      /(\w+)\s*\.\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(.*?)\)/gs,
    );
  },
};

export const echo: Extractor = {
  id: "echo",
  detect: {
    depKeywords: ["github.com/labstack/echo"],
    markers: [],
    scope: "root",
  },
  extract(ctx) {
    return extractGoFramework(
      ctx,
      "echo",
      /(\w+)\s*\.\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(.*?)\)/gs,
    );
  },
};

export const fiber: Extractor = {
  id: "fiber",
  detect: {
    depKeywords: ["github.com/gofiber/fiber"],
    markers: [],
    scope: "root",
  },
  extract(ctx) {
    return extractGoFramework(
      ctx,
      "fiber",
      /(\w+)\s*\.\s*(Get|Post|Put|Delete|Patch|Head|Options|All)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(.*?)\)/gs,
    );
  },
};

export const netHttp: Extractor = {
  id: "net_http",
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const goFiles = ctx.iterFiles(GO_EXTS);
    const handleRe =
      /(?:http\.HandleFunc|mux\.HandleFunc|http\.Handle|mux\.Handle)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/g;

    for (const f of goFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      const rel = ctx.rel(f);

      const lines = buildLineIndex(content);
      for (const m of content.matchAll(handleRe)) {
        const fullPath = normalizePath(m[1]!);
        endpoints.push(
          endpoint({
            method: "ANY",
            path: fullPath,
            handler: m[2]!,
            file: rel,
            line: lines.lineAt(m.index),
            framework: "net_http",
            params: extractPathParams(fullPath),
          }),
        );
      }
    }

    return endpoints;
  },
};
