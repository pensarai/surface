import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { map } from "../index.ts";

// See fastapi.test.ts for the canonical kind-detection test pattern.
//   1. Load fixture dir under src/extractors/__fixtures__/<framework>/
//   2. Call map() with frameworkOverride for isolation
//   3. Assert kinds via expect.objectContaining

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "__fixtures__/express");

describe("express extractor", () => {
  it("emits correct kinds for api, page, and websocket routes", () => {
    const result = map(FIXTURE_DIR, { frameworkOverride: "express" });
    const endpoints = result.endpoints.all;

    // Plain JSON route → api
    expect(endpoints).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: "/api/users",
        kind: "api",
      }),
    );

    // res.render(...) → page
    expect(endpoints).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: "/about",
        kind: "page",
      }),
    );

    // res.sendFile(...) → page
    expect(endpoints).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: "/file",
        kind: "page",
      }),
    );

    // express-ws → websocket
    expect(endpoints).toContainEqual(
      expect.objectContaining({
        method: "WS",
        path: "/chat",
        kind: "websocket",
      }),
    );
  });
});
