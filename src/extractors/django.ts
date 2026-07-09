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
    // project so url entries can be classified as page vs api. Definitions
    // are recorded both per-directory (Django apps keep their views next to
    // their urls.py) and globally. Resolution prefers the declaring app's own
    // directory, then falls back to the global registry — so two apps that
    // each define a `HomeView` / `health` don't clobber each other's kind.
    // Keys are the symbol's last segment (e.g. `MyView`), matching how views
    // are referenced in urls.py (`views.MyView.as_view()` → ref `views.MyView`).
    // -------------------------------------------------------------------
    const dirOf = (f: string) => f.slice(0, f.lastIndexOf("/"));

    const classesByDir = new Map<string, Record<string, ClassDef>>();
    const funcsByDir = new Map<string, Record<string, FuncDef>>();
    const globalClasses: Record<string, ClassDef> = {};
    const globalFuncs: Record<string, FuncDef> = {};

    const classRe = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/gm;
    // Capture the function body until the next top-level def/class or EOF.
    // - `(?:async\s+)?def` also indexes `async def` views (async template views
    //   would otherwise be missed, and a following async fn could be absorbed
    //   into the previous sync view's body).
    // - `(?:->[^:\n]+)?:[ \t]*\n?` accepts an optional `-> ReturnType` annotation
    //   and both multi-line and single-line bodies
    //   (`def view(request): return render(...)`).
    const funcRe =
      /^(?:async\s+)?def\s+(\w+)\s*\([^)]*\)\s*(?:->[^:\n]+)?:[ \t]*\n?([\s\S]*?)(?=^(?:(?:async\s+)?def |class )|$(?![\s\S]))/gm;

    for (const f of pyFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      const dir = dirOf(f);
      const dirClasses = classesByDir.get(dir) ?? {};
      const dirFuncs = funcsByDir.get(dir) ?? {};

      for (const m of content.matchAll(classRe)) {
        const name = m[1]!;
        const bases = m[2]!
          .split(",")
          .map((b) => b.trim())
          .filter(Boolean)
          .map((b) => b.split(".").pop()!.replace(/\s+/g, ""));
        dirClasses[name] = { bases };
        globalClasses[name] = { bases };
      }

      for (const m of content.matchAll(funcRe)) {
        const name = m[1]!;
        const body = m[2] ?? "";
        dirFuncs[name] = { body };
        globalFuncs[name] = { body };
      }

      classesByDir.set(dir, dirClasses);
      funcsByDir.set(dir, dirFuncs);
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

    // Resolve a symbol for a urls.py in directory `dir`, preferring the app it
    // belongs to before the (collision-prone) global registry:
    //   1. the urls.py's own directory (`views.py` next to `urls.py`), then
    //   2. any nested view package under the app root — the directory holding
    //      the urls.py — e.g. `myapp/views/pages.py`, preferring the closest
    //      such directory, then
    //   3. the global registry.
    const lookupInApp = <T>(
      byDir: Map<string, Record<string, T>>,
      global: Record<string, T>,
      name: string,
      dir: string,
    ): T | undefined => {
      const exact = byDir.get(dir)?.[name];
      if (exact) return exact;
      let best: { def: T; depth: number } | undefined;
      const prefix = dir + "/";
      for (const [d, rec] of byDir) {
        if (!d.startsWith(prefix)) continue;
        const def = rec[name];
        if (def && (!best || d.length < best.depth)) {
          best = { def, depth: d.length };
        }
      }
      return best?.def ?? global[name];
    };
    const lookupClass = (name: string, dir: string): ClassDef | undefined =>
      lookupInApp(classesByDir, globalClasses, name, dir);
    const lookupFunc = (name: string, dir: string): FuncDef | undefined =>
      lookupInApp(funcsByDir, globalFuncs, name, dir);

    // A class renders pages if it (transitively) extends one of the Django
    // template CBV bases. Walk the base chain through the registry so an
    // intermediate project base is still detected — e.g. `HomeView(SiteView)`
    // where `SiteView(TemplateView)`. `seen` guards against inheritance cycles.
    const isPageClass = (
      name: string,
      dir: string,
      seen = new Set<string>(),
    ): boolean => {
      if (seen.has(name)) return false;
      seen.add(name);
      const cls = lookupClass(name, dir);
      if (!cls) return false;
      for (const b of cls.bases) {
        if (PAGE_CBV_BASES.has(b)) return true;
        if (isPageClass(b, dir, seen)) return true;
      }
      return false;
    };

    // Helper: classify a path() entry's view reference. `dir` is the directory
    // of the declaring urls.py, used to prefer same-app definitions.
    // - CBV that (transitively) extends TemplateView/ListView/etc. = page
    // - FBV body containing render(...) = page
    // - everything else = api
    const classifyView = (viewRef: string, dir: string): EndpointKind => {
      const handler = resolveHandlerName(viewRef);
      if (lookupClass(handler, dir)) {
        return isPageClass(handler, dir) ? "page" : "api";
      }
      const fn = lookupFunc(handler, dir);
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

      const urlDir = dirOf(f);
      const lines = buildLineIndex(content);
      for (const m of content.matchAll(directPathRe)) {
        const routePath = m[1]!;
        const viewRef = m[2]!;
        const line = lines.lineAt(m.index);
        const fullPath = normalizePath(ownPrefix + routePath);
        const kind = classifyView(viewRef, urlDir);

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
