import type { EndpointInfo, EndpointKind, Extractor } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  findAuthDecorators,
  normalizePath,
} from "../utils.ts";

const PY_EXTS = [".py"];

// Django generic class-based views that render templates → page.
// Match by base class name (last segment) so `TemplateView`,
// `django.views.generic.TemplateView`, or `generic.TemplateView` all work.
const PAGE_CBV_BASES = new Set([
  "TemplateView",
  "ListView",
  "DetailView",
  "CreateView",
  "UpdateView",
  "DeleteView",
  "FormView",
]);

interface ClassDef {
  bases: string[]; // last-segment names
}

interface FuncDef {
  body: string; // raw text of the function body (heuristic: until next top-level def/class)
}

export const django: Extractor = {
  id: "django",
  detect: { depKeywords: ["django"], markers: ["manage.py"], scope: "all" },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const pyFiles = ctx.iterFiles(PY_EXTS);

    // -------------------------------------------------------------------
    // Pass 0: build a registry of class/function definitions across the
    // project so url entries can be classified as page vs api.
    // Registry is keyed by the symbol's last segment (e.g. `MyView`),
    // which matches the way views are typically referenced in urls.py
    // (`views.MyView.as_view()` → captured ref `views.MyView`).
    // -------------------------------------------------------------------
    const classes: Record<string, ClassDef> = {};
    const funcs: Record<string, FuncDef> = {};

    const classRe = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/gm;
    // Capture function bodies via "until next top-level def/class or EOF".
    // JS regex has no \Z; use a lookahead that allows end-of-string by
    // matching the next top-level def/class OR end-of-string.
    const funcRe =
      /^def\s+(\w+)\s*\([^)]*\)\s*:\s*\n([\s\S]*?)(?=^(?:def |class )|$(?![\s\S]))/gm;

    for (const f of pyFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;

      for (const m of content.matchAll(classRe)) {
        const name = m[1]!;
        const bases = m[2]!
          .split(",")
          .map((b) => b.trim())
          .filter(Boolean)
          .map((b) => b.split(".").pop()!.replace(/\s+/g, ""));
        classes[name] = { bases };
      }

      for (const m of content.matchAll(funcRe)) {
        const name = m[1]!;
        const body = m[2] ?? "";
        funcs[name] = { body };
      }
    }

    // Resolve the meaningful handler name from a view ref.
    // CBVs are typically `views.HomeView.as_view()` → captured as
    // `views.HomeView.as_view`. Strip the `.as_view`/`.as_asgi` suffix
    // so the handler is `HomeView`, not `as_view`.
    const resolveHandlerName = (viewRef: string): string => {
      const parts = viewRef.split(".");
      const last = parts[parts.length - 1]!;
      if ((last === "as_view" || last === "as_asgi") && parts.length >= 2) {
        return parts[parts.length - 2]!;
      }
      return last;
    };

    // Helper: classify a path() entry's view reference.
    // - CBV with TemplateView/ListView/etc. base = page
    // - FBV body containing render(...) = page
    // - everything else = api
    const classifyView = (viewRef: string): EndpointKind => {
      const handler = resolveHandlerName(viewRef);
      const cls = classes[handler];
      if (cls) {
        if (cls.bases.some((b) => PAGE_CBV_BASES.has(b))) return "page";
        return "api";
      }
      const fn = funcs[handler];
      if (fn && /\brender\s*\(/.test(fn.body)) return "page";
      return "api";
    };

    // -------------------------------------------------------------------
    // urls.py / routes.py — HTTP routes
    // -------------------------------------------------------------------
    const urlFiles = pyFiles.filter((f) => {
      const name = f.split("/").pop()!;
      return name === "urls.py" || name === "routes.py";
    });

    // Build prefix map from include() calls
    const includePrefixes: Record<string, string> = {};
    const pathIncludeRe =
      /path\s*\(\s*['"]([^'"]*)['"]\s*,\s*include\s*\(\s*['"]([^'"]+)['"]/g;

    for (const f of urlFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      for (const m of content.matchAll(pathIncludeRe)) {
        includePrefixes[m[2]!] = m[1]!;
      }
    }

    const directPathRe =
      /path\s*\(\s*['"]([^'"]*)['"]\s*,\s*(?!include)(\w[\w.]*)/g;
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
        const kind = classifyView(viewRef);

        endpoints.push(
          endpoint({
            method: "ANY",
            kind,
            path: fullPath,
            handler: resolveHandlerName(viewRef),
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

    // -------------------------------------------------------------------
    // Django Channels — websocket_urlpatterns from routing.py (any file).
    // Each `path("ws/x/", Consumer.as_asgi())` or `re_path(...)` entry
    // emits a websocket endpoint.
    // -------------------------------------------------------------------
    const wsBlockRe = /websocket_urlpatterns\s*=\s*\[([\s\S]*?)\]/g;
    const wsEntryRe =
      /(?:re_path|path|url)\s*\(\s*r?['"]([^'"]*)['"]\s*,\s*(\w[\w.]*)/g;

    for (const f of pyFiles) {
      const content = ctx.readFile(f);
      if (!content || !content.includes("websocket_urlpatterns")) continue;
      const rel = ctx.rel(f);
      const lines = buildLineIndex(content);

      for (const block of content.matchAll(wsBlockRe)) {
        const blockBody = block[1]!;
        const blockOffset = block.index + block[0]!.indexOf(blockBody);
        for (const m of blockBody.matchAll(wsEntryRe)) {
          const routePath = m[1]!;
          const consumerRef = m[2]!;
          const absOffset = blockOffset + m.index;
          const line = lines.lineAt(absOffset);
          const fullPath = normalizePath(routePath);

          endpoints.push(
            endpoint({
              method: "WS",
              kind: "websocket",
              path: fullPath,
              handler: resolveHandlerName(consumerRef),
              file: rel,
              line,
              framework: "django",
              params: extractPathParams(fullPath),
            }),
          );
        }
      }
    }

    return endpoints;
  },
};
