import { existsSync } from "fs";
import { join, dirname } from "path";

/**
 * Walk up from a handler file path to find the package root
 * (directory containing package.json).
 *
 * "packages/functions/src/webhooks/stripe.handler"
 * → checks packages/functions/src/webhooks/
 * → checks packages/functions/src/
 * → checks packages/functions/ ← has package.json → returns "packages/functions"
 */
export function findPackageRoot(
  repoPath: string,
  handlerPath: string,
): string | null {
  // Strip the trailing .<export> token (e.g. ".handler")
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
 * Resolve an SST handler path (e.g. "packages/functions/src/health.handler")
 * to the repo-relative source file ("packages/functions/src/health.ts").
 * Returns null if no matching file exists.
 */
export function resolveHandlerFile(
  repoPath: string,
  handlerPath: string,
): string | null {
  const stripped = handlerPath.replace(/\.\w+$/, "");
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    if (existsSync(join(repoPath, stripped + ext))) {
      return stripped + ext;
    }
  }
  return null;
}
