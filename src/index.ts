// Public API — the boundary between Surface internals and consumers.
// Everything here is a stable contract. Internal modules (extractors,
// scan-context, utils) are implementation details.

export { map } from "./mapper.ts";
export type { MapOptions } from "./mapper.ts";
export type {
  AffectedEndpoint,
  DiffHunk,
  EndpointInfo,
  EndpointKind,
  FunctionDef,
  FrameworkId,
  HttpMethod,
  ImpactResult,
  MapResult,
  ParamInfo,
  ServiceInfo,
  ServiceType,
} from "./types.ts";
export { EndpointIndex } from "./endpoint-index.ts";
export {
  formatTable,
  formatJson,
  formatNdjson,
  formatMarkdown,
} from "./format.ts";
export {
  formatImpactTable,
  formatImpactJson,
  formatImpactNdjson,
  formatImpactMarkdown,
} from "./format-impact.ts";
export type { FormatOptions, GroupBy } from "./format.ts";
export { detectServices } from "./services/index.ts";
export { impact } from "./impact.ts";
export type { ImpactOptions } from "./impact.ts";

export { findFunctions } from "./function-finder.ts";
