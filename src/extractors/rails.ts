import type { EndpointInfo, Extractor } from "../types.ts";
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

    const routeRe =
      /(get|post|put|patch|delete)\s+['"]([^'"]+)['"](?:\s*,\s*to:\s*['"]([^'"]+)['"])?/g;
    const resourcesRe = /resources?\s+:(\w+)/g;
    const namespaceRe = /namespace\s+:(\w+)/g;

    const namespaces: string[] = [];
    for (const line of content.split("\n")) {
      const nsM = namespaceRe.exec(line);
      if (nsM) namespaces.push(nsM[1]!);
      namespaceRe.lastIndex = 0;
    }

    const prefix = namespaces.length ? "/" + namespaces.join("/") : "";
    const lines = buildLineIndex(content);

    for (const m of content.matchAll(routeRe)) {
      const fullPath = normalizePath(prefix + "/" + m[2]!);
      endpoints.push(
        endpoint({
          method: m[1]!.toUpperCase(),
          path: fullPath,
          handler: m[3] || m[2]!.replace(/\//g, "_"),
          file: rel,
          line: lines.lineAt(m.index),
          framework: "rails",
          params: extractPathParams(fullPath),
        }),
      );
    }

    for (const m of content.matchAll(resourcesRe)) {
      const resource = m[1]!;
      const line = lines.lineAt(m.index);
      const base = normalizePath(prefix + "/" + resource);

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
            params: extractPathParams(fullPath),
          }),
        );
      }
    }

    return endpoints;
  },
};
