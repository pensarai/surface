import type { EndpointInfo, Extractor } from "../types.ts";
import {
  buildLineIndex,
  endpoint,
  extractPathParams,
  normalizePath,
} from "../utils.ts";

export const nestjs: Extractor = {
  id: "nestjs",
  detect: { depKeywords: ["@nestjs/core"], markers: [], scope: "root" },
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];
    const tsFiles = ctx.iterFiles([".ts"]);

    const controllerRe = /@Controller\s*\(\s*['"]([^'"]*)['"]\s*\)/;
    const methodRe =
      /@(Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*['"]?([^'")]*?)['"]?\s*\)(.*?)(?:async\s+)?(\w+)\s*\(/gs;
    const guardRe = /@UseGuards?\s*\(\s*(\w+)/g;

    for (const f of tsFiles) {
      const content = ctx.readFile(f);
      if (!content || !content.includes("@Controller")) continue;
      const rel = ctx.rel(f);

      const ctrlMatch = controllerRe.exec(content);
      const controllerPrefix = ctrlMatch?.[1] ?? "";

      // Class-level guards
      const classAuth: string[] = [];
      const classIdx = content.indexOf("class ");
      if (classIdx > 0) {
        const preClass = content.slice(0, classIdx);
        for (const gm of preClass.matchAll(guardRe)) {
          classAuth.push(`@UseGuards(${gm[1]})`);
        }
      }

      const lines = buildLineIndex(content);
      for (const m of content.matchAll(methodRe)) {
        const httpMethod = m[1]!.toUpperCase();
        const routePath = m[2]!;
        const between = m[3]!;
        const handler = m[4]!;
        const line = lines.lineAt(m.index);

        const fullPath = normalizePath(controllerPrefix + "/" + routePath);
        const params = extractPathParams(fullPath);

        const methodAuth = [...classAuth];
        for (const gm of between.matchAll(/@UseGuards?\s*\(\s*(\w+)/g)) {
          methodAuth.push(`@UseGuards(${gm[1]})`);
        }

        const searchText = between + m[0];
        for (const pm of searchText.matchAll(/@Query\s*\(\s*['"]?(\w+)/g)) {
          params.push({ name: pm[1]!, location: "query", required: true });
        }
        for (const pm of searchText.matchAll(/@Param\s*\(\s*['"]?(\w+)/g)) {
          params.push({ name: pm[1]!, location: "path", required: true });
        }

        endpoints.push(
          endpoint({
            method: httpMethod,
            path: fullPath,
            handler,
            file: rel,
            line,
            framework: "nestjs",
            params,
            auth: methodAuth,
          }),
        );
      }
    }

    // gRPC handlers (@GrpcMethod / @GrpcStreamMethod). Emitted unconditionally;
    // when a .proto also defines the method, the mapper prefers the
    // package-qualified proto endpoint over this bare decorator one.
    const grpcRe =
      /@(GrpcMethod|GrpcStreamMethod)\s*\(([^)]*)\)[\s\S]{0,160}?(?:async\s+)?(\w+)\s*\(/g;
    for (const f of tsFiles) {
      const content = ctx.readFile(f);
      if (!content || !content.includes("@Grpc")) continue;
      const rel = ctx.rel(f);
      const lines = buildLineIndex(content);
      // Associate each decorator with the class that owns it (nearest `class`
      // declared before it), so files with multiple controllers resolve the
      // fallback service name from the right class.
      const classes = [...content.matchAll(/\bclass\s+(\w+)/g)].map((c) => ({
        name: c[1]!,
        index: c.index,
      }));
      const classAt = (offset: number) => {
        let name = "";
        for (const c of classes) {
          if (c.index < offset) name = c.name;
          else break;
        }
        return name;
      };
      for (const m of content.matchAll(grpcRe)) {
        const args = [...m[2]!.matchAll(/['"]([^'"]+)['"]/g)].map((a) => a[1]!);
        const handler = m[3]!;
        const service = args[0] ?? classAt(m.index).replace(/Controller$/, "");
        const method =
          args[1] ?? handler.charAt(0).toUpperCase() + handler.slice(1);
        endpoints.push(
          endpoint({
            method: "ANY",
            path: `/${service}/${method}`,
            handler,
            file: rel,
            line: lines.lineAt(m.index),
            framework: "nestjs",
            transport: "grpc",
            grpc: {
              serviceFqn: service,
              method,
              streamingType: m[1] === "GrpcStreamMethod" ? "bidi" : "unary",
            },
          }),
        );
      }
    }

    return endpoints;
  },
};
