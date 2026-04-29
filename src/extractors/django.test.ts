import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { map } from "../index.ts";
import { django } from "./django.ts";
import { createScanContext } from "../scan-context.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "__fixtures__/django");
const URLS_FIXTURE = path.resolve(__dirname, "../../scripts/fixtures/django-urls");

function extractUrls(fixturePath: string = URLS_FIXTURE) {
  const ctx = createScanContext(fixturePath);
  return django.extract(ctx);
}

describe("django url extraction", () => {
  const endpoints = extractUrls();
  const byPath = (p: string) => endpoints.find((e) => e.path === p);

  it('extracts routes declared with string-prefixed literals (r"...")', () => {
    // blog.urls is mounted under "blog/" via include(), so routes are prefixed.
    expect(byPath("/blog/posts")).toBeDefined();
    expect(byPath("/blog/posts/new")).toBeDefined();
  });

  it("extracts plain-quoted routes", () => {
    expect(byPath("/admin")).toBeDefined();
    expect(byPath("/blog/drafts")).toBeDefined();
  });

  it("extracts re_path() regex routes", () => {
    expect(endpoints.find((e) => e.handler === "post_detail")).toBeDefined();
  });

  it("applies include() prefix to mounted app routes", () => {
    // Unprefixed it would be "/posts"; the include mounts blog.urls at /blog.
    expect(byPath("/posts")).toBeUndefined();
    expect(byPath("/blog/posts")).toBeDefined();
  });

  it("extracts @api_view endpoints with their methods", () => {
    const feed = endpoints.filter((e) => e.handler === "feed");
    expect(feed.map((e) => e.method).sort()).toEqual(["GET", "POST"]);
  });

  it("captures every path()/re_path() route declared (recall guard)", () => {
    for (const p of [
      "/admin",
      "/blog/posts",
      "/blog/posts/new",
      "/blog/drafts",
    ]) {
      expect(byPath(p)).toBeDefined();
    }
  });
});

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
