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

    return endpoints;
  },
};
