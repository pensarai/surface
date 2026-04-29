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

// Websocket detection signals:
//   - File imports "github.com/gorilla/websocket" (the de-facto Go ws lib).
//   - Handler function body contains a `.Upgrade(` call (gorilla's upgrader,
//     also gin's c.Upgrade()).
// When both hold, the route is a websocket. Default remains "api".
const GORILLA_WS_IMPORT_RE = /["']github\.com\/gorilla\/websocket["']/;
const UPGRADE_CALL_RE = /\.\s*Upgrade\s*\(/;

/**
 * Build a per-file map of websocket-handler names. A file's handler is a
 * websocket handler iff the file imports gorilla/websocket AND the function
 * body contains `.Upgrade(`. Returns the set of handler names found across
 * all scanned Go files (handler names are typically globally unique within
 * a Go package, which is good enough for this heuristic).
 */
function findWebsocketHandlers(
  ctx: Parameters<Extractor["extract"]>[0],
  goFiles: string[],
): Set<string> {
  const wsHandlers = new Set<string>();
  // Match a top-level `func Name(...)` or `func (recv T) Name(...)` and capture
  // its body via balanced braces below.
  const funcRe = /\bfunc\s+(?:\([^)]*\)\s+)?(\w+)\s*\([^)]*\)[^{]*\{/g;

  for (const f of goFiles) {
    const content = ctx.readFile(f);
    if (!content) continue;
    if (!GORILLA_WS_IMPORT_RE.test(content)) continue;

    for (const m of content.matchAll(funcRe)) {
      const name = m[1]!;
      const bodyStart = m.index + m[0].length; // just past the opening `{`
      // Walk forward to find the matching closing brace (naive — does not
      // strip comments/strings, but Go's `{`/`}` balance in source is reliable
      // enough for this heuristic).
      let depth = 1;
      let i = bodyStart;
      const len = content.length;
      while (i < len && depth > 0) {
        const ch = content[i]!;
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
      const body = content.slice(bodyStart, i - 1);
      if (UPGRADE_CALL_RE.test(body)) wsHandlers.add(name);
    }
  }
  return wsHandlers;
}

function extractGoFramework(
  ctx: Parameters<Extractor["extract"]>[0],
  framework: FrameworkId,
  routeRe: RegExp,
): EndpointInfo[] {
  const endpoints: EndpointInfo[] = [];
  const goFiles = ctx.iterFiles(GO_EXTS);

  // Pass 0: collect websocket handler names across the repo.
  const wsHandlers = findWebsocketHandlers(ctx, goFiles);

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
    // A route's handler is a ws handler if either:
    //   (a) the resolved handler name is in wsHandlers, OR
    //   (b) the route handler args themselves contain `.Upgrade(` (inline
    //       upgrade) AND the file imports gorilla/websocket.
    const fileImportsGorilla = GORILLA_WS_IMPORT_RE.test(content);

    for (const m of content.matchAll(routeRe)) {
      const varName = m[1]!;
      let httpMethod = m[2]!.toUpperCase();
      const routePath = m[3]!;
      const handlerArgs = m[4]!;
      const line = lines.lineAt(m.index);

      if (httpMethod === "ANY" || httpMethod === "ALL") httpMethod = "ANY";

      const prefix = resolved[varName] ?? "";
      const fullPath = normalizePath(prefix + routePath);
      // Handler is the LAST identifier in the args (the route call may include
      // preceding middleware, e.g. `r.GET(path, authMW, handler)`).
      const idMatches = [...handlerArgs.matchAll(/(\w+)/g)];
      const handlerName =
        idMatches.length > 0
          ? idMatches[idMatches.length - 1]![1]!
          : "<anonymous>";

      const inlineUpgrade =
        fileImportsGorilla && UPGRADE_CALL_RE.test(handlerArgs);
      const isWebsocket = wsHandlers.has(handlerName) || inlineUpgrade;

      endpoints.push(
        endpoint({
          method: isWebsocket ? "WS" : httpMethod,
          kind: isWebsocket ? "websocket" : "api",
          path: fullPath,
          handler: handlerName,
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

    // gorilla/websocket import + .Upgrade() call in handler body = websocket route.
    const wsHandlers = findWebsocketHandlers(ctx, goFiles);

    for (const f of goFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      const rel = ctx.rel(f);

      const lines = buildLineIndex(content);
      for (const m of content.matchAll(handleRe)) {
        const fullPath = normalizePath(m[1]!);
        const handlerName = m[2]!;
        const isWebsocket = wsHandlers.has(handlerName);
        endpoints.push(
          endpoint({
            method: isWebsocket ? "WS" : "ANY",
            kind: isWebsocket ? "websocket" : "api",
            path: fullPath,
            handler: handlerName,
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
