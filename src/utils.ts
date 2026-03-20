import type {
  EndpointInfo,
  FrameworkId,
  HttpMethod,
  ParamInfo,
} from "./types.ts";

const INTERNAL_PREFIXES = [
  "/_",
  "/internal/",
  "/debug/",
  "/health",
  "/__",
  "/metrics",
  "/readyz",
  "/livez",
  "/startupz",
];

const AUTH_PATTERNS = [
  /@login_required/i,
  /@jwt_required/i,
  /@requires_auth/i,
  /@auth_required/i,
  /@permission_required/i,
  /@authenticated/i,
  /@protected/i,
  /@require_login/i,
  /@token_required/i,
  /@UseGuards?\(/i,
  /@PreAuthorize\(/i,
  /@Secured\(/i,
  /Depends\(\s*\w*[Aa]uth/i,
  /Depends\(\s*get_current_user/i,
  /before_action\s+:authenticate/i,
  /middleware\(['"]auth/i,
];

export function isInternalPath(path: string): boolean {
  const lower = path.toLowerCase();
  return INTERNAL_PREFIXES.some((p) => lower.startsWith(p));
}

export function findAuthDecorators(text: string): string[] {
  const found: string[] = [];
  for (const pat of AUTH_PATTERNS) {
    const m = pat.exec(text);
    if (m) found.push(m[0].trim());
  }
  return found;
}

export function extractPathParams(path: string): ParamInfo[] {
  const params: ParamInfo[] = [];
  // Flask/FastAPI/Starlette: <name> or <type:name> or {name}
  for (const m of path.matchAll(/<(?:\w+:)?(\w+)>|\{(\w+)\}/g)) {
    params.push({ name: m[1] ?? m[2]!, location: "path", required: true });
  }
  // Express/Next.js: :name
  for (const m of path.matchAll(/:(\w+)/g)) {
    params.push({ name: m[1]!, location: "path", required: true });
  }
  // Next.js bracket syntax: [name]
  for (const m of path.matchAll(/\[(\w+)\]/g)) {
    params.push({ name: m[1]!, location: "path", required: true });
  }
  return params;
}

export function normalizePath(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/+/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");
  return path;
}

export function lineNumber(content: string, offset: number): number {
  let count = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") count++;
  }
  return count;
}

export function buildLineIndex(content: string): {
  lineAt(offset: number): number;
} {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1);
  }
  return {
    lineAt(offset: number): number {
      let lo = 0,
        hi = offsets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offsets[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
  };
}

export function endpoint(e: {
  method: HttpMethod | string;
  path: string;
  handler: string;
  file: string;
  line: number;
  framework: FrameworkId;
  params?: ParamInfo[];
  auth?: string[];
}): EndpointInfo {
  return {
    method: e.method as HttpMethod,
    path: e.path,
    handler: e.handler,
    file: e.file,
    line: e.line,
    framework: e.framework,
    params: e.params ?? [],
    auth: e.auth ?? [],
    internal: false,
  };
}
