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
import { dirname, join, relative, resolve, sep } from "node:path";
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

/** A workspace glob as a RegExp: `*` is one path segment, `**` is any depth. */
function globToRegExp(glob) {
  const source = glob
    .replace(/^\.\//, "")
    .replace(/\/$/, "")
    .split("**")
    .map((part) =>
      part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`);
}

/** Whether the root manifest's `workspaces` field includes the directory `dir`. */
function inWorkspace(dir, patterns) {
  const included = patterns.filter((p) => !p.startsWith("!"));
  const excluded = patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => p.slice(1));
  const matches = (list) =>
    list.some((pattern) => globToRegExp(pattern).test(dir));
  return dir !== "." && matches(included) && !matches(excluded);
}

function workspacePatterns(manifests) {
  const declared = manifests.find((m) => m.path === "package.json")?.pkg
    .workspaces;
  return Array.isArray(declared) ? declared : (declared?.packages ?? []);
}

/**
 * Names of the packages the root manifest declares as workspace members. A
 * manifest elsewhere in the repository is a separate project, not a member.
 */
export function workspacePackageNames(manifests) {
  const patterns = workspacePatterns(manifests);
  const names = new Set();
  for (const { path, pkg } of manifests) {
    if (inWorkspace(dirname(path), patterns) && typeof pkg.name === "string")
      names.add(pkg.name);
  }
  return names;
}

/**
 * Every declared dependency that is not an exact version or a workspace link.
 * `manifests` is a list of `{ path, pkg }`.
 */
export function findUnpinned(manifests) {
  const patterns = workspacePatterns(manifests);
  const workspaceNames = workspacePackageNames(manifests);

  const violations = [];
  for (const { path, pkg } of manifests) {
    // Only the root and its members are installed together, so only they can use a workspace link.
    const inRootInstall =
      path === "package.json"
        ? patterns.length > 0
        : inWorkspace(dirname(path), patterns);
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
          inRootInstall &&
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

/** `save-exact=true`, so `npm install <pkg>` writes an exact version. npm uses the last top-level assignment. */
export function npmrcSavesExact(npmrc) {
  let value;
  let topLevel = true;
  for (const raw of npmrc.split("\n")) {
    const line = raw.split(/[#;]/)[0].trim();
    // npm reads only top-level keys; one under an INI section header is ignored.
    if (/^\[.*\]$/.test(line)) topLevel = false;
    const assignment = /^save-exact\s*=\s*(.*)$/.exec(line);
    if (assignment && topLevel) value = assignment[1].trim();
  }
  return value === "true";
}

function collectManifests(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      // Forward slashes on every platform, so the ignore list and reported paths match.
      const rel = relative(root, full).split(sep).join("/");
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

/**
 * Every project with a lockfile must tell its package manager to write exact
 * versions. `read(path)` returns a file's text, or undefined when it is missing.
 */
export function installConfigProblems(manifests, read) {
  const problems = [];
  for (const { path } of manifests) {
    const dir = dirname(path);
    const at = (name) => (dir === "." ? name : `${dir}/${name}`);
    if (read(at("bun.lock")) !== undefined) {
      const bunfig = read(at("bunfig.toml"));
      if (bunfig === undefined || !bunfigWritesExact(bunfig)) {
        problems.push(
          `${at("bunfig.toml")} must set \`exact = true\` under [install], or \`bun add\` writes ranges.`,
        );
      }
    }
    if (read(at("package-lock.json")) !== undefined) {
      const npmrc = read(at(".npmrc"));
      if (npmrc === undefined || !npmrcSavesExact(npmrc)) {
        problems.push(
          `${at(".npmrc")} must set \`save-exact=true\`, or \`npm install <pkg>\` writes ranges.`,
        );
      }
    }
  }
  return problems;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifests = collectManifests(root);
  const violations = findUnpinned(manifests);
  const problems = installConfigProblems(manifests, (path) =>
    existsSync(join(root, path))
      ? readFileSync(join(root, path), "utf8")
      : undefined,
  );

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
