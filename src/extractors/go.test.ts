import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { map } from "../index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "__fixtures__/go-gin");

describe("go (gin) extractor", () => {
  it("emits websocket kind for gorilla-upgraded handlers, api otherwise", () => {
    const result = map(FIXTURE_DIR, { frameworkOverride: "gin" });
    const endpoints = result.endpoints.all;

    expect(endpoints).toContainEqual(
      expect.objectContaining({ path: "/api/users", kind: "api" }),
    );
    expect(endpoints).toContainEqual(
      expect.objectContaining({ path: "/ws", kind: "websocket" }),
    );
  });
});
