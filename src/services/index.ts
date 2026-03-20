import type { ServiceInfo, ScanContext } from "../types.ts";
import { detectWorkspaces } from "./detectors/workspace.ts";
import { detectCompose } from "./detectors/compose.ts";
import { detectSstServices } from "./detectors/sst.ts";
import { detectDirectories } from "./detectors/directory.ts";

export { createResolver } from "./resolver.ts";

export type ServiceDetector = (
  repoPath: string,
  ctx: ScanContext,
  existing: ServiceInfo[],
) => ServiceInfo[];

/**
 * Detectors run in priority order. Each receives the accumulated services
 * from prior detectors — later detectors can refine or skip already-claimed
 * directories.
 */
const DETECTORS: ServiceDetector[] = [
  detectWorkspaces,
  detectCompose,
  detectSstServices,
  detectDirectories,
];

/**
 * Detect deployable services in a repository.
 *
 * Returns an empty array for repos where no service structure is detected,
 * which signals formatters to fall back to framework-based grouping.
 */
export function detectServices(
  repoPath: string,
  ctx: ScanContext,
): ServiceInfo[] {
  let services: ServiceInfo[] = [];

  for (const detect of DETECTORS) {
    const found = detect(repoPath, ctx, services);
    services = mergeServices(services, found);
  }

  return services;
}

/**
 * Merge newly detected services into the existing list.
 * If a service root is already claimed, the new detection can refine
 * the type (e.g. SST upgrading a workspace to api_gateway) but won't
 * create a duplicate.
 */
function mergeServices(
  existing: ServiceInfo[],
  incoming: ServiceInfo[],
): ServiceInfo[] {
  const byRoot = new Map(existing.map((s) => [s.root, { ...s }]));

  for (const svc of incoming) {
    const prev = byRoot.get(svc.root);
    if (prev) {
      // Later detector refines type (e.g. generic → api_gateway)
      if (prev.type === "generic" || svc.type !== "generic") {
        byRoot.set(svc.root, { ...prev, type: svc.type });
      }
    } else {
      byRoot.set(svc.root, svc);
    }
  }

  return [...byRoot.values()];
}
