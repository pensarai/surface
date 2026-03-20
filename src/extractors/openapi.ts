import { existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import type { EndpointInfo, Extractor, ParamInfo } from "../types.ts";
import { endpoint, normalizePath } from "../utils.ts";

const SPEC_PATTERNS = [
  "openapi.json",
  "openapi.yaml",
  "openapi.yml",
  "swagger.json",
  "swagger.yaml",
  "swagger.yml",
  "api-spec.json",
  "api-spec.yaml",
  "docs/openapi.json",
  "docs/openapi.yaml",
];

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
] as const;

export const openapi: Extractor = {
  id: "openapi",
  extract(ctx) {
    const endpoints: EndpointInfo[] = [];

    for (const pattern of SPEC_PATTERNS) {
      const specFile = join(ctx.repoPath, pattern);
      if (!existsSync(specFile)) continue;
      ctx.filesScanned++;

      const content = ctx.readFile(specFile);
      if (!content) continue;

      let spec: unknown;
      try {
        spec = specFile.endsWith(".json")
          ? JSON.parse(content)
          : yaml.load(content);
      } catch {
        continue;
      }

      if (!spec || typeof spec !== "object" || !("paths" in spec)) continue;
      const paths = (spec as Record<string, unknown>).paths;
      if (!paths || typeof paths !== "object") continue;

      const rel = ctx.rel(specFile);

      for (const [pathStr, pathItem] of Object.entries(
        paths as Record<string, unknown>,
      )) {
        if (!pathItem || typeof pathItem !== "object") continue;
        const pathObj = pathItem as Record<string, unknown>;

        for (const method of HTTP_METHODS) {
          const operation = pathObj[method];
          if (!operation || typeof operation !== "object") continue;
          const op = operation as Record<string, unknown>;

          const handler = (op.operationId as string) ?? method;
          const params: ParamInfo[] = [];

          const allParams = [
            ...((op.parameters ?? []) as Record<string, unknown>[]),
            ...((pathObj.parameters ?? []) as Record<string, unknown>[]),
          ];

          for (const p of allParams) {
            if (!p || typeof p !== "object") continue;
            const schema = p.schema as Record<string, unknown> | undefined;
            params.push({
              name: (p.name as string) ?? "?",
              location: ((p.in as string) ?? "query") as ParamInfo["location"],
              type: schema?.type as string | undefined,
              required: (p.required as boolean) ?? false,
            });
          }

          const auth: string[] = [];
          const security = op.security as Record<string, unknown>[] | undefined;
          if (security) {
            for (const sec of security) {
              if (sec && typeof sec === "object")
                auth.push(...Object.keys(sec));
            }
          }

          endpoints.push(
            endpoint({
              method: method.toUpperCase(),
              path: normalizePath(pathStr),
              handler,
              file: rel,
              line: 0,
              framework: "openapi",
              params,
              auth,
            }),
          );
        }
      }
    }

    return endpoints;
  },
};
