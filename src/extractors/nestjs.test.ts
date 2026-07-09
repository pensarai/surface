import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { nestjs } from "./nestjs.ts";
import { createScanContext } from "../scan-context.ts";
import { map } from "../mapper.ts";

function extract(fixture: string) {
  const dir = resolve(import.meta.dir, "../../scripts/fixtures", fixture);
  return nestjs.extract(createScanContext(dir));
}

describe("nestjs code-first gRPC", () => {
  const eps = extract("nestjs-grpc");
  const grpc = eps.filter((e) => e.transport === "grpc");
  const byPath = (p: string) => grpc.find((e) => e.path === p);

  test("extracts @GrpcMethod handlers with explicit service + method", () => {
    expect(byPath("/HeroesService/FindOne")).toBeDefined();
  });

  test("derives the method name from the handler when the arg is omitted", () => {
    // @GrpcMethod('HeroesService') on findAll() -> FindAll
    expect(byPath("/HeroesService/FindAll")).toBeDefined();
  });

  test("@GrpcStreamMethod is marked as streaming", () => {
    expect(byPath("/HeroesService/StreamHeroes")!.grpc!.streamingType).toBe(
      "bidi",
    );
  });

  test("keeps framework nestjs, transport grpc", () => {
    const e = byPath("/HeroesService/FindOne")!;
    expect(e.framework).toBe("nestjs");
    expect(e.transport).toBe("grpc");
  });
});

describe("proto wins over bare decorator paths at the mapper", () => {
  const dir = resolve(
    import.meta.dir,
    "../../scripts/fixtures/nestjs-grpc-proto",
  );
  const grpc = map(dir).endpoints.all.filter((e) => e.grpc);

  test("keeps the package-qualified proto endpoints", () => {
    expect(grpc.length).toBe(3);
    expect(grpc.every((e) => e.grpc!.serviceFqn === "hero.HeroesService")).toBe(
      true,
    );
  });

  test("drops the bare /HeroesService/* decorator duplicates", () => {
    expect(grpc.some((e) => e.path === "/hero.HeroesService/FindOne")).toBe(
      true,
    );
    expect(grpc.some((e) => e.path.startsWith("/HeroesService/"))).toBe(false);
  });
});
