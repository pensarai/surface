import type { EndpointInfo, EndpointKind, Extractor } from "../types.ts";
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

// Represents a class-level context discovered in a Java/Kotlin file.
// Used to decide whether mapped methods inside the class are page-rendering
// or REST API handlers.
type ClassCtx = {
  start: number; // offset of the class keyword
  // kind is "page" when the class is annotated with @Controller but NOT
  // @RestController. @RestController = @Controller + @ResponseBody, so any
  // class with @RestController (with or without @Controller) is treated as api.
  kind: EndpointKind;
};

// Find class-level annotation contexts in a single source file.
// We scan the annotations preceding each `class` declaration and decide its
// kind. Inner classes are supported because we just look at the immediately
// preceding annotation block per class declaration.
function collectClassContexts(content: string): ClassCtx[] {
  const out: ClassCtx[] = [];
  // Match `class Foo` (Java/Kotlin). We use the start of the `class` keyword
  // as the anchor; then look backwards through a window of preceding text for
  // class-level annotations.
  const classRe = /\bclass\s+\w+/g;
  for (const m of content.matchAll(classRe)) {
    const classStart = m.index!;
    // Look back up to ~600 chars for the annotation block. Annotations live on
    // their own lines just above the class keyword. We stop at the previous
    // `}` or `;` to avoid bleeding into earlier classes.
    const windowStart = Math.max(0, classStart - 600);
    let preamble = content.slice(windowStart, classStart);
    const lastBrace = Math.max(
      preamble.lastIndexOf("}"),
      preamble.lastIndexOf(";"),
    );
    if (lastBrace >= 0) preamble = preamble.slice(lastBrace + 1);
    const hasRest = /@RestController\b/.test(preamble);
    const hasController = /@Controller\b/.test(preamble);
    if (!hasRest && !hasController) continue;
    // @Controller without @RestController = page-rendering controller.
    // @RestController (alone or alongside @Controller) = REST api.
    out.push({ start: classStart, kind: hasRest ? "api" : "page" });
  }
  return out;
}

// Returns the kind of the class that contains the given offset. Defaults to
// "api" when no class context is found (e.g., free-floating mapping in a
// config or a file without @Controller / @RestController).
function kindForOffset(classes: ClassCtx[], offset: number): EndpointKind {
  let current: EndpointKind = "api";
  for (const c of classes) {
    if (c.start <= offset) current = c.kind;
    else break;
  }
  return current;
}

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
    // @MessageMapping / @SubscribeMapping = STOMP/WebSocket message handler.
    // The annotation's path is the destination; method name is the handler.
    const wsMappingRe =
      /@(MessageMapping|SubscribeMapping)\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]\s*\)(.*?)(?:public|private|protected)?\s*\w[\w<>,\s]*\s+(\w+)\s*\(/gs;

    for (const f of javaFiles) {
      const content = ctx.readFile(f);
      if (!content) continue;
      const rel = ctx.rel(f);

      const cm = classMappingRe.exec(content);
      const classPrefix = cm?.[1] ?? "";
      const lines = buildLineIndex(content);
      const classCtxs = collectClassContexts(content);

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
            kind: kindForOffset(classCtxs, m.index),
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
            kind: kindForOffset(classCtxs, m.index),
            params: extractPathParams(fullPath),
            auth: findAuthDecorators(m[3]!),
          }),
        );
      }

      // WebSocket handlers via Spring Messaging (STOMP). These can live in
      // any class — including @Controller — but they're always websocket
      // routes, not page or api routes.
      for (const m of content.matchAll(wsMappingRe)) {
        const fullPath = normalizePath(m[2]!);
        endpoints.push(
          endpoint({
            method: "WS",
            path: fullPath,
            handler: m[4]!,
            file: rel,
            line: lines.lineAt(m.index),
            framework: "spring",
            kind: "websocket",
            params: extractPathParams(fullPath),
            auth: findAuthDecorators(m[3]!),
          }),
        );
      }
    }

    return endpoints;
  },
};
