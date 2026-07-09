import type { EndpointInfo, Extractor } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  findAuthDecorators,
  normalizePath,
} from "../utils.ts";

const JS_EXTS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"];

// Kind detection signals (inspected against the full route call body):
//   - res.render(...)   → server-side rendered page
//   - res.sendFile(...) → file response, treated as a page
//   - default           → api
const PAGE_RENDER_RE = /\bres\s*\.\s*render\s*\(/;
const PAGE_SENDFILE_RE = /\bres\s*\.\s*sendFile\s*\(/;

/**
 * Walks forward from `start` (the index of the opening `(`) and returns the
 * index of the matching closing `)`, respecting nested parens, brackets,
 * braces, string literals, template literals, and line/block comments.
 *
 * Returns -1 if no match is found before EOF.
 */
function findMatchingParen(content: string, start: number): number {
  let depth = 0;
  let i = start;
  const len = content.length;

  while (i < len) {
    const ch = content[i]!;

    // Line comment
    if (ch === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl + 1;
      continue;
    }
    // Block comment
    if (ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    // String literals (', ", `)
    if (ch === "'" || ch === '"') {
      i++;
      while (i < len) {
        const c = content[i]!;
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === ch) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "`") {
      i++;
      while (i < len) {
        const c = content[i]!;
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "`") {
          i++;
          break;
        }
        // Template expression ${...}
        if (c === "$" && content[i + 1] === "{") {
          i += 2;
          let d = 1;
          while (i < len && d > 0) {
            const cc = content[i]!;
            if (cc === "{") d++;
            else if (cc === "}") d--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }

    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0 && ch === ")") return i;
    }
    i++;
  }
  return -1;
}

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

    // Pass 1: find router mounts, e.g. `app.use("/api", router)`
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

    // Pass 2: HTTP route handlers + express-ws routes
    // We scan for the route-call opener, then balance parens to capture the
    // ENTIRE call (so handler bodies — even multi-line arrow fns — are
    // available for kind detection).
    //
    // Methods include `ws` to capture express-ws routes (`app.ws("/path", ...)`).
    const routeOpenerRe =
      /(\w+)\s*\.\s*(get|post|put|delete|patch|all|head|options|ws)\s*\(\s*(['"])([^'"]+)\3\s*,/g;

    for (const f of jsFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      const rel = ctx.rel(f);
      const lines = buildLineIndex(content);

      for (const m of content.matchAll(routeOpenerRe)) {
        const varName = m[1]!;
        const methodTok = m[2]!.toLowerCase();
        const routePath = m[4]!;
        const matchStart = m.index;
        const line = lines.lineAt(matchStart);

        // The opening paren of the route call: `app.get(` ← that one.
        // Locate it by scanning forward from the variable for the first `(`.
        const openParen = content.indexOf("(", matchStart);
        if (openParen === -1) continue;
        const closeParen = findMatchingParen(content, openParen);
        if (closeParen === -1) continue;

        // Full call body between the parens.
        const callBody = content.slice(openParen + 1, closeParen);
        // Drop the leading path-string + comma to get just the handler args.
        const afterPathComma = callBody.indexOf(",");
        const handlerArgs =
          afterPathComma >= 0 ? callBody.slice(afterPathComma + 1) : callBody;

        const isWs = methodTok === "ws";
        let httpMethod = methodTok.toUpperCase();
        if (httpMethod === "ALL") httpMethod = "ANY";
        if (isWs) httpMethod = "WS";

        const prefix = mountPrefixes[varName] ?? "";
        const fullPath = normalizePath(prefix + routePath);

        // Best-effort handler name: first identifier in args. Misses inline
        // arrow fns (recorded as <anonymous>), which is fine.
        const handlerNameMatch = handlerArgs.match(/^\s*(\w+)\s*[,)]/);
        const handlerName = handlerNameMatch
          ? handlerNameMatch[1]!
          : "<anonymous>";

        // Page detection: inspect the handler body for `res.render(` or
        // `res.sendFile(`. Both indicate an HTML/file response, so the route
        // is a server-side page rather than a JSON API.
        let kind: "api" | "page" | "websocket" = "api";
        if (isWs) {
          kind = "websocket";
        } else if (
          PAGE_RENDER_RE.test(handlerArgs) ||
          PAGE_SENDFILE_RE.test(handlerArgs)
        ) {
          kind = "page";
        }

        endpoints.push(
          endpoint({
            method: httpMethod,
            kind,
            path: fullPath,
            handler: handlerName,
            file: rel,
            line,
            framework: "express",
            params: extractPathParams(fullPath),
            auth: findAuthDecorators(handlerArgs),
          }),
        );
      }
    }

    // Pass 3: socket.io websocket detection.
    //   - `io.of("/ns")` → websocket endpoint at "/ns" (the namespace IS the path)
    //   - `io.on("connection", ...)` (without a preceding `.of(...)`) → "/" namespace
    // Best-effort: we don't try to track which `io` instance is which, just
    // emit one endpoint per `.of("/ns")` plus a single root endpoint if any
    // `connection` handler is registered without a namespace.
    const ioOfRe = /\b(\w+)\s*\.\s*of\s*\(\s*(['"])([^'"]+)\2\s*\)/g;
    const ioOnConnRe =
      /\b(\w+)\s*\.\s*on\s*\(\s*(['"])connection\2\s*,\s*(.*?)\)/gs;
    // ws / WebSocketServer detection: `new WebSocketServer(...)` or
    // `new WebSocket.Server(...)`. Single endpoint, path "/".
    const wsServerRe =
      /new\s+(?:WebSocket\s*\.\s*Server|WebSocketServer)\s*\(/g;

    for (const f of jsFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      const rel = ctx.rel(f);
      const lines = buildLineIndex(content);

      // Identify socket.io server instances so an unrelated `.of(...)` or
      // `.on("connection", ...)` (e.g. an ORM/collection/query builder) isn't
      // mistaken for a socket.io namespace/handler. Require an actual socket.io
      // import — a bare mention of the string is not enough — then collect the
      // variables bound to a server instance:
      //   const io = new Server(...) / new SocketIOServer(...)
      //   const io = require("socket.io")(server)        // v2 inline factory
      //   const io = sio(server)   // sio from `import sio from "socket.io"` etc.
      const importsSocketIo = /(?:from\s+|require\(\s*)['"]socket\.io['"]/.test(
        content,
      );
      const ioInstances = new Set<string>();
      if (importsSocketIo) {
        for (const m of content.matchAll(
          /\b(\w+)\s*=\s*new\s+(?:Server|SocketIOServer|IOServer)\s*\(/g,
        ))
          ioInstances.add(m[1]!);
        for (const m of content.matchAll(
          /\b(\w+)\s*=\s*require\(\s*['"]socket\.io['"]\s*\)\s*\(/g,
        ))
          ioInstances.add(m[1]!);
        // Factory bound to a name and later called: `const sio = require(...)`
        // or `import sio from "socket.io"`, then `const io = sio(server)`.
        const factories = new Set<string>();
        for (const m of content.matchAll(
          /\b(\w+)\s*=\s*require\(\s*['"]socket\.io['"]\s*\)(?!\s*\()/g,
        ))
          factories.add(m[1]!);
        for (const m of content.matchAll(
          /import\s+(\w+)\s+from\s+['"]socket\.io['"]/g,
        ))
          factories.add(m[1]!);
        for (const fac of factories) {
          for (const m of content.matchAll(
            new RegExp(`\\b(\\w+)\\s*=\\s*${fac}\\s*\\(`, "g"),
          ))
            ioInstances.add(m[1]!);
        }
      }

      const namespacePaths = new Set<string>();
      let emittedRootIo = false;
      if (ioInstances.size > 0) {
        // `io.of("/ns")` on a genuine socket.io instance → websocket at "/ns".
        for (const m of content.matchAll(ioOfRe)) {
          if (!ioInstances.has(m[1]!)) continue;
          const ns = m[3]!;
          namespacePaths.add(ns);
          endpoints.push(
            endpoint({
              method: "WS",
              kind: "websocket",
              path: normalizePath(ns),
              handler: "<anonymous>",
              file: rel,
              line: lines.lineAt(m.index),
              framework: "express",
              params: extractPathParams(normalizePath(ns)),
            }),
          );
        }

        // A single `io.on("connection", ...)` on the instance registers the
        // root "/" namespace. Only emit once per file.
        for (const m of content.matchAll(ioOnConnRe)) {
          if (!ioInstances.has(m[1]!)) continue;
          if (!namespacePaths.has("/")) {
            endpoints.push(
              endpoint({
                method: "WS",
                kind: "websocket",
                path: "/",
                handler: "<anonymous>",
                file: rel,
                line: lines.lineAt(m.index),
                framework: "express",
              }),
            );
            emittedRootIo = true;
          }
          break;
        }
      }
      ioOnConnRe.lastIndex = 0;

      // ws library: each WebSocketServer instantiation is a single endpoint.
      // Path discovery is non-trivial (often configured via separate options
      // or attached to an http server), so we conservatively use "/".
      // Skip if file already emitted a socket.io "/" endpoint to avoid dup.
      const hasRootIoEndpoint = namespacePaths.has("/") || emittedRootIo;
      if (!hasRootIoEndpoint) {
        for (const m of content.matchAll(wsServerRe)) {
          endpoints.push(
            endpoint({
              method: "WS",
              kind: "websocket",
              path: "/",
              handler: "<anonymous>",
              file: rel,
              line: lines.lineAt(m.index),
              framework: "express",
            }),
          );
          break; // one endpoint per file is enough
        }
      }
    }

    return endpoints;
  },
};
