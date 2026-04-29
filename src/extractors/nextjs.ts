import { readdirSync, existsSync, lstatSync, realpathSync } from "fs";
import { join, relative, basename } from "path";
import type { EndpointInfo, Extractor } from "../types.ts";
import {
  endpoint,
  extractPathParams,
  lineNumber,
  normalizePath,
} from "../utils.ts";
import { SKIP_DIRS } from "../scan-context.ts";

const PAGE_EXTENSIONS = /\.(tsx|jsx|ts|js)$/;
const APP_ROUTER_PAGE_RE = /^page\.(tsx|jsx|ts|js)$/;
const APP_ROUTER_LAYOUT_FILES = new Set([
  "layout",
  "template",
  "loading",
  "error",
  "not-found",
  "default",
]);
const PAGES_ROUTER_SPECIAL_FILES = new Set([
  "_app",
  "_document",
  "_error",
  "_middleware",
]);

function findNextConfigs(root: string, maxDepth = 3): string[] {
  const results: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: import("fs").Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (
        e.isFile() &&
        ["next.config.js", "next.config.mjs", "next.config.ts"].includes(e.name)
      ) {
        results.push(dir);
      }
      if (
        e.isDirectory() &&
        !SKIP_DIRS.has(e.name) &&
        !e.name.startsWith(".")
      ) {
        const childPath = join(dir, e.name);
        // Skip symlinked directories to prevent path traversal
        try {
          if (lstatSync(childPath).isSymbolicLink()) continue;
          if (!realpathSync(childPath).startsWith(root)) continue;
        } catch {
          continue;
        }
        walk(childPath, depth + 1);
      }
    }
  }
  walk(root, 0);
  return results;
}

function walkFiles(root: string, filter: (name: string) => boolean): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    let entries: import("fs").Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
        const childPath = join(dir, e.name);
        // Skip symlinked directories to prevent path traversal
        try {
          if (lstatSync(childPath).isSymbolicLink()) continue;
          if (!realpathSync(childPath).startsWith(root)) continue;
        } catch {
          continue;
        }
        walk(childPath);
      } else if (e.isFile() && filter(e.name)) {
        results.push(join(dir, e.name));
      }
    }
  }
  walk(root);
  return results;
}

export const nextjs: Extractor = {
  id: "nextjs",
  detect: {
    depKeywords: ['"next"'],
    markers: ["next.config.js", "next.config.mjs", "next.config.ts"],
    scope: "all",
  },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const httpExportRe =
      /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(|export\s+const\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*=/g;

    let appRoots = findNextConfigs(ctx.repoPath);
    if (appRoots.length === 0) appRoots = [ctx.repoPath];

    for (const appRoot of appRoots) {
      // App Router: app/**/route.ts|js
      for (const baseName of ["app", join("src", "app")]) {
        const base = join(appRoot, baseName);
        if (!existsSync(base)) continue;

        for (const rf of walkFiles(
          base,
          (n) => n === "route.ts" || n === "route.js",
        )) {
          ctx.filesScanned++;
          const content = ctx.readFile(rf);
          if (!content) continue;
          const rel = ctx.rel(rf);

          const routeDir = rf.replace(/\/route\.(ts|js)$/, "");
          const urlPath = normalizePath("/" + relative(base, routeDir));

          let foundMethods = false;
          for (const m of content.matchAll(httpExportRe)) {
            const method = (m[1] ?? m[2])!;
            foundMethods = true;

            endpoints.push(
              endpoint({
                method,
                path: urlPath,
                handler: method,
                file: rel,
                line: lineNumber(content, m.index),
                framework: "nextjs",
                params: extractPathParams(urlPath),
              }),
            );
          }

          if (!foundMethods && content.includes("export")) {
            endpoints.push(
              endpoint({
                method: "ANY",
                path: urlPath,
                handler: "default",
                file: rel,
                line: 1,
                framework: "nextjs",
                params: extractPathParams(urlPath),
              }),
            );
          }
        }
      }

      // App Router: app/**/page.{tsx,jsx,ts,js}
      for (const baseName of ["app", join("src", "app")]) {
        const base = join(appRoot, baseName);
        if (!existsSync(base)) continue;

        for (const pf of walkFiles(base, (n) => APP_ROUTER_PAGE_RE.test(n))) {
          ctx.filesScanned++;
          const rel = ctx.rel(pf);
          const pageDir = pf.replace(/\/page\.(tsx|jsx|ts|js)$/, "");
          const urlPath = normalizePath("/" + relative(base, pageDir));

          endpoints.push(
            endpoint({
              method: "GET",
              kind: "page",
              path: urlPath,
              handler: "Page",
              file: rel,
              line: 1,
              framework: "nextjs",
              params: extractPathParams(urlPath),
            }),
          );
        }
      }

      // Pages Router: pages/api/**/*
      for (const baseName of ["pages", join("src", "pages")]) {
        const pagesApi = join(appRoot, baseName, "api");
        if (!existsSync(pagesApi)) continue;

        for (const af of walkFiles(pagesApi, (n) =>
          /\.(ts|js|tsx|jsx)$/.test(n),
        )) {
          ctx.filesScanned++;
          const relToApi = relative(pagesApi, af).replace(/\.\w+$/, "");
          const urlPath = normalizePath("/api/" + relToApi);

          endpoints.push(
            endpoint({
              method: "ANY",
              path: urlPath,
              handler: "default",
              file: ctx.rel(af),
              line: 1,
              framework: "nextjs",
              params: extractPathParams(urlPath),
            }),
          );
        }
      }

      // Pages Router: pages/**/*.{tsx,jsx,ts,js} (excluding api/ and special files)
      for (const baseName of ["pages", join("src", "pages")]) {
        const pagesBase = join(appRoot, baseName);
        if (!existsSync(pagesBase)) continue;

        for (const pf of walkFiles(pagesBase, (n) => PAGE_EXTENSIONS.test(n))) {
          const relToPages = relative(pagesBase, pf);
          // Skip pages/api/** — already handled above
          if (relToPages.startsWith("api/") || relToPages.startsWith("api\\"))
            continue;

          const stem = basename(pf).replace(PAGE_EXTENSIONS, "");
          // Skip special Next.js files
          if (PAGES_ROUTER_SPECIAL_FILES.has(stem)) continue;
          // Skip layout-like files in pages router
          if (APP_ROUTER_LAYOUT_FILES.has(stem)) continue;

          ctx.filesScanned++;
          const rel = ctx.rel(pf);

          // Derive URL path: strip extension, normalize /index → /
          let urlSegment = relToPages.replace(PAGE_EXTENSIONS, "");
          // Normalize path separators (Windows compat)
          urlSegment = urlSegment.replace(/\\/g, "/");
          // /index at any level → parent directory path
          if (urlSegment === "index") {
            urlSegment = "";
          } else if (urlSegment.endsWith("/index")) {
            urlSegment = urlSegment.slice(0, -"/index".length);
          }
          // Convert [param] to :param for bracket params
          const urlPath = normalizePath("/" + urlSegment);

          endpoints.push(
            endpoint({
              method: "GET",
              kind: "page",
              path: urlPath,
              handler: "Page",
              file: rel,
              line: 1,
              framework: "nextjs",
              params: extractPathParams(urlPath),
            }),
          );
        }
      }
    }

    return endpoints;
  },
};
