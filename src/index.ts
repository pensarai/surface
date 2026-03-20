// Public API — the boundary between Surface internals and consumers.
// Everything here is a stable contract. Internal modules (extractors,
// scan-context, utils) are implementation details.

export { map } from "./mapper.ts";
export type { MapOptions } from "./mapper.ts";
export type {
  EndpointInfo,
  FrameworkId,
  HttpMethod,
  MapResult,
  ParamInfo,
} from "./types.ts";
export { EndpointIndex } from "./endpoint-index.ts";
export {
  formatTable,
  formatJson,
  formatNdjson,
  formatMarkdown,
} from "./format.ts";
