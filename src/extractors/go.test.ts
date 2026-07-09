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

  it("does not let a ws handler name in another package bleed across packages", () => {
    // internal/ws.go defines a `listUsers` that upgrades; the main package's
    // `/api/users` → listUsers is plain HTTP. Per-package scoping keeps it api.
    const result = map(FIXTURE_DIR, { frameworkOverride: "gin" });
    const users = result.endpoints.all.find((e) => e.path === "/api/users");
    expect(users?.kind).toBe("api");
    expect(users?.method).not.toBe("WS");
  });
});
