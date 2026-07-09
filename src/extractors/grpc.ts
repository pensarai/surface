import { join } from "path";
import type {
  EndpointInfo,
  Extractor,
  FrameworkId,
  GrpcStreaming,
  ScanContext,
} from "../types.ts";
import { buildLineIndex, endpoint } from "../utils.ts";

const CONNECT_HINTS = [
  "connectrpc.com/connect",
  "@connectrpc/",
  "protoc-gen-connect",
  "connect-go",
  "connect-es",
  "connectrpc",
];

const DEP_FILES = [
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "buf.gen.yaml",
  "buf.yaml",
  "requirements.txt",
  "pyproject.toml",
];

function usesConnect(ctx: ScanContext): boolean {
  for (const f of DEP_FILES) {
    const c = ctx.readFile(join(ctx.repoPath, f));
    if (c && CONNECT_HINTS.some((h) => c.toLowerCase().includes(h)))
      return true;
  }
  return false;
}

// Blank out comments while preserving byte offsets and newlines. String-aware:
// proto path options carry `/*`, `*/` and `//` inside quoted literals
// (e.g. "/v1/{name=projects/*/topics/*}"), which must NOT be read as comments.
function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < src.length) {
          out += src[i]! + src[i + 1]!;
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      if (i < src.length) {
        out += src[i];
        i++;
      }
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && src[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < src.length) {
        out += "  ";
        i += 2;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function streaming(client: boolean, server: boolean): GrpcStreaming {
  if (client && server) return "bidi";
  if (client) return "client_stream";
  if (server) return "server_stream";
  return "unary";
}

const PACKAGE_RE = /\bpackage\s+([A-Za-z_][\w.]*)\s*;/;
const SERVICE_RE = /\bservice\s+([A-Za-z_]\w*)\s*\{/g;
const RPC_RE =
  /\brpc\s+([A-Za-z_]\w*)\s*\(\s*(stream\s+)?[.\w]+\s*\)\s*returns\s*\(\s*(stream\s+)?[.\w]+\s*\)/g;

export const grpc: Extractor = {
  id: "grpc",
  detect: (_repoPath, ctx) => ctx.iterFiles([".proto"]).length > 0,
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const framework: FrameworkId = usesConnect(ctx) ? "connect" : "grpc";
    const transport = framework === "connect" ? "connect" : "grpc";

    for (const file of ctx.iterFiles([".proto"])) {
      const raw = ctx.readFile(file);
      if (!raw) continue;
      const src = stripComments(raw);
      const rel = ctx.rel(file);
      const lines = buildLineIndex(raw);
      const pkg = PACKAGE_RE.exec(src)?.[1] ?? "";

      // Services never nest and rpcs only live inside them, so each rpc belongs
      // to the nearest service declared before it — no brace matching needed.
      const services: { name: string; index: number }[] = [];
      SERVICE_RE.lastIndex = 0;
      let s: RegExpExecArray | null;
      while ((s = SERVICE_RE.exec(src))) {
        services.push({ name: s[1]!, index: s.index });
      }
      if (!services.length) continue;

      RPC_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RPC_RE.exec(src))) {
        let svc: { name: string; index: number } | null = null;
        for (const cand of services) {
          if (cand.index < m.index) svc = cand;
          else break;
        }
        if (!svc) continue;

        const serviceFqn = pkg ? `${pkg}.${svc.name}` : svc.name;
        const method = m[1]!;
        endpoints.push(
          endpoint({
            method: "ANY",
            path: `/${serviceFqn}/${method}`,
            handler: method,
            file: rel,
            line: lines.lineAt(m.index),
            framework,
            transport,
            grpc: {
              serviceFqn,
              method,
              streamingType: streaming(!!m[2], !!m[3]),
            },
          }),
        );
      }
    }

    return endpoints;
  },
};
