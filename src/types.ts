import type { EndpointIndex } from "./endpoint-index.ts";

export interface ParamInfo {
  name: string;
  location: "path" | "query" | "body" | "header";
  type?: string;
  required: boolean;
}

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS"
  | "ANY"
  | "WS"
  | "ACTION";

export type EndpointKind = "api" | "page" | "action" | "websocket";

export type ServiceType =
  | "nextjs"
  | "lambda"
  | "ecs"
  | "server_actions"
  | "express"
  | "api_gateway"
  | "static"
  | "generic";

export interface ServiceInfo {
  name: string;
  type: ServiceType;
  root: string;
}

export interface EndpointInfo {
  method: HttpMethod;
  kind: EndpointKind;
  path: string;
  handler: string;
  file: string;
  line: number;
  framework: FrameworkId;
  params: ParamInfo[];
  auth: string[];
  internal: boolean;
  service?: string;
  /** Repo-relative path of the handler's source file, when distinct from `file`
   *  (e.g. SST routes declared in infra/ but implemented in packages/functions/). */
  handlerFile?: string;
  /** Repo-relative directory the handler belongs to (e.g. "packages/functions"),
   *  used to assign endpoints to the correct service when `file` is the
   *  declaration site rather than the handler. */
  serviceRoot?: string;
}

export interface MapRawResult {
  repoPath: string;
  frameworks: FrameworkId[];
  endpoints: EndpointInfo[];
  services: ServiceInfo[];
  filesScanned: number;
}

export interface MapResult {
  repoPath: string;
  frameworks: FrameworkId[];
  endpoints: EndpointIndex;
  services: ServiceInfo[];
  filesScanned: number;
}

export type FrameworkId =
  | "flask"
  | "fastapi"
  | "django"
  | "express"
  | "nestjs"
  | "nextjs"
  | "gin"
  | "echo"
  | "fiber"
  | "net_http"
  | "actix"
  | "spring"
  | "rails"
  | "laravel"
  | "sst"
  | "server_actions"
  | "openapi";

export interface FrameworkDetect {
  /** Substring matches checked against dependency file content */
  depKeywords: string[];
  /** Marker files that indicate this framework (checked at root + one level deep) */
  markers: string[];
  /** "root" = only check root dep files, "all" = check workspace deps too */
  scope: "root" | "all";
  /** If true, require BOTH a dep keyword match AND a marker file */
  requireBoth?: boolean;
}

export interface Extractor {
  id: FrameworkId;
  /** Declarative detection config, custom function, or omitted (always attempted) */
  detect?: FrameworkDetect | ((repoPath: string, ctx: ScanContext) => boolean);
  extract(ctx: ScanContext): EndpointInfo[];
}

export interface ScanContext {
  repoPath: string;
  readFile(path: string): string | null;
  iterFiles(extensions: string[]): string[];
  rel(absolutePath: string): string;
  filesScanned: number;
}

// ---------------------------------------------------------------------------
// Diff / Impact types
// ---------------------------------------------------------------------------

export interface DiffHunk {
  file: string;
  startLine: number;
  endLine: number;
}

export interface FunctionDef {
  name: string;
  line: number;
}

export type ImpactReason = "direct" | "handler" | "file";

export interface AffectedEndpoint {
  endpoint: EndpointInfo;
  matchedHunks: DiffHunk[];
  reason: ImpactReason;
  matchedFunction?: string;
}

export interface ImpactResult {
  repoPath: string;
  affected: AffectedEndpoint[];
  summary: {
    totalEndpoints: number;
    affectedEndpoints: number;
    filesChanged: number;
    filesWithEndpoints: number;
    hunksAnalyzed: number;
  };
}
