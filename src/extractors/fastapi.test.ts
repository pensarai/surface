import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { map } from "../index.ts";

// Pattern for kind-detection tests:
//   1. Load fixture dir under src/extractors/__fixtures__/<framework>/
//   2. Call map() against it (filter via frameworkOverride for isolation)
//   3. Assert endpoints contain expected shapes by kind using
//      expect.objectContaining so unrelated fields don't break the match.
//
// Other framework extractor tests should mirror this structure exactly.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "__fixtures__/fastapi");

describe("fastapi extractor", () => {
  it("emits correct kinds for api, page, and websocket routes", async () => {
    const result = map(FIXTURE_DIR, { frameworkOverride: "fastapi" });
    const endpoints = result.endpoints.all;

    expect(endpoints).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: "/health",
        kind: "api",
      }),
    );

    expect(endpoints).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: "/about",
        kind: "page",
      }),
    );

    expect(endpoints).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: "/dashboard",
        kind: "page",
      }),
    );

    expect(endpoints).toContainEqual(
      expect.objectContaining({
        method: "WS",
        path: "/ws",
        kind: "websocket",
      }),
    );
  });
});
