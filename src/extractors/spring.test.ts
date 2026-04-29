import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { map } from "../index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "__fixtures__/spring");

describe("spring extractor", () => {
  it("emits correct kinds for api, page, and websocket routes", () => {
    const result = map(FIXTURE_DIR, { frameworkOverride: "spring" });
    const endpoints = result.endpoints.all; // getter, NOT a method — no parens

    expect(endpoints).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: "/api/users",
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
      expect.objectContaining({ path: "/chat", kind: "websocket" }),
    );
  });
});
