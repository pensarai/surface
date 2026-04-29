import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { map } from "../index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "__fixtures__/flask");

describe("flask extractor", () => {
  it("emits page kind for handlers using render_template, api otherwise", () => {
    const result = map(FIXTURE_DIR, { frameworkOverride: "flask" });
    const endpoints = result.endpoints.all;

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
  });
});
