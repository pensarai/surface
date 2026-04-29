import type { EndpointInfo, EndpointKind, Extractor } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  normalizePath,
} from "../utils.ts";
import { join } from "path";

const REST_ACTIONS: [string, string, string][] = [
  ["GET", "index", ""],
  ["GET", "show", "/:id"],
  ["POST", "create", ""],
  ["PUT", "update", "/:id"],
  ["PATCH", "update", "/:id"],
  ["DELETE", "destroy", "/:id"],
];

// Controller inheritance signal:
//   ActionController::Base = page-rendering app (Blade/ERB views, sessions, CSRF)
//   ActionController::API  = headless JSON API (no view layer, no CSRF)
// We resolve the controller for each route and walk its ancestor chain in
// app/controllers/ until we hit one of these two roots; that determines `kind`.
type RailsKind = Extract<EndpointKind, "page" | "api">;

interface ControllerResolver {
  resolve(controllerRef: string): RailsKind;
}

function createControllerResolver(ctx: {
  repoPath: string;
  readFile(path: string): string | null;
}): ControllerResolver {
  // Cache by controller class name (e.g. "Api::UsersController") to avoid
  // re-reading and re-parsing the same file when multiple routes share a
  // controller.
  const kindCache = new Map<string, RailsKind>();

  // Convert a controller reference from routes.rb into a controller file path.
  //   "users#index"               -> app/controllers/users_controller.rb
  //   "admin/users#index"         -> app/controllers/admin/users_controller.rb
  //   "Api::V1::UsersController"  -> app/controllers/api/v1/users_controller.rb
  function controllerPath(className: string): string {
    // Strip trailing "Controller" if present, snake_case each segment.
    const parts = className
      .replace(/Controller$/i, "")
      .split("::")
      .map((p) =>
        p
          .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
          .toLowerCase(),
      )
      .filter(Boolean);
    return join(
      ctx.repoPath,
      "app",
      "controllers",
      ...parts.slice(0, -1),
      `${parts[parts.length - 1]}_controller.rb`,
    );
  }

  // Normalize a route handler reference ("users#index", "admin/users#index",
  // "Api::UsersController#index") into a canonical class name like
  // "Api::UsersController" so we share a single cache key per controller.
  function classNameFromRef(ref: string): string {
    const head = ref.split("#")[0]!;
    if (head.includes("::")) {
      // Already a class-style ref; ensure the Controller suffix.
      return head.endsWith("Controller") ? head : `${head}Controller`;
    }
    // path-style ("admin/users") -> "Admin::UsersController"
    const segs = head.split("/").filter(Boolean);
    const camel = segs.map((s) =>
      s
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(""),
    );
    return camel.join("::") + "Controller";
  }

  // Walk the inheritance chain. Each step reads a controller file, finds its
  // `class X < Y` declaration, and recurses on Y. Stops when:
  //   - parent is ActionController::Base / ::API   (definitive answer)
  //   - parent file isn't found in app/controllers (treat as api default — no
  //     regression vs. previous behavior where everything was "api")
  //   - we've already seen this class on this resolution path (cycle guard)
  function classifyClass(className: string, seen: Set<string>): RailsKind {
    const cached = kindCache.get(className);
    if (cached) return cached;

    if (seen.has(className)) return "api";
    seen.add(className);

    const path = controllerPath(className);
    const src = ctx.readFile(path);
    if (!src) return "api";

    // class Foo::BarController < SomeBase
    const m =
      /class\s+([A-Za-z0-9_:]+)\s*<\s*([A-Za-z0-9_:]+(?:::[A-Za-z0-9_]+)*)/.exec(
        src,
      );
    if (!m) return "api";
    const parent = m[2]!;

    let kind: RailsKind;
    if (parent === "ActionController::Base") kind = "page";
    else if (parent === "ActionController::API") kind = "api";
    else kind = classifyClass(parent, seen);

    kindCache.set(className, kind);
    return kind;
  }

  return {
    resolve(controllerRef: string): RailsKind {
      const className = classNameFromRef(controllerRef);
      return classifyClass(className, new Set());
    },
  };
}

export const rails: Extractor = {
  id: "rails",
  detect: {
    depKeywords: ["rails"],
    markers: ["config/routes.rb"],
    scope: "all",
  },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const routesFile = join(ctx.repoPath, "config", "routes.rb");
    const content = ctx.readFile(routesFile);
    if (!content) return endpoints;
    ctx.filesScanned++;
    const rel = ctx.rel(routesFile);

    const resolver = createControllerResolver(ctx);

    // Match `get '/about' => 'pages#about'` AND `get '/about', to: 'pages#about'`.
    const routeRe =
      /(get|post|put|patch|delete)\s+['"]([^'"]+)['"](?:\s*(?:,\s*to:|=>)\s*['"]([^'"]+)['"])?/g;
    const resourcesRe = /resources?\s+:(\w+)/g;
    const namespaceLineRe = /\bnamespace\s+:(\w+)\b/;

    // Track namespace nesting by depth of `do ... end` blocks. The previous
    // implementation flattened all namespaces in the file into a single prefix
    // applied to every route, which is incorrect when only some routes live
    // inside a `namespace :foo do ... end` block.
    const lines = buildLineIndex(content);
    const sourceLines = content.split("\n");
    const nsStack: { name: string; depth: number }[] = [];
    let depth = 0;

    // Pre-compute the namespace prefix in effect at each line of routes.rb.
    const prefixAtLine: string[] = new Array(sourceLines.length + 1).fill("");

    for (let i = 0; i < sourceLines.length; i++) {
      const line = sourceLines[i]!;

      // Strip Ruby comments so `# do` / `# end` don't shift depth.
      const code = line.replace(/#.*$/, "");

      const nsM = namespaceLineRe.exec(code);
      if (nsM) {
        // Namespace block opens at the current depth; will be popped when the
        // matching `end` brings us back below this depth.
        nsStack.push({ name: nsM[1]!, depth });
      }

      // Update depth from this line's block keywords. Heuristic: any `do` or
      // trailing `do |x|` opens a block; a standalone `end` closes one.
      const doMatches = code.match(/\bdo\b(?:\s*\|[^|]*\|)?\s*$/);
      if (doMatches) depth++;
      const endMatches = /^\s*end\b/.test(code);
      if (endMatches) {
        depth = Math.max(0, depth - 1);
        while (
          nsStack.length > 0 &&
          nsStack[nsStack.length - 1]!.depth >= depth
        ) {
          nsStack.pop();
        }
      }

      const prefix = nsStack.length
        ? "/" + nsStack.map((n) => n.name).join("/")
        : "";
      // Record prefix on the NEXT line (1-indexed), since routes declared on
      // the line that opens a namespace are themselves outside that namespace.
      prefixAtLine[i + 1] = prefix;
    }

    // Helper: get the prefix in effect for an offset in the file.
    const prefixAt = (offset: number): string => {
      const ln = lines.lineAt(offset);
      return prefixAtLine[ln] ?? "";
    };

    for (const m of content.matchAll(routeRe)) {
      const prefix = prefixAt(m.index);
      const fullPath = normalizePath(prefix + "/" + m[2]!);
      const handler = m[3] || m[2]!.replace(/\//g, "_");
      const kind: RailsKind = m[3] ? resolver.resolve(m[3]) : "api";
      endpoints.push(
        endpoint({
          method: m[1]!.toUpperCase(),
          path: fullPath,
          handler,
          file: rel,
          line: lines.lineAt(m.index),
          framework: "rails",
          kind,
          params: extractPathParams(fullPath),
        }),
      );
    }

    for (const m of content.matchAll(resourcesRe)) {
      const resource = m[1]!;
      const line = lines.lineAt(m.index);
      const prefix = prefixAt(m.index);
      const base = normalizePath(prefix + "/" + resource);
      // Resource controller name: namespace segments + resource name pluralized
      // as-is. Pass the joined "<ns>/<resource>" path-form to the resolver so
      // it picks the right file (e.g. api/users -> Api::UsersController).
      const controllerRef = (prefix.replace(/^\//, "") + "/" + resource)
        .replace(/^\/+/, "")
        .replace(/\/+/g, "/");
      const kind = resolver.resolve(`${controllerRef}#index`);

      for (const [method, action, suffix] of REST_ACTIONS) {
        const fullPath = normalizePath(base + suffix);
        endpoints.push(
          endpoint({
            method,
            path: fullPath,
            handler: `${resource}#${action}`,
            file: rel,
            line,
            framework: "rails",
            kind,
            params: extractPathParams(fullPath),
          }),
        );
      }
    }

    return endpoints;
  },
};
