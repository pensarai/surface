import type { EndpointInfo, Extractor } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  findAuthDecorators,
  normalizePath,
} from "../utils.ts";

const JAVA_EXTS = [".java", ".kt"];

const METHOD_MAP: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
};

export const spring: Extractor = {
  id: "spring",
  detect: { depKeywords: ["spring-boot"], markers: [], scope: "root" },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const javaFiles = ctx.iterFiles(JAVA_EXTS);

    const classMappingRe =
      /@RequestMapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/;
    const methodMappingRe =
      /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*\(\s*(?:value\s*=\s*)?['"]?([^'")]*?)['"]?\s*\)(.*?)(?:public|private|protected)?\s*\w[\w<>,\s]*\s+(\w+)\s*\(/gs;
    const reqMappingMethodRe =
      /@RequestMapping\s*\([^)]*method\s*=\s*RequestMethod\.(\w+)[^)]*(?:value\s*=\s*)?['"]?([^'")]*?)['"]?[^)]*\)(.*?)(?:public|private|protected)?\s*\w[\w<>,\s]*\s+(\w+)\s*\(/gs;

    for (const f of javaFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      const rel = ctx.rel(f);

      const cm = classMappingRe.exec(content);
      const classPrefix = cm?.[1] ?? "";
      const lines = buildLineIndex(content);

      for (const m of content.matchAll(methodMappingRe)) {
        const fullPath = normalizePath(classPrefix + "/" + m[2]!);
        endpoints.push(
          endpoint({
            method: METHOD_MAP[m[1]!] ?? "ANY",
            path: fullPath,
            handler: m[4]!,
            file: rel,
            line: lines.lineAt(m.index),
            framework: "spring",
            params: extractPathParams(fullPath),
            auth: findAuthDecorators(m[3]!),
          }),
        );
      }

      for (const m of content.matchAll(reqMappingMethodRe)) {
        const fullPath = normalizePath(classPrefix + "/" + m[2]!);
        endpoints.push(
          endpoint({
            method: m[1]!.toUpperCase(),
            path: fullPath,
            handler: m[4]!,
            file: rel,
            line: lines.lineAt(m.index),
            framework: "spring",
            params: extractPathParams(fullPath),
            auth: findAuthDecorators(m[3]!),
          }),
        );
      }
    }

    return endpoints;
  },
};
