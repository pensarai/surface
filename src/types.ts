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
  path: string;
  handler: string;
  file: string;
  line: number;
  framework: FrameworkId;
  params: ParamInfo[];
  auth: string[];
  internal: boolean;
  service?: string;
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
