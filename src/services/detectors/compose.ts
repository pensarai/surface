import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import type { ServiceInfo, ScanContext } from "../../types.ts";
import { inferServiceType } from "../infer-type.ts";

/** Compose service names that are infrastructure, not application code. */
const INFRA_NAMES = new Set([
  "postgres",
  "postgresql",
  "mysql",
  "mariadb",
  "mongo",
  "mongodb",
  "redis",
  "memcached",
  "rabbitmq",
  "kafka",
  "zookeeper",
  "nginx",
  "envoy",
  "consul",
  "etcd",
  "vault",
  "influxdb",
  "grafana",
  "prometheus",
  "elasticsearch",
  "kibana",
  "logstash",
  "mailhog",
  "minio",
  "localstack",
  "dynamodb-local",
  "jaeger",
  "zipkin",
]);

/** Suffixes that signal a compose service is infrastructure/mock. */
const INFRA_SUFFIXES = ["-sim", "-mock", "-db", "-cache", "-queue"];

/** Files that indicate a directory contains application source code. */
const SOURCE_MARKERS = [
  "package.json",
  "go.mod",
  "requirements.txt",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "setup.py",
  "pyproject.toml",
];

/** Source file extensions to check if no manifest is found. */
const SOURCE_EXTENSIONS = [
  ".py",
  ".go",
  ".ts",
  ".js",
  ".rs",
  ".java",
  ".rb",
  ".php",
];

/** Check if a compose service name looks like infrastructure. */
function isInfraService(name: string): boolean {
  const lower = name.toLowerCase();
  if (INFRA_NAMES.has(lower)) return true;
  return INFRA_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Check if a directory contains actual source code (checks root + one level deep). */
function hasSourceCode(absDir: string): boolean {
  if (SOURCE_MARKERS.some((f) => existsSync(join(absDir, f)))) return true;

  try {
    const entries = readdirSync(absDir, { withFileTypes: true });
    // Check for source files directly in the directory
    if (
      entries.some(
        (e) =>
          e.isFile() && SOURCE_EXTENSIONS.some((ext) => e.name.endsWith(ext)),
      )
    )
      return true;

    // Check one level deeper (e.g. app/src/*.php)
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const subEntries = readdirSync(join(absDir, entry.name));
        if (
          subEntries.some((e) =>
            SOURCE_EXTENSIONS.some((ext) => e.endsWith(ext)),
          )
        )
          return true;
      } catch {
        /* skip */
      }
    }
  } catch {
    return false;
  }

  return false;
}

interface ComposeFile {
  services?: Record<
    string,
    {
      build?: string | { context?: string; dockerfile?: string };
      image?: string;
    }
  >;
}

/**
 * Detect services from docker-compose.yml files.
 *
 * A compose service qualifies as an application service if:
 * 1. It has a build context (not just an image reference)
 * 2. The build context directory contains source code
 * 3. Its name doesn't match known infrastructure patterns
 */
export function detectCompose(
  repoPath: string,
  _ctx: ScanContext,
  existing: ServiceInfo[],
): ServiceInfo[] {
  const composeNames = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ];

  let composeContent: string | null = null;
  for (const name of composeNames) {
    try {
      composeContent = readFileSync(join(repoPath, name), "utf-8");
      break;
    } catch {
      /* not found */
    }
  }

  if (!composeContent) return [];

  let compose: ComposeFile;
  try {
    compose = yaml.load(composeContent) as ComposeFile;
  } catch {
    return [];
  }

  if (!compose?.services) return [];

  const claimedRoots = new Set(existing.map((s) => s.root));
  const services: ServiceInfo[] = [];

  for (const [name, svc] of Object.entries(compose.services)) {
    // Skip services without build context (image-only)
    if (!svc.build) continue;

    // Extract build context path
    const context =
      typeof svc.build === "string" ? svc.build : (svc.build.context ?? ".");

    // Normalize: strip leading "./"
    const root = context.replace(/^\.\//, "").replace(/\/+$/, "");

    // Skip if already claimed by a higher-priority detector
    if (claimedRoots.has(root)) continue;

    // Skip infrastructure services
    if (isInfraService(name)) continue;

    // Verify the build context contains source code
    const absDir = join(repoPath, root);
    if (!existsSync(absDir) || !hasSourceCode(absDir)) continue;

    services.push({
      name,
      type: inferServiceType(join(repoPath, root)),
      root,
    });
  }

  return services;
}
