import { readdirSync, readFileSync, lstatSync, realpathSync } from "fs";
import { join, relative, extname } from "path";
import type { ScanContext } from "./types.ts";

export const SKIP_DIRS = new Set([
  "venv",
  ".venv",
  "env",
  ".env",
  "__pycache__",
  "site-packages",
  "dist-packages",
  ".tox",
  ".nox",
  ".eggs",
  "node_modules",
  ".next",
  "coverage",
  "vendor",
  "target",
  ".gradle",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".cache",
  "tmp",
  "temp",
  ".idea",
  ".vscode",
  "fixtures",
  "__fixtures__",
  "testdata",
  "test-data",
  "generated",
  "gen",
  "proto-gen",
  "mock",
  "mocks",
  "__mocks__",
]);

const SKIP_PATH_PATTERNS = [
  /libs?\/api-client/i,
  /libs?\/sdk-/i,
  /libs?\/client-/i,
  /packages?\/client/i,
  /packages?\/sdk/i,
];

function shouldSkipPath(pathParts: string[]): boolean {
  for (const part of pathParts) {
    if (SKIP_DIRS.has(part) || part.startsWith(".")) return true;
  }
  const full = pathParts.join("/");
  return SKIP_PATH_PATTERNS.some((p) => p.test(full));
}

export function createScanContext(repoPath: string): ScanContext {
  const contentCache = new Map<string, string>();
  let fileIndex: Map<string, string[]> | null = null;
  let filesScanned = 0;

  function buildFileIndex(): Map<string, string[]> {
    if (fileIndex) return fileIndex;
    fileIndex = new Map();

    function walk(dir: string, parts: string[]) {
      let entries: import("fs").Dirent<string>[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
            const childPath = join(dir, entry.name);
            // Skip symlinked directories to prevent path traversal
            try {
              if (lstatSync(childPath).isSymbolicLink()) continue;
              const resolved = realpathSync(childPath);
              if (!resolved.startsWith(repoPath)) continue;
            } catch {
              continue;
            }
            walk(childPath, [...parts, entry.name]);
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (ext) {
            const fullPath = join(dir, entry.name);
            const pathParts = [...parts, entry.name];
            if (!shouldSkipPath(pathParts)) {
              const list = fileIndex!.get(ext) ?? [];
              list.push(fullPath);
              fileIndex!.set(ext, list);
            }
          }
        }
      }
    }

    walk(repoPath, []);
    // Sort for deterministic output
    for (const [ext, files] of fileIndex) {
      fileIndex.set(ext, files.sort());
    }
    return fileIndex;
  }

  function readFile(path: string): string | null {
    const cached = contentCache.get(path);
    if (cached !== undefined) return cached;
    try {
      const content = readFileSync(path, "utf-8");
      contentCache.set(path, content);
      return content;
    } catch {
      return null;
    }
  }

  function iterFiles(extensions: string[]): string[] {
    const idx = buildFileIndex();
    const files: string[] = [];
    for (const ext of extensions) {
      const list = idx.get(ext.toLowerCase());
      if (list) files.push(...list);
    }
    filesScanned += files.length;
    return files; // already sorted per-extension at index build time
  }

  function rel(absolutePath: string): string {
    return relative(repoPath, absolutePath);
  }

  return {
    repoPath,
    readFile,
    iterFiles,
    rel,
    get filesScanned() {
      return filesScanned;
    },
    set filesScanned(n: number) {
      filesScanned = n;
    },
  };
}
