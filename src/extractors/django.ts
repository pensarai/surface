import type { EndpointInfo, Extractor } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  findAuthDecorators,
  normalizePath,
} from "../utils.ts";

const PY_EXTS = [".py"];

export const django: Extractor = {
  id: "django",
  detect: { depKeywords: ["django"], markers: ["manage.py"], scope: "all" },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const pyFiles = ctx.iterFiles(PY_EXTS);

    const urlFiles = pyFiles.filter((f) => {
      const name = f.split("/").pop()!;
      return name === "urls.py" || name === "routes.py";
    });

    // Build prefix map from include() calls.
    // `[rRbBuUfF]*` allows Python string-literal prefixes (raw `r"..."`,
    // f-strings, bytes, unicode) before the quote — these are common in
    // urls.py and would otherwise be skipped. `(?:path|re_path)` covers both
    // Django route helpers.
    const includePrefixes: Record<string, string> = {};
    const pathIncludeRe =
      /(?:path|re_path)\s*\(\s*[rRbBuUfF]*['"]([^'"]*)['"]\s*,\s*include\s*\(\s*[rRbBuUfF]*['"]([^'"]+)['"]/g;

    for (const f of urlFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      for (const m of content.matchAll(pathIncludeRe)) {
        includePrefixes[m[2]!] = m[1]!;
      }
    }

    const directPathRe =
      /(?:path|re_path)\s*\(\s*[rRbBuUfF]*['"]([^'"]*)['"]\s*,\s*(?!include)(\w[\w.]*)/g;
    const apiViewRe =
      /@api_view\s*\(\s*\[([^\]]*)\]\s*\)(.*?)def\s+(\w+)\s*\(/gs;

    for (const f of urlFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      const rel = ctx.rel(f);

      const fileModule = ctx.rel(f).replace(/\//g, ".").replace(/\.py$/, "");
      let ownPrefix = "";
      for (const [mod, prefix] of Object.entries(includePrefixes)) {
        if (
          fileModule.includes(mod) ||
          fileModule.endsWith(mod.replace(/\./g, "/"))
        ) {
          ownPrefix = prefix;
          break;
        }
      }

      const lines = buildLineIndex(content);
      for (const m of content.matchAll(directPathRe)) {
        const routePath = m[1]!;
        const viewRef = m[2]!;
        const line = lines.lineAt(m.index);
        const fullPath = normalizePath(ownPrefix + routePath);

        endpoints.push(
          endpoint({
            method: "ANY",
            path: fullPath,
            handler: viewRef.split(".").pop()!,
            file: rel,
            line,
            framework: "django",
            params: extractPathParams(fullPath),
          }),
        );
      }
    }

    for (const f of pyFiles) {
      const content = ctx.readFile(f);
      if (!content || !content.includes("@api_view")) continue;
      const rel = ctx.rel(f);

      const lines = buildLineIndex(content);
      for (const m of content.matchAll(apiViewRe)) {
        const methodsStr = m[1]!;
        const between = m[2]!;
        const funcName = m[3]!;
        const line = lines.lineAt(m.index);
        const methods = methodsStr
          .split(",")
          .map((s) => s.trim().replace(/['"]/g, "").toUpperCase());
        const auth = findAuthDecorators(between);

        for (const method of methods) {
          endpoints.push(
            endpoint({
              method,
              path: `/${funcName}`,
              handler: funcName,
              file: rel,
              line,
              framework: "django",
              auth,
            }),
          );
        }
      }
    }

    return endpoints;
  },
};
