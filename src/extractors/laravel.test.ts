import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { map } from "../index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "__fixtures__/laravel");

describe("laravel extractor", () => {
  it("emits page kind for web.php routes and api kind for api.php routes", () => {
    const result = map(FIXTURE_DIR, { frameworkOverride: "laravel" });
    const endpoints = result.endpoints.all;

    expect(endpoints).toContainEqual(
      expect.objectContaining({ path: "/about", kind: "page" }),
    );
    expect(endpoints).toContainEqual(
      expect.objectContaining({ path: "/api/users", kind: "api" }),
    );
  });
});
