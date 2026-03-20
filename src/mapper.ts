import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import type {
  EndpointInfo,
  FrameworkDetect,
  FrameworkId,
  MapResult,
  ScanContext,
} from "./types.ts";
import { EndpointIndex } from "./endpoint-index.ts";
import { createScanContext, SKIP_DIRS } from "./scan-context.ts";
import { getAllExtractors, getExtractor } from "./extractors/index.ts";
import { isInternalPath } from "./utils.ts";

export interface MapOptions {
  frameworkOverride?: FrameworkId;
  includeInternal?: boolean;
}

// ---------------------------------------------------------------------------
// Framework detection — driven by extractor `detect` declarations
// ---------------------------------------------------------------------------

// Lock files can be 10MB+ — skip them for dep keyword scanning
const DEP_FILENAMES = [
  "requirements.txt",
  "requirements-dev.txt",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "package.json",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
];

function readDepFiles(repoPath: string): { root: string; all: string } {
  const rootParts: string[] = [];
  for (const fname of DEP_FILENAMES) {
    try {
      rootParts.push(readFileSync(join(repoPath, fname), "utf-8"));
    } catch {
      /* not found */
    }
  }

  const workspaceParts: string[] = [];
  try {
    for (const child of readdirSync(repoPath, { withFileTypes: true })) {
      if (
        !child.isDirectory() ||
        SKIP_DIRS.has(child.name) ||
        child.name.startsWith(".")
      )
        continue;
      try {
        workspaceParts.push(
          readFileSync(join(repoPath, child.name, "package.json"), "utf-8"),
        );
      } catch {
        /* not found */
      }
    }
  } catch {
    /* not found */
  }

  const root = rootParts.join("\n");
  return { root, all: root + "\n" + workspaceParts.join("\n") };
}

// Cache the top-level directory listing — avoids re-reading per marker check
function getChildDirs(repoPath: string): string[] {
  try {
    return readdirSync(repoPath, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."),
      )
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function findMarkerFile(
  repoPath: string,
  markers: string[],
  childDirs: string[],
): boolean {
  for (const marker of markers) {
    if (existsSync(join(repoPath, marker))) return true;
    for (const child of childDirs) {
      if (existsSync(join(repoPath, child, marker))) return true;
    }
  }
  return false;
}

function matchDeclarative(
  d: FrameworkDetect,
  depsLower: { root: string; all: string },
  repoPath: string,
  childDirs: string[],
): boolean {
  const content = d.scope === "all" ? depsLower.all : depsLower.root;
  const hasDep = d.depKeywords.some((kw) => content.includes(kw.toLowerCase()));
  const hasMarker =
    d.markers.length > 0 && findMarkerFile(repoPath, d.markers, childDirs);

  if (d.requireBoth) return hasDep && hasMarker;
  if (d.markers.length > 0) return hasDep || hasMarker;
  return hasDep;
}

function detectFrameworks(repoPath: string, ctx: ScanContext): FrameworkId[] {
  const detected: FrameworkId[] = [];
  const deps = readDepFiles(repoPath);
  const depsLower = {
    root: deps.root.toLowerCase(),
    all: deps.all.toLowerCase(),
  };
  const childDirs = getChildDirs(repoPath);

  for (const extractor of getAllExtractors()) {
    if (!extractor.detect) continue;

    if (typeof extractor.detect === "function") {
      if (extractor.detect(repoPath, ctx)) detected.push(extractor.id);
      continue;
    }

    // Declarative detection
    if (matchDeclarative(extractor.detect, depsLower, repoPath, childDirs)) {
      detected.push(extractor.id);
    }
  }

  // net/http fallback: only if no other Go framework detected
  const goFrameworks: FrameworkId[] = ["gin", "echo", "fiber"];
  if (
    !goFrameworks.some((gf) => detected.includes(gf)) &&
    existsSync(join(repoPath, "go.mod"))
  ) {
    for (const f of ctx.iterFiles([".go"])) {
      const content = ctx.readFile(f);
      if (content && /"net\/http"/.test(content)) {
        detected.push("net_http");
        break;
      }
    }
  }

  return detected;
}

// ---------------------------------------------------------------------------
// Main mapper
// ---------------------------------------------------------------------------

export function map(repoPath: string, options: MapOptions = {}): MapResult {
  const resolved = resolve(repoPath);
  const ctx = createScanContext(resolved);

  const frameworks = options.frameworkOverride
    ? [options.frameworkOverride]
    : detectFrameworks(resolved, ctx);

  const endpoints: EndpointInfo[] = [];

  for (const fw of frameworks) {
    const extractor = getExtractor(fw);
    if (!extractor) continue;
    try {
      endpoints.push(...extractor.extract(ctx));
    } catch (e) {
      console.error(`Error extracting ${fw} endpoints: ${e}`);
    }
  }

  // Extractors without detect are always attempted (e.g. openapi)
  for (const extractor of getAllExtractors()) {
    if (extractor.detect === undefined && !frameworks.includes(extractor.id)) {
      try {
        endpoints.push(...extractor.extract(ctx));
      } catch {
        /* skip */
      }
    }
  }

  // Mark internal, dedup, filter, sort
  for (const ep of endpoints) ep.internal = isInternalPath(ep.path);

  const seen = new Set<string>();
  const unique: EndpointInfo[] = [];
  for (const ep of endpoints) {
    const key = `${ep.method}::${ep.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(ep);
    }
  }

  const filtered = options.includeInternal
    ? unique
    : unique.filter((e) => !e.internal);
  filtered.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );

  return {
    repoPath: resolved,
    frameworks,
    endpoints: new EndpointIndex(filtered),
    filesScanned: ctx.filesScanned,
  };
}
