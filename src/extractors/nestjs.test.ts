import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { nestjs } from "./nestjs.ts";
import { createScanContext } from "../scan-context.ts";

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

describe("nestjs gRPC defers to proto when one is present", () => {
  test("emits no decorator-derived gRPC endpoints when a .proto exists", () => {
    const grpc = extract("nestjs-grpc-proto").filter(
      (e) => e.transport === "grpc",
    );
    expect(grpc.length).toBe(0);
  });
});
