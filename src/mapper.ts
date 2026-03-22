import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import type {
  EndpointInfo,
  FrameworkDetect,
  FrameworkId,
  MapRawResult,
  MapResult,
  ScanContext,
  ServiceInfo,
  ServiceType,
} from "./types.ts";
import { EndpointIndex } from "./endpoint-index.ts";
import { createScanContext, SKIP_DIRS } from "./scan-context.ts";
import { getAllExtractors, getExtractor } from "./extractors/index.ts";
import { isInternalPath } from "./utils.ts";
import { detectServices, createResolver } from "./services/index.ts";

export interface MapOptions {
  frameworkOverride?: FrameworkId;
  includeInternal?: boolean;
}

// ---------------------------------------------------------------------------
// Framework detection — driven by extractor `detect` declarations
// ---------------------------------------------------------------------------

const GO_FRAMEWORKS: FrameworkId[] = ["gin", "echo", "fiber"];

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
  "Cargo.toml",
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
  if (
    !GO_FRAMEWORKS.some((gf) => detected.includes(gf)) &&
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
// Service-aware framework detection — scans within each service root
// ---------------------------------------------------------------------------

/**
 * For repos with detected services (e.g. docker-compose monorepos),
 * run framework detection within each service root. This finds frameworks
 * that the root-level scan misses because dep files are nested too deep.
 *
 * Each service root is treated as if it were its own mini-repo:
 * dep files are read, markers are checked, and frameworks are matched.
 *
 * The key difference from root-level detection: `requireBoth` is relaxed
 * to dep-only matching. Being inside a known service root (identified by
 * compose/workspace/sst detection) provides the boundary signal that
 * markers normally provide — requiring both would be overly strict for
 * services where the entry point file has a non-standard name.
 */
function detectFrameworksInServices(
  repoPath: string,
  services: ServiceInfo[],
  ctx: ScanContext,
  alreadyDetected: FrameworkId[],
): FrameworkId[] {
  const additional: FrameworkId[] = [];
  const seen = new Set<FrameworkId>(alreadyDetected);

  for (const svc of services) {
    const svcPath = join(repoPath, svc.root);
    if (!existsSync(svcPath)) continue;

    const deps = readDepFiles(svcPath);
    const depsLower = {
      root: deps.root.toLowerCase(),
      all: deps.all.toLowerCase(),
    };
    const childDirs = getChildDirs(svcPath);

    for (const extractor of getAllExtractors()) {
      if (!extractor.detect || seen.has(extractor.id)) continue;

      if (typeof extractor.detect === "function") {
        if (extractor.detect(svcPath, ctx)) {
          additional.push(extractor.id);
          seen.add(extractor.id);
        }
        continue;
      }

      // Within a known service root, relax requireBoth to dep-only.
      // The service boundary itself is sufficient signal.
      const detect = extractor.detect;
      const relaxed = detect.requireBoth
        ? { ...detect, requireBoth: false }
        : detect;
      if (matchDeclarative(relaxed, depsLower, svcPath, childDirs)) {
        additional.push(extractor.id);
        seen.add(extractor.id);
      }
    }

    // net/http fallback within service root
    if (
      !GO_FRAMEWORKS.some((gf) => seen.has(gf)) &&
      !seen.has("net_http") &&
      existsSync(join(svcPath, "go.mod"))
    ) {
      for (const f of ctx.iterFiles([".go"])) {
        const content = ctx.readFile(f);
        if (content && /"net\/http"/.test(content)) {
          additional.push("net_http");
          seen.add("net_http");
          break;
        }
      }
    }
  }

  return additional;
}

// ---------------------------------------------------------------------------
// Service type refinement — upgrades generic types using extracted endpoints
// ---------------------------------------------------------------------------

const FRAMEWORK_TO_SERVICE_TYPE: Partial<Record<FrameworkId, ServiceType>> = {
  nextjs: "nextjs",
  server_actions: "server_actions",
  express: "express",
  sst: "api_gateway",
};

function refineServiceTypes(
  services: ServiceInfo[],
  endpoints: EndpointInfo[],
): ServiceInfo[] {
  // Count frameworks per service
  const fwCounts = new Map<string, Map<FrameworkId, number>>();
  for (const ep of endpoints) {
    if (!ep.service) continue;
    let counts = fwCounts.get(ep.service);
    if (!counts) {
      counts = new Map();
      fwCounts.set(ep.service, counts);
    }
    counts.set(ep.framework, (counts.get(ep.framework) ?? 0) + 1);
  }

  return services.map((svc) => {
    if (svc.type !== "generic") return svc;
    const counts = fwCounts.get(svc.name);
    if (!counts) return svc;

    // Use the most common framework's mapped type
    let maxFw: FrameworkId | null = null;
    let maxCount = 0;
    for (const [fw, count] of counts) {
      if (count > maxCount) {
        maxFw = fw;
        maxCount = count;
      }
    }

    if (maxFw) {
      const mapped = FRAMEWORK_TO_SERVICE_TYPE[maxFw];
      if (mapped) return { ...svc, type: mapped };
    }
    return svc;
  });
}

// ---------------------------------------------------------------------------
// Raw mapper — returns pre-dedup, pre-filter endpoints for impact analysis
// ---------------------------------------------------------------------------

export function mapRaw(
  repoPath: string,
  options: MapOptions = {},
): MapRawResult {
  const resolved = resolve(repoPath);
  const ctx = createScanContext(resolved);

  // 1. Detect services first — needed to enhance framework detection
  const services = detectServices(resolved, ctx);

  // 2. Detect frameworks at repo root
  const frameworks = options.frameworkOverride
    ? [options.frameworkOverride]
    : detectFrameworks(resolved, ctx);

  // 3. Enhance: scan within service roots for frameworks the root scan missed
  if (!options.frameworkOverride && services.length > 0) {
    const extra = detectFrameworksInServices(
      resolved,
      services,
      ctx,
      frameworks,
    );
    frameworks.push(...extra);
  }

  // 4. Extract endpoints
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

  // 5. Assign endpoints to services
  const resolveService = createResolver(services);
  for (const ep of endpoints) {
    ep.service = resolveService(ep.file);
  }

  // 6. Refine service types from extracted endpoint frameworks
  const refinedServices = refineServiceTypes(services, endpoints);

  // Mark internal
  for (const ep of endpoints) ep.internal = isInternalPath(ep.path);

  return {
    repoPath: resolved,
    frameworks,
    endpoints,
    services: refinedServices,
    filesScanned: ctx.filesScanned,
  };
}

// ---------------------------------------------------------------------------
// Main mapper — dedup, filter, sort over raw results
// ---------------------------------------------------------------------------

export function map(repoPath: string, options: MapOptions = {}): MapResult {
  const raw = mapRaw(repoPath, options);

  const seen = new Set<string>();
  const unique: EndpointInfo[] = [];
  for (const ep of raw.endpoints) {
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
    repoPath: raw.repoPath,
    frameworks: raw.frameworks,
    endpoints: new EndpointIndex(filtered),
    services: raw.services,
    filesScanned: raw.filesScanned,
  };
}
