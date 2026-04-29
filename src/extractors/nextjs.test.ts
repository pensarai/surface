import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { nextjs } from "./nextjs.ts";
import { createScanContext } from "../scan-context.ts";

const FIXTURE = resolve(import.meta.dir, "../../scripts/fixtures/nextjs-pages");

function extract(fixturePath: string = FIXTURE) {
  const ctx = createScanContext(fixturePath);
  return nextjs.extract(ctx);
}

describe("nextjs page route extraction", () => {
  const endpoints = extract();

  // ---- App Router pages ----

  test("extracts app router root page (/)", () => {
    const ep = endpoints.find(
      (e) => e.kind === "page" && e.path === "/" && e.file.includes("app/page"),
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
    expect(ep!.handler).toBe("Page");
    expect(ep!.framework).toBe("nextjs");
  });

  test("extracts app router /about page", () => {
    const ep = endpoints.find(
      (e) =>
        e.kind === "page" && e.path === "/about" && e.file.includes("app/"),
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
  });

  test("extracts app router dynamic [slug] page", () => {
    const ep = endpoints.find(
      (e) => e.kind === "page" && e.path === "/blog/[slug]",
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
    expect(ep!.params.length).toBeGreaterThan(0);
    expect(ep!.params[0]!.name).toBe("slug");
  });

  test("extracts app router nested page", () => {
    const ep = endpoints.find(
      (e) => e.kind === "page" && e.path === "/dashboard/settings",
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
  });

  test("excludes layout.tsx from app router pages", () => {
    const layouts = endpoints.filter(
      (e) => e.kind === "page" && e.file.includes("layout"),
    );
    expect(layouts).toHaveLength(0);
  });

  test("excludes loading.tsx from app router pages", () => {
    const loading = endpoints.filter(
      (e) => e.kind === "page" && e.file.includes("loading"),
    );
    expect(loading).toHaveLength(0);
  });

  test("excludes error.tsx from app router pages", () => {
    const errors = endpoints.filter(
      (e) => e.kind === "page" && e.file.includes("error"),
    );
    expect(errors).toHaveLength(0);
  });

  test("excludes not-found.tsx from app router pages", () => {
    const notFounds = endpoints.filter(
      (e) => e.kind === "page" && e.file.includes("not-found"),
    );
    expect(notFounds).toHaveLength(0);
  });

  test("excludes template.tsx from app router pages", () => {
    const templates = endpoints.filter(
      (e) => e.kind === "page" && e.file.includes("template"),
    );
    expect(templates).toHaveLength(0);
  });

  test("excludes default.tsx from app router pages", () => {
    const defaults = endpoints.filter(
      (e) => e.kind === "page" && e.file.includes("default"),
    );
    expect(defaults).toHaveLength(0);
  });

  // ---- App Router API routes still work ----

  test("still extracts app router API routes", () => {
    const ep = endpoints.find(
      (e) => e.kind === "api" && e.path === "/api/users",
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
    expect(ep!.handler).toBe("GET");
  });

  // ---- Pages Router pages ----

  test("extracts pages router root page (pages/index.tsx → /)", () => {
    const ep = endpoints.find(
      (e) =>
        e.kind === "page" && e.path === "/" && e.file.includes("pages/index"),
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
    expect(ep!.handler).toBe("Page");
  });

  test("extracts pages router /about (pages/about/index.tsx → /about)", () => {
    const ep = endpoints.find(
      (e) =>
        e.kind === "page" &&
        e.path === "/about" &&
        e.file.includes("pages/about"),
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
  });

  test("extracts pages router dynamic route (pages/blog/[slug].tsx → /blog/[slug])", () => {
    const ep = endpoints.find(
      (e) =>
        e.kind === "page" &&
        e.path === "/blog/[slug]" &&
        e.file.includes("pages/blog"),
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
    expect(ep!.params.length).toBeGreaterThan(0);
    expect(ep!.params[0]!.name).toBe("slug");
  });

  test("extracts pages router /products (pages/products/index.tsx → /products)", () => {
    const ep = endpoints.find(
      (e) =>
        e.kind === "page" &&
        e.path === "/products" &&
        e.file.includes("pages/products"),
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
  });

  test("excludes _app.tsx from pages router pages", () => {
    const apps = endpoints.filter(
      (e) => e.kind === "page" && e.file.includes("_app"),
    );
    expect(apps).toHaveLength(0);
  });

  test("excludes _document.tsx from pages router pages", () => {
    const docs = endpoints.filter(
      (e) => e.kind === "page" && e.file.includes("_document"),
    );
    expect(docs).toHaveLength(0);
  });

  test("does not emit pages/api/ files as pages (handled as API)", () => {
    const apiPages = endpoints.filter(
      (e) => e.kind === "page" && e.path.startsWith("/api"),
    );
    expect(apiPages).toHaveLength(0);
  });

  test("still extracts pages/api/ as API endpoints", () => {
    const ep = endpoints.find(
      (e) => e.kind === "api" && e.path === "/api/health",
    );
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("ANY");
    expect(ep!.handler).toBe("default");
  });

  // ---- Kind validation ----

  test("all page endpoints have kind=page", () => {
    const pages = endpoints.filter((e) => e.handler === "Page");
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      expect(p.kind).toBe("page");
    }
  });

  test("all page endpoints have method=GET", () => {
    const pages = endpoints.filter((e) => e.kind === "page");
    for (const p of pages) {
      expect(p.method).toBe("GET");
    }
  });
});
