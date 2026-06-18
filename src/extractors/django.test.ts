import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { django } from "./django.ts";
import { createScanContext } from "../scan-context.ts";

const FIXTURE = resolve(import.meta.dir, "../../scripts/fixtures/django-urls");

function extract(fixturePath: string = FIXTURE) {
  const ctx = createScanContext(fixturePath);
  return django.extract(ctx);
}

describe("django url extraction", () => {
  const endpoints = extract();
  const byPath = (p: string) => endpoints.find((e) => e.path === p);

  test("extracts routes declared with string-prefixed literals (r\"...\")", () => {
    // blog.urls is mounted under "blog/" via include(), so routes are prefixed.
    expect(byPath("/blog/posts")).toBeDefined();
    expect(byPath("/blog/posts/new")).toBeDefined();
  });

  test("extracts plain-quoted routes", () => {
    expect(byPath("/admin")).toBeDefined();
    expect(byPath("/blog/drafts")).toBeDefined();
  });

  test("extracts re_path() regex routes", () => {
    expect(endpoints.find((e) => e.handler === "post_detail")).toBeDefined();
  });

  test("applies include() prefix to mounted app routes", () => {
    // Unprefixed it would be "/posts"; the include mounts blog.urls at /blog.
    expect(byPath("/posts")).toBeUndefined();
    expect(byPath("/blog/posts")).toBeDefined();
  });

  test("extracts @api_view endpoints with their methods", () => {
    const feed = endpoints.filter((e) => e.handler === "feed");
    expect(feed.map((e) => e.method).sort()).toEqual(["GET", "POST"]);
  });

  test("captures every path()/re_path() route declared (recall guard)", () => {
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
