import { existsSync, readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import type { ServiceInfo, ScanContext } from "../../types.ts";
import { inferServiceType, stripOrgScope } from "../infer-type.ts";

/**
 * Expand workspace globs from package.json's "workspaces" field.
 *
 * Handles both formats:
 *   "workspaces": ["packages/*", "console"]
 *   "workspaces": { "packages": ["packages/*", "console"] }
 *
 * Simple globs ("packages/*") are expanded by listing subdirectories.
 * Exact paths ("console") are used as-is if the directory exists.
 */
function expandWorkspaceGlobs(repoPath: string, patterns: string[]): string[] {
  const dirs: string[] = [];

  for (const pattern of patterns) {
    const clean = pattern.replace(/\/+$/, "");

    if (clean.endsWith("/*") || clean.endsWith("/**")) {
      // Glob pattern — expand by listing the parent directory
      const parentDir = clean.replace(/\/\*\*?$/, "");
      const absParent = join(repoPath, parentDir);
      try {
        for (const entry of readdirSync(absParent, { withFileTypes: true })) {
          if (
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            entry.name !== "node_modules"
          ) {
            dirs.push(parentDir + "/" + entry.name);
          }
        }
      } catch {
        /* parent dir doesn't exist — skip */
      }
    } else {
      // Exact path
      if (existsSync(join(repoPath, clean))) {
        dirs.push(clean);
      }
    }
  }

  return dirs;
}

/**
 * Detect services from npm/yarn/pnpm workspaces.
 *
 * Reads root package.json "workspaces" field, expands globs, then reads
 * each workspace's package.json to get its name and infer its type.
 */
export function detectWorkspaces(
  repoPath: string,
  _ctx: ScanContext,
  _existing: ServiceInfo[],
): ServiceInfo[] {
  const rootPkgPath = join(repoPath, "package.json");
  let rootPkg: string;
  try {
    rootPkg = readFileSync(rootPkgPath, "utf-8");
  } catch {
    return [];
  }

  let parsed: { workspaces?: string[] | { packages?: string[] } };
  try {
    parsed = JSON.parse(rootPkg);
  } catch {
    return [];
  }

  // Extract workspace patterns
  let patterns: string[];
  if (Array.isArray(parsed.workspaces)) {
    patterns = parsed.workspaces;
  } else if (
    parsed.workspaces &&
    Array.isArray((parsed.workspaces as { packages?: string[] }).packages)
  ) {
    patterns = (parsed.workspaces as { packages: string[] }).packages;
  } else {
    // Also check for pnpm-workspace.yaml
    return detectPnpmWorkspaces(repoPath);
  }

  const dirs = expandWorkspaceGlobs(repoPath, patterns);
  return dirsToServices(repoPath, dirs);
}

/**
 * Detect pnpm workspaces from pnpm-workspace.yaml.
 */
function detectPnpmWorkspaces(repoPath: string): ServiceInfo[] {
  const wsPath = join(repoPath, "pnpm-workspace.yaml");
  let content: string;
  try {
    content = readFileSync(wsPath, "utf-8");
  } catch {
    return [];
  }

  // Simple YAML parsing for the packages field — avoids a dependency
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "packages:" || trimmed.startsWith("packages:")) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (trimmed.startsWith("- ")) {
        patterns.push(trimmed.slice(2).replace(/^['"]|['"]$/g, ""));
      } else if (trimmed && !trimmed.startsWith("#")) {
        break; // New top-level key
      }
    }
  }

  const dirs = expandWorkspaceGlobs(repoPath, patterns);
  return dirsToServices(repoPath, dirs);
}

/**
 * Convert a list of workspace directories to ServiceInfo entries.
 */
function dirsToServices(repoPath: string, dirs: string[]): ServiceInfo[] {
  const services: ServiceInfo[] = [];

  for (const dir of dirs) {
    const pkgPath = join(repoPath, dir, "package.json");
    let pkgContent: string;
    try {
      pkgContent = readFileSync(pkgPath, "utf-8");
    } catch {
      continue; // Workspace dir without package.json — skip
    }

    let name: string;
    try {
      const pkg = JSON.parse(pkgContent) as { name?: string };
      name = stripOrgScope(pkg.name ?? basename(dir));
    } catch {
      name = basename(dir);
    }

    services.push({
      name,
      type: inferServiceType(join(repoPath, dir)),
      root: dir,
    });
  }

  return services;
}
