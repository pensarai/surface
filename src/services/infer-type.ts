import { readFileSync } from "fs";
import { join } from "path";
import type { ServiceType } from "../types.ts";

/**
 * Dep name → ServiceType mapping. Checked against package.json content.
 * Order matters: first match wins.
 */
const PKG_DEP_TO_TYPE: [string, ServiceType][] = [
  ["next", "nextjs"],
  ["express", "express"],
  ["@hono/node-server", "express"],
  ["hono", "express"],
  ["fastify", "express"],
  ["koa", "express"],
];

/**
 * Go module path → ServiceType. Checked against go.mod content.
 */
const GO_DEP_TO_TYPE: [string, ServiceType][] = [
  ["gin-gonic/gin", "generic"],
  ["labstack/echo", "generic"],
  ["gofiber/fiber", "generic"],
];

/**
 * Cargo crate → ServiceType. Checked against Cargo.toml content.
 */
const CARGO_DEP_TO_TYPE: [string, ServiceType][] = [
  ["actix-web", "generic"],
  ["axum", "generic"],
  ["rocket", "generic"],
];

/**
 * Python package → ServiceType. Checked against requirements.txt content.
 */
const PY_DEP_TO_TYPE: [string, ServiceType][] = [
  ["flask", "generic"],
  ["fastapi", "generic"],
  ["django", "generic"],
];

/**
 * Infer a ServiceType from the dependency manifests in a directory.
 *
 * Checks package.json, go.mod, Cargo.toml, and requirements.txt in priority order.
 * Falls back to "generic" if no known framework dep is found.
 *
 * This is the single canonical implementation — used by workspace,
 * compose, and directory detectors.
 */
export function inferServiceType(absDir: string): ServiceType {
  // Check package.json deps
  try {
    const content = readFileSync(join(absDir, "package.json"), "utf-8");
    const lower = content.toLowerCase();
    for (const [dep, type] of PKG_DEP_TO_TYPE) {
      if (lower.includes(`"${dep}"`)) return type;
    }
    return "generic";
  } catch {
    /* no package.json */
  }

  // Check go.mod deps
  try {
    const content = readFileSync(join(absDir, "go.mod"), "utf-8");
    for (const [dep, type] of GO_DEP_TO_TYPE) {
      if (content.includes(dep)) return type;
    }
    return "generic";
  } catch {
    /* no go.mod */
  }

  // Check Cargo.toml deps
  try {
    const content = readFileSync(join(absDir, "Cargo.toml"), "utf-8");
    for (const [dep, type] of CARGO_DEP_TO_TYPE) {
      if (content.includes(dep)) return type;
    }
    return "generic";
  } catch {
    /* no Cargo.toml */
  }

  // Check Python deps
  try {
    const content = readFileSync(join(absDir, "requirements.txt"), "utf-8");
    for (const [dep, type] of PY_DEP_TO_TYPE) {
      if (content.includes(dep)) return type;
    }
    return "generic";
  } catch {
    /* no requirements.txt */
  }

  return "generic";
}

/**
 * Strip npm org scope from a package name for display.
 * "@pensar/console" → "console", "express" → "express"
 */
export function stripOrgScope(name: string): string {
  if (name.startsWith("@") && name.includes("/")) {
    return name.split("/").pop()!;
  }
  return name;
}
