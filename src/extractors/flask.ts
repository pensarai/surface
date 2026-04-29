import type { EndpointInfo, Extractor } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  findAuthDecorators,
  normalizePath,
} from "../utils.ts";

const PY_EXTS = [".py"];

export const flask: Extractor = {
  id: "flask",
  detect: { depKeywords: ["flask"], markers: [], scope: "root" },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const pyFiles = ctx.iterFiles(PY_EXTS);

    // Pass 1: find Blueprint declarations and registrations
    const bpPrefixes: Record<string, string> = {};
    const bpRegisterPrefixes: Record<string, string> = {};

    const bpDeclRe =
      /(\w+)\s*=\s*Blueprint\s*\(\s*['"](\w+)['"](?:.*?url_prefix\s*=\s*['"]([^'"]*)['"])?/gs;
    const bpRegisterRe =
      /\.register_blueprint\s*\(\s*(\w+)(?:.*?url_prefix\s*=\s*['"]([^'"]*)['"])?/gs;

    for (const f of pyFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      for (const m of content.matchAll(bpDeclRe)) {
        bpPrefixes[m[1]!] = m[3] ?? "";
      }
      for (const m of content.matchAll(bpRegisterRe)) {
        if (m[2] !== undefined) bpRegisterPrefixes[m[1]!] = m[2];
      }
    }

    for (const [v, p] of Object.entries(bpRegisterPrefixes)) {
      bpPrefixes[v] = p;
    }

    // Pass 2: extract routes
    const routeRe =
      /@(\w+)\.(?:route|get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]*)\])?\s*\)(.*?)(?:async\s+)?def\s+(\w+)\s*\(/gs;

    // Detect handler body boundary: next top-level def/class or decorator at column 0.
    // Used to scope render_template detection to the current handler only.
    const bodyEndRe = /^(?:@\w|(?:async\s+)?def\s|class\s)/m;

    for (const f of pyFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      const rel = ctx.rel(f);
      const lines = buildLineIndex(content);

      for (const m of content.matchAll(routeRe)) {
        const varName = m[1]!;
        const routePath = m[2]!;
        const methodsStr = m[3];
        const between = m[4]!;
        const funcName = m[5]!;
        const line = lines.lineAt(m.index);

        const prefix = bpPrefixes[varName] ?? "";
        const fullPath = normalizePath(prefix + routePath);

        let methods: string[];
        if (methodsStr) {
          methods = methodsStr
            .split(",")
            .map((s) => s.trim().replace(/['"]/g, "").toUpperCase());
        } else {
          const decMatch = m[0].match(/\.(get|post|put|delete|patch)\s*\(/);
          methods = decMatch ? [decMatch[1]!.toUpperCase()] : ["GET"];
        }

        const auth = findAuthDecorators(between);
        const params = extractPathParams(fullPath);

        // Slice handler body from end of `def name(` match to next top-level
        // def/class/decorator. Body containing render_template(...) /
        // render_template_string(...) = HTML page; otherwise = JSON api.
        const bodyStart = m.index + m[0].length;
        const rest = content.slice(bodyStart);
        const endMatch = bodyEndRe.exec(rest);
        const body = endMatch ? rest.slice(0, endMatch.index) : rest;
        const kind = /\brender_template(?:_string)?\s*\(/.test(body)
          ? "page"
          : "api";

        for (const method of methods) {
          endpoints.push(
            endpoint({
              method,
              kind,
              path: fullPath,
              handler: funcName,
              file: rel,
              line,
              framework: "flask",
              params: [...params],
              auth,
            }),
          );
        }
      }
    }

    return endpoints;
  },
};
