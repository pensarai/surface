import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { map } from "../index.ts";

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
});
