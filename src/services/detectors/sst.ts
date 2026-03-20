import { existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import type { ServiceInfo, ScanContext } from "../../types.ts";

/**
 * Detect services from SST infrastructure definitions.
 *
 * Reads infra/*.ts for .route() calls that map HTTP routes to handler
 * functions. Extracts the handler package path (e.g.
 * "packages/functions/src/webhooks/stripe.handler" → "packages/functions")
 * and creates/upgrades an api_gateway service for it.
 *
 * Also maps the infra/ directory itself to the API service so SST-extracted
 * endpoints get assigned correctly.
 */
export function detectSstServices(
  repoPath: string,
  ctx: ScanContext,
  existing: ServiceInfo[],
): ServiceInfo[] {
  if (!existsSync(join(repoPath, "sst.config.ts"))) return [];

  const infraDir = join(repoPath, "infra");
  if (!existsSync(infraDir)) return [];

  let files: string[];
  try {
    files = readdirSync(infraDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(infraDir, f));
  } catch {
    return [];
  }

  // Collect handler package roots from route definitions
  const handlerRoots = new Set<string>();
  const handlerRe = /handler\s*:\s*['"]([^'"]+)['"]/g;

  for (const f of files) {
    const content = ctx.readFile(f);
    if (!content?.includes(".route(")) continue;

    for (const m of content.matchAll(handlerRe)) {
      const handlerPath = m[1]!;
      // "packages/functions/src/webhooks/stripe.handler"
      // → find the package root by looking for a directory with package.json
      const root = findPackageRoot(repoPath, handlerPath);
      if (root) handlerRoots.add(root);
    }
  }

  const services: ServiceInfo[] = [];

  // Upgrade existing workspace services that serve as handler packages
  for (const root of handlerRoots) {
    services.push({
      name: inferServiceName(root, existing),
      type: "api_gateway",
      root,
    });
  }

  // Map infra/ to the first handler service so SST-extracted endpoints
  // get assigned to it
  if (handlerRoots.size > 0) {
    const primaryRoot = [...handlerRoots][0]!;
    const existingInfra = existing.find((s) => s.root === "infra");
    if (!existingInfra) {
      services.push({
        name: inferServiceName(primaryRoot, existing),
        type: "api_gateway",
        root: "infra",
      });
    }
  }

  return services;
}

/**
 * Walk up from a handler file path to find the package root
 * (directory containing package.json).
 *
 * "packages/functions/src/webhooks/stripe.handler"
 * → checks packages/functions/src/webhooks/
 * → checks packages/functions/src/
 * → checks packages/functions/ ← has package.json → returns "packages/functions"
 */
function findPackageRoot(repoPath: string, handlerPath: string): string | null {
  // Convert handler notation: strip the .handler suffix and extension
  const filePath = handlerPath.replace(/\.\w+$/, "");
  let dir = dirname(filePath);

  while (dir && dir !== "." && dir !== "/") {
    if (existsSync(join(repoPath, dir, "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }

  return null;
}

/**
 * Derive a display name for a service, preferring the name from an
 * existing workspace service if one matches the root.
 */
function inferServiceName(root: string, existing: ServiceInfo[]): string {
  const match = existing.find((s) => s.root === root);
  if (match) return match.name;

  // Use last path segment: "packages/functions" → "functions"
  const parts = root.split("/");
  return parts[parts.length - 1] ?? root;
}
