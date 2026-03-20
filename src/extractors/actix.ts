import type { EndpointInfo, Extractor } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  normalizePath,
} from "../utils.ts";

const RS_EXTS = [".rs"];

/**
 * Actix-web route attribute macros.
 *
 * Matches:
 *   #[get("/path")]
 *   #[post("/path")]
 *   #[actix_web::get("/path")]
 *
 * Captures: (1) method, (2) path.
 * Then looks for the following fn name.
 */
const ATTR_ROUTE_RE =
  /#\[(?:actix_web::)?(get|post|put|delete|patch|head|options)\s*\(\s*"([^"]+)"\s*\)\s*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gs;

/**
 * Actix-web .route() builder pattern.
 *
 * Matches:
 *   web::resource("/path").route(web::get().to(handler))
 *   .route("/path", web::get().to(handler))
 *   .route("/path", web::post().to(handler_fn))
 */
const BUILDER_ROUTE_RE =
  /\.route\s*\(\s*"([^"]+)"\s*,\s*web::(get|post|put|delete|patch|head|options)\s*\(\s*\)\s*\.to\s*\(\s*(\w+)/g;

/**
 * Actix-web web::resource() with .route() chains.
 *
 * Matches:
 *   web::resource("/path").route(web::get().to(handler))
 *
 * Captures: (1) path, (2) method, (3) handler.
 */
const RESOURCE_RE =
  /web::resource\s*\(\s*"([^"]+)"\s*\)\s*\.route\s*\(\s*web::(get|post|put|delete|patch|head|options)\s*\(\s*\)\s*\.to\s*\(\s*(\w+)/g;

export const actix: Extractor = {
  id: "actix",
  detect: {
    depKeywords: ["actix-web"],
    markers: [],
    scope: "root",
  },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const rsFiles = ctx.iterFiles(RS_EXTS);

    for (const f of rsFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      const rel = ctx.rel(f);
      const lines = buildLineIndex(content);

      // Attribute macro routes: #[get("/path")] async fn handler()
      for (const m of content.matchAll(ATTR_ROUTE_RE)) {
        const method = m[1]!.toUpperCase();
        const path = normalizePath(m[2]!);
        const handler = m[3]!;

        endpoints.push(
          endpoint({
            method,
            path,
            handler,
            file: rel,
            line: lines.lineAt(m.index),
            framework: "actix",
            params: extractPathParams(path),
          }),
        );
      }

      // Builder pattern: .route("/path", web::get().to(handler))
      for (const m of content.matchAll(BUILDER_ROUTE_RE)) {
        const path = normalizePath(m[1]!);
        const method = m[2]!.toUpperCase();
        const handler = m[3]!;

        endpoints.push(
          endpoint({
            method,
            path,
            handler,
            file: rel,
            line: lines.lineAt(m.index),
            framework: "actix",
            params: extractPathParams(path),
          }),
        );
      }

      // Resource pattern: web::resource("/path").route(web::get().to(handler))
      for (const m of content.matchAll(RESOURCE_RE)) {
        const path = normalizePath(m[1]!);
        const method = m[2]!.toUpperCase();
        const handler = m[3]!;

        endpoints.push(
          endpoint({
            method,
            path,
            handler,
            file: rel,
            line: lines.lineAt(m.index),
            framework: "actix",
            params: extractPathParams(path),
          }),
        );
      }
    }

    return endpoints;
  },
};
