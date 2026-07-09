import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { map } from "../index.ts";
import { nestjs } from "./nestjs.ts";
import { createScanContext } from "../scan-context.ts";

// Pattern for kind-detection tests:
//   1. Load fixture dir under src/extractors/__fixtures__/<framework>/
//   2. Call map() against it (filter via frameworkOverride for isolation)
//   3. Assert endpoints contain expected shapes by kind using
//      expect.objectContaining so unrelated fields don't break the match.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "__fixtures__/nestjs");

describe("nestjs extractor", () => {
  it("emits correct kinds for api, page, and websocket routes", () => {
    const result = map(FIXTURE_DIR, { frameworkOverride: "nestjs" });
    const endpoints = result.endpoints.all;

    expect(endpoints).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: expect.stringContaining("users"),
        kind: "api",
      }),
    );

    expect(endpoints).toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining("about"),
        kind: "page",
      }),
    );

    expect(endpoints).toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining("message"),
        kind: "websocket",
      }),
    );
  });

  it("does not let @Render bleed onto sibling api methods", () => {
    const result = map(FIXTURE_DIR, { frameworkOverride: "nestjs" });
    const endpoints = result.endpoints.all;

    // The "/data" endpoint sits directly below a @Render-decorated method
    // in the same controller. Its kind must be "api", not "page".
    const data = endpoints.find((e) => e.path.endsWith("data"));
    expect(data).toBeDefined();
    expect(data?.kind).toBe("api");
  });

  it("attributes each @Controller prefix to its own class in a multi-class file", () => {
    const result = map(FIXTURE_DIR, { frameworkOverride: "nestjs" });
    const endpoints = result.endpoints.all;

    // Two controllers share one file. Each route must carry its own class
    // prefix, not the first class's prefix bleeding onto later classes.
    const one = endpoints.find((e) => e.handler === "one");
    const two = endpoints.find((e) => e.handler === "two");
    expect(one?.path).toBe("/alpha/one");
    expect(two?.path).toBe("/beta/two");
  });
});

describe("nestjs code-first gRPC", () => {
  const eps = nestjs.extract(
    createScanContext(path.join(__dirname, "__fixtures__/nestjs-grpc")),
  );
  const grpc = eps.filter((e) => e.transport === "grpc");
  const byPath = (p: string) => grpc.find((e) => e.path === p);

  it("extracts @GrpcMethod handlers with explicit service + method", () => {
    expect(byPath("/HeroesService/FindOne")).toBeDefined();
  });

  it("derives the method name from the handler when the arg is omitted", () => {
    // @GrpcMethod('HeroesService') on findAll() -> FindAll
    expect(byPath("/HeroesService/FindAll")).toBeDefined();
  });

  it("@GrpcStreamMethod is marked as streaming", () => {
    expect(byPath("/HeroesService/StreamHeroes")!.grpc!.streamingType).toBe(
      "bidi",
    );
  });

  it("keeps framework nestjs, transport grpc, kind api", () => {
    const e = byPath("/HeroesService/FindOne")!;
    expect(e.framework).toBe("nestjs");
    expect(e.transport).toBe("grpc");
    expect(e.kind).toBe("api");
  });
});

describe("proto wins over bare decorator paths at the mapper", () => {
  const dir = path.join(__dirname, "__fixtures__/nestjs-grpc-proto");
  const grpc = map(dir).endpoints.all.filter((e) => e.grpc);

  it("keeps the package-qualified proto endpoints", () => {
    expect(grpc.length).toBe(3);
    expect(grpc.every((e) => e.grpc!.serviceFqn === "hero.HeroesService")).toBe(
      true,
    );
  });

  it("drops the bare /HeroesService/* decorator duplicates", () => {
    expect(grpc.some((e) => e.path === "/hero.HeroesService/FindOne")).toBe(
      true,
    );
    expect(grpc.some((e) => e.path.startsWith("/HeroesService/"))).toBe(false);
  });
});
