import type { ServiceInfo } from "../types.ts";

/**
 * Creates a file-to-service resolver using longest-prefix matching.
 *
 * Services are sorted by root path length descending so that more specific
 * paths (e.g. "packages/functions/src") match before broader ones
 * (e.g. "packages"). Results are cached per directory segment for O(1)
 * amortized lookups after warm-up.
 */
export function createResolver(
  services: ServiceInfo[],
): (relPath: string) => string | undefined {
  if (services.length === 0) return () => undefined;

  // Sort by root length descending — longest (most specific) prefix wins
  const sorted = [...services].sort((a, b) => b.root.length - a.root.length);

  // Normalize roots: strip trailing slashes, ensure no leading "./"
  const entries = sorted.map((s) => ({
    name: s.name,
    root: s.root.replace(/^\.\//, "").replace(/\/+$/, ""),
  }));

  // Cache: directory path → service name, or null for confirmed no-match
  const dirCache = new Map<string, string | null>();

  return function resolve(relPath: string): string | undefined {
    // Extract the directory portion of the path
    const lastSlash = relPath.lastIndexOf("/");
    const dir = lastSlash === -1 ? "" : relPath.slice(0, lastSlash);

    if (dirCache.has(dir)) {
      return dirCache.get(dir) ?? undefined;
    }

    // Try each service root (longest first)
    for (const entry of entries) {
      if (
        relPath.startsWith(entry.root + "/") ||
        relPath === entry.root ||
        entry.root === "" ||
        entry.root === "."
      ) {
        dirCache.set(dir, entry.name);
        return entry.name;
      }
    }

    dirCache.set(dir, null);
    return undefined;
  };
}
