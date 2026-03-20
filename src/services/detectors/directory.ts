import { existsSync, readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import type { ServiceInfo, ScanContext } from "../../types.ts";
import { SKIP_DIRS } from "../../scan-context.ts";
import { inferServiceType, stripOrgScope } from "../infer-type.ts";

/** Files whose presence marks a directory as a potential service root. */
const SERVICE_MARKERS = [
  "package.json",
  "go.mod",
  "requirements.txt",
  "pyproject.toml",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
];

/**
 * Fallback detector: find directories with dependency manifests
 * that weren't claimed by workspace/compose/SST detectors.
 *
 * Only searches root and one level deep to avoid false positives from
 * nested test/example directories.
 */
export function detectDirectories(
  repoPath: string,
  _ctx: ScanContext,
  existing: ServiceInfo[],
): ServiceInfo[] {
  // If other detectors already found services, don't add more noise
  if (existing.length > 0) return [];

  const services: ServiceInfo[] = [];

  // Check root directory
  const rootHasMarker = SERVICE_MARKERS.some((f) =>
    existsSync(join(repoPath, f)),
  );

  if (rootHasMarker) {
    // Single-app repo: one service at root
    const name = inferRootName(repoPath);
    services.push({
      name,
      type: inferServiceType(repoPath),
      root: ".",
    });
    return services;
  }

  // Check one level deep for service directories
  let children: string[];
  try {
    children = readdirSync(repoPath, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."),
      )
      .map((e) => e.name);
  } catch {
    return [];
  }

  for (const child of children) {
    const hasMarker = SERVICE_MARKERS.some((f) =>
      existsSync(join(repoPath, child, f)),
    );
    if (hasMarker) {
      services.push({
        name: child,
        type: inferServiceType(join(repoPath, child)),
        root: child,
      });
    }
  }

  // If we also find a "src/services" or "services" directory pattern,
  // check one more level
  const claimedRoots = new Set(services.map((s) => s.root));
  const serviceDirs = ["src/services", "services", "apps", "src"];
  for (const svcDir of serviceDirs) {
    const absDir = join(repoPath, svcDir);
    if (!existsSync(absDir)) continue;

    try {
      for (const entry of readdirSync(absDir, { withFileTypes: true })) {
        if (
          !entry.isDirectory() ||
          SKIP_DIRS.has(entry.name) ||
          entry.name.startsWith(".")
        )
          continue;

        const childPath = svcDir + "/" + entry.name;
        if (claimedRoots.has(childPath)) continue;

        const hasMarker = SERVICE_MARKERS.some((f) =>
          existsSync(join(repoPath, childPath, f)),
        );
        if (hasMarker) {
          services.push({
            name: entry.name,
            type: inferServiceType(join(repoPath, childPath)),
            root: childPath,
          });
        }
      }
    } catch {
      /* skip */
    }
  }

  return services;
}

/**
 * Derive a name for a single-app repo from its root package.json or directory name.
 */
function inferRootName(repoPath: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(repoPath, "package.json"), "utf-8"),
    ) as { name?: string };
    if (pkg.name) return stripOrgScope(pkg.name);
  } catch {
    /* no package.json or invalid */
  }

  return basename(repoPath);
}
