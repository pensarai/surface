import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { ServiceInfo, ScanContext } from "../../types.ts";
import { findPackageRoot } from "./sst-shared.ts";

/**
 * Detect services from SST infrastructure definitions.
 *
 * Reads infra/*.ts for .route() calls that map HTTP routes to handler
 * functions. Extracts the handler package path (e.g.
 * "packages/functions/src/webhooks/stripe.handler" → "packages/functions")
 * and creates/upgrades an api_gateway service for it.
 *
 * Endpoints extracted by the SST extractor get assigned to that service via
 * the `serviceRoot` field on each endpoint (see src/extractors/sst.ts) — no
 * synthetic `infra/` service is needed here.
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
      const root = findPackageRoot(repoPath, handlerPath);
      if (root) handlerRoots.add(root);
    }
  }

  // Upgrade existing workspace services that serve as handler packages
  return [...handlerRoots].map((root) => ({
    name: inferServiceName(root, existing),
    type: "api_gateway",
    root,
  }));
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
