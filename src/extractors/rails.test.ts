import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { map } from "../index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "__fixtures__/rails");

describe("rails extractor", () => {
  it("emits page kind for ActionController::Base controllers and api kind for ActionController::API", () => {
    const result = map(FIXTURE_DIR, { frameworkOverride: "rails" });
    const endpoints = result.endpoints.all; // getter, no parens

    expect(endpoints).toContainEqual(
      expect.objectContaining({ path: "/about", kind: "page" }),
    );
    expect(endpoints).toContainEqual(
      expect.objectContaining({ path: "/api/users", kind: "api" }),
    );
  });
});
