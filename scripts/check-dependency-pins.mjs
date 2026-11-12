#!/usr/bin/env node
/**
 * Fails when a manifest declares a dependency by anything other than an exact
 * version, so every version change is an explicit, reviewable diff.
 *
 * A range such as `^1.2.3` lets an install or a regenerated lockfile pull a
 * release nobody chose. The lockfile pins what CI installs; this pins what the
 * manifest asks for.
 *
 * Accepted:
 *   - an exact version: `1.2.3`, `1.2.3-beta.1`
 *   - `workspace:*`, required for this repository's own workspace packages.
 *     `*` would also match a package of the same name on the public registry.
 *   - an alias to an exact version: `npm:typescript@7.0.2`
 *
 * Checked sections: `dependencies`, `devDependencies`, `optionalDependencies`
 * and `overrides`. `peerDependencies` are ranges by design and are not checked.
 *
 * Run: node scripts/check-dependency-pins.mjs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "overrides",
];

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const ALIAS = /^npm:(@[^/@]+\/)?[^/@]+@(.+)$/;

/** Directories whose manifests are not this repository's dependencies. */
const IGNORED_DIRS = ["scripts/fixtures", "src/extractors/__fixtures__"];

function isExact(spec) {
  if (EXACT.test(spec)) return true;
  const alias = ALIAS.exec(spec);
  return alias !== null && EXACT.test(alias[2]);
}

/**
 * Every declared dependency that is not an exact version or a workspace link.
 * `manifests` is a list of `{ path, pkg }`.
 */
export function findUnpinned(manifests) {
  const workspaceNames = new Set();
  for (const { pkg } of manifests) {
    if (typeof pkg.name === "string") workspaceNames.add(pkg.name);
  }

  const violations = [];
  for (const { path, pkg } of manifests) {
    for (const section of SECTIONS) {
      const entries = pkg[section];
      if (entries === undefined) continue;
      if (typeof entries !== "object" || entries === null) {
        throw new Error(`${path}: "${section}" is not an object`);
      }
      for (const [name, spec] of Object.entries(entries)) {
        if (typeof spec !== "string") {
          // A nested override cannot be verified here, so it is rejected rather than skipped.
          violations.push({
            path,
            section,
            name,
            spec: JSON.stringify(spec),
            fix: 'use a flat `"name": "<exact version>"` entry',
          });
          continue;
        }
        const internal =
          section !== "overrides" &&
          workspaceNames.has(name) &&
          name !== pkg.name;
        if (internal) {
          if (spec !== "workspace:*") {
            violations.push({
              path,
              section,
              name,
              spec,
              fix: "use `workspace:*`",
            });
          }
          continue;
        }
        if (!isExact(spec)) {
          violations.push({
            path,
            section,
            name,
            spec,
            fix: "use the exact version from the lockfile",
          });
        }
      }
    }
  }
  return violations.sort(
    (a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name),
  );
}

/** `exact = true` under `[install]`, so `bun add` writes an exact version. */
export function bunfigWritesExact(bunfig) {
  let section = "";
  for (const raw of bunfig.split("\n")) {
    const line = raw.split("#")[0].trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) section = header[1].trim();
    else if (section === "install" && /^exact\s*=\s*true$/.test(line))
      return true;
  }
  return false;
}

/** `save-exact=true`, so `npm install <pkg>` writes an exact version. */
export function npmrcSavesExact(npmrc) {
  return npmrc
    .split("\n")
    .some((raw) => /^save-exact\s*=\s*true$/.test(raw.split(/[#;]/)[0].trim()));
}

function collectManifests(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        if (
          IGNORED_DIRS.some(
            (ignored) => rel === ignored || rel.startsWith(`${ignored}/`),
          )
        )
          continue;
        walk(full);
      } else if (entry.name === "package.json") {
        out.push({ path: rel, pkg: JSON.parse(readFileSync(full, "utf8")) });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifests = collectManifests(root);
  const violations = findUnpinned(manifests);

  const problems = [];
  if (existsSync(join(root, "bun.lock"))) {
    const bunfig = join(root, "bunfig.toml");
    if (
      !existsSync(bunfig) ||
      !bunfigWritesExact(readFileSync(bunfig, "utf8"))
    ) {
      problems.push(
        "bunfig.toml must set `exact = true` under [install], or `bun add` writes ranges.",
      );
    }
  }
  if (existsSync(join(root, "package-lock.json"))) {
    const npmrc = join(root, ".npmrc");
    if (!existsSync(npmrc) || !npmrcSavesExact(readFileSync(npmrc, "utf8"))) {
      problems.push(
        ".npmrc must set `save-exact=true`, or `npm install <pkg>` writes ranges.",
      );
    }
  }

  if (violations.length === 0 && problems.length === 0) {
    console.log(
      `check-dependency-pins: OK — ${manifests.length} manifest(s) declare exact versions.`,
    );
    return;
  }

  if (violations.length > 0) {
    console.error(
      `check-dependency-pins: ${violations.length} dependency(ies) are not pinned to an exact version:\n`,
    );
    for (const v of violations) {
      console.error(
        `  - ${v.path} ${v.section}.${v.name}: "${v.spec}" — ${v.fix}`,
      );
    }
    console.error(
      "\nA range lets an install pull a release nobody reviewed. Declare the exact version and" +
        "\nreinstall so the lockfile matches.",
    );
  }
  for (const problem of problems)
    console.error(`check-dependency-pins: ${problem}`);
  process.exit(1);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
