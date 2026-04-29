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
const FIXTURE_DIR = path.join(__dirname, "__fixtures__/django");

describe("django extractor", () => {
  it("emits correct kinds for api, page, and websocket routes", () => {
    const result = map(FIXTURE_DIR, { frameworkOverride: "django" });
    const endpoints = result.endpoints.all;

    // CBV with TemplateView base → page
    expect(endpoints).toContainEqual(
      expect.objectContaining({
        kind: "page",
        handler: "HomeView",
      }),
    );

    // FBV body containing render() → page
    expect(endpoints).toContainEqual(
      expect.objectContaining({
        kind: "page",
        path: "/about",
        handler: "about_page",
      }),
    );

    // @api_view function → api (decorator-based, emitted at /<funcName>)
    expect(endpoints).toContainEqual(
      expect.objectContaining({
        kind: "api",
        path: "/health",
      }),
    );

    // Django Channels websocket_urlpatterns → websocket
    expect(endpoints).toContainEqual(
      expect.objectContaining({
        kind: "websocket",
        method: "WS",
        path: "/ws/chat",
        handler: "ChatConsumer",
      }),
    );
  });
});
