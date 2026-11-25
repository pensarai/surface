#!/usr/bin/env node
/**
 * Fails a PR that introduces a dependency with a critical or high advisory, or
 * any malware advisory, in any of the repository's lockfiles, or whose
 * lockfile holds a registry package osv-scanner did not read.
 *
 * Every gated lockfile, from the head checkout and the merge base's copy, is
 * scanned offline in one `osv-scanner` run, under the same exceptions and
 * advisory database. An advisory is introduced when none of its ids or
 * aliases is on that package in the base scan, so moving to a less vulnerable
 * version passes, and an advisory published against an unchanged package is
 * reported without blocking the PR that happened to run. A lockfile the PR
 * adds has no base, so all of its advisories are introduced.
 *
 * The gate also reads each lockfile itself and fails when a registry package
 * in the head copy is missing from osv-scanner's result, since a package the
 * scanner never read is never matched against an advisory. A package hidden by
 * a `[[PackageOverrides]]` entry with `ignore = true` is excepted. A shortfall
 * in the base copy is a warning only.
 *
 * Severity is the OSV CVSS score: 9.0 and up is critical, 7.0 and up is high.
 * An introduced advisory with no score is a warning. Existing advisories and
 * the licenses of added packages (from the npm registry, so the dependency
 * list never goes to OSV or deps.dev) are reported only.
 *
 * Exceptions are `[[IgnoredVulns]]` entries in `osv-scanner.toml`, each with a
 * `reason`.
 *
 * Usage: node scripts/osv-gate.mjs [--lockfile <lockfile>]... [--base <ref>].
 * The lockfile defaults to bun.lock; repeat the flag to gate several. The base
 * defaults to the remote default branch.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function severityOf(maxSeverity) {
  const score = maxSeverity ? Number(maxSeverity) : NaN;
  if (!Number.isFinite(score)) return { severity: "unscored", score: null };
  if (score >= 9) return { severity: "critical", score };
  if (score >= 7) return { severity: "high", score };
  if (score >= 4) return { severity: "medium", score };
  return { severity: "low", score };
}

const packagesOf = (scan) =>
  (scan.results ?? []).flatMap((r) => r.packages ?? []);

export function findingsFromScan(scan) {
  const findings = [];
  for (const p of packagesOf(scan)) {
    const vulns = new Map((p.vulnerabilities ?? []).map((v) => [v.id, v]));
    for (const group of p.groups ?? []) {
      const id = group.ids[0];
      if (!id)
        throw new Error(`osv-scanner group without an id on ${p.package.name}`);
      const vuln = vulns.get(id);
      const ids = [...group.ids, ...(group.aliases ?? [])];
      findings.push({
        id,
        aliases: ids,
        pkg: p.package.name,
        version: p.package.version,
        ...severityOf(group.max_severity),
        malware: ids.some((i) => i.startsWith("MAL-")),
        // An advisory can cover several packages; only this package's entries say whether it has a fix.
        // Every record in the group is the same advisory; any of them may list
        // the fix, but only for this package's entries.
        fixAvailable: group.ids
          .flatMap((gid) => vulns.get(gid)?.affected ?? [])
          .filter(
            (a) =>
              a.package?.name === p.package.name &&
              (!a.package.ecosystem ||
                a.package.ecosystem === p.package.ecosystem),
          )
          .some((a) =>
            (a.ranges ?? []).some((r) =>
              (r.events ?? []).some((e) => "fixed" in e),
            ),
          ),
        summary: vuln?.summary ?? "",
      });
    }
  }
  return findings;
}

export const packageVersions = (scan) =>
  new Set(
    packagesOf(scan).map((p) => `${p.package.name}@${p.package.version}`),
  );

const isBlocking = (f) =>
  f.malware || f.severity === "critical" || f.severity === "high";

export function compareScans(base, head) {
  // Two findings are the same advisory on the same package when any id or
  // alias matches: osv-scanner's group ids are only sorted, so the first id can
  // change between scans when the duplicate records that apply change.
  const same = (a, b) =>
    a.pkg === b.pkg && a.aliases.some((x) => b.aliases.includes(x));
  const baseFindings = findingsFromScan(base);
  const headFindings = findingsFromScan(head);
  const existing = [];
  const introduced = [];
  for (const h of headFindings) {
    const baseVersions = new Set(
      baseFindings.filter((b) => same(b, h)).map((b) => b.version),
    );
    if (baseVersions.has(h.version)) {
      existing.push(h);
      continue;
    }
    // A version that did not have this advisory at the base replaces one the
    // PR removed, so a straight upgrade passes. Affected versions beyond the
    // ones removed are introduced.
    const headVersions = new Set(
      headFindings.filter((x) => same(x, h)).map((x) => x.version),
    );
    const removed = [...baseVersions].filter((v) => !headVersions.has(v));
    const added = [...headVersions].filter((v) => !baseVersions.has(v)).sort();
    (added.indexOf(h.version) < removed.length ? existing : introduced).push(h);
  }
  const basePackages = packageVersions(base);
  return {
    introduced,
    existing,
    blocking: introduced.filter(isBlocking),
    warnings: introduced.filter(
      (f) => !isBlocking(f) && f.severity === "unscored",
    ),
    addedPackages: [...packageVersions(head)]
      .filter((p) => !basePackages.has(p))
      .sort(),
  };
}

/** The line without its comment; a `#` inside a quoted string is kept. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function parseValue(raw, where) {
  if (raw.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
    if (!m) throw new Error(`${where}: cannot read the string ${raw}`);
    return JSON.parse(`"${m[1]}"`);
  }
  if (raw.startsWith("'")) {
    const m = /^'([^']*)'$/.exec(raw);
    if (!m) throw new Error(`${where}: cannot read the string ${raw}`);
    return m[1];
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Dates, numbers, and one-line arrays or inline tables are kept as text.
  return raw;
}

/**
 * The tables of osv-scanner.toml that can hide a finding. The file is held to
 * an allowlist so the gate reads it exactly as osv-scanner does: comments,
 * [[IgnoredVulns]] and [[PackageOverrides]] tables, and one-line `key = value`
 * entries inside them. Anything else (a top-level key, another table, an
 * inline table, a multi-line value, a line it cannot read) is an error, never
 * skipped, so an exception cannot slip past the reason check.
 */
export function parseOsvConfig(toml) {
  const config = { IgnoredVulns: [], PackageOverrides: [] };
  let current = null;
  toml.split("\n").forEach((raw, n) => {
    const line = stripComment(raw).trim();
    if (!line) return;
    const where = `osv-scanner.toml line ${n + 1}`;
    const header = /^\[\[\s*([A-Za-z]+)\s*\]\]$/.exec(line);
    if (header) {
      // osv-scanner matches table and key names case-insensitively, so the gate does too.
      const table = Object.keys(config).find(
        (name) => name.toLowerCase() === header[1].toLowerCase(),
      );
      if (!table)
        throw new Error(
          `${where}: the gate does not check [[${header[1]}]] tables`,
        );
      current = {};
      config[table].push(current);
      return;
    }
    if (line.startsWith("["))
      throw new Error(
        `${where}: the gate cannot check "${line}"; use [[IgnoredVulns]] or [[PackageOverrides]] with one-line keys`,
      );
    const kv = /^([A-Za-z][\w.-]*)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`${where}: cannot read "${line}"`);
    const [, key, value] = kv;
    if (value.startsWith('"""') || value.startsWith("'''"))
      throw new Error(`${where}: the gate cannot check multi-line strings`);
    // A top-level key can hold the same exceptions as an array of inline
    // tables (IgnoredVulns = [{ ... }]), so none is allowed.
    if (!current)
      throw new Error(
        `${where}: the gate allows no top-level settings; put exceptions in [[IgnoredVulns]] or [[PackageOverrides]] tables`,
      );
    // An inline table can spell an ignore many ways ({ "ignore" = true }, ...);
    // dotted keys can only spell it one way, which the gate checks exactly.
    if (value.startsWith("{"))
      throw new Error(
        `${where}: write dotted keys (vulnerability.ignore = true), not inline tables`,
      );
    // osv-scanner reads keys case-insensitively, so Ignore and ignore are one
    // key set twice; which value it keeps is not the gate's to guess.
    const name = key.toLowerCase();
    if (Object.hasOwn(current, name))
      throw new Error(`${where}: ${key} is already set in this entry`);
    current[name] = parseValue(value, where);
  });
  return config;
}

/** A package override hides findings when any of its keys ignores the package or its vulnerabilities. */
function overrideHides(override) {
  // license.ignore only skips license checks; vulnerabilities are still reported.
  return override.ignore === true || override["vulnerability.ignore"] === true;
}

const hasReason = (entry) =>
  typeof entry.reason === "string" && entry.reason.trim() !== "";

/**
 * Every way osv-scanner.toml can hide a finding needs a reason: an ignored
 * advisory must also name it, and a package override that ignores the package
 * or its vulnerabilities is held to the same rule.
 */
export function invalidExceptions(config) {
  const ignored = config.IgnoredVulns.flatMap((e, i) => {
    const problems = [];
    if (typeof e.id !== "string" || !e.id)
      problems.push(`entry ${i + 1} has no id`);
    if (!hasReason(e))
      problems.push(
        `${typeof e.id === "string" ? e.id : `entry ${i + 1}`} has no reason`,
      );
    return problems;
  });
  const overrides = config.PackageOverrides.flatMap((o, i) =>
    overrideHides(o) && !hasReason(o)
      ? [
          `${typeof o.name === "string" ? o.name : `override ${i + 1}`} ignores vulnerabilities without a reason`,
        ]
      : [],
  );
  return [...ignored, ...overrides];
}

const SEVERITY_ORDER = ["critical", "high", "unscored", "medium", "low"];

function findingRows(findings) {
  return [...findings]
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    )
    .map(
      (f) =>
        `| ${f.malware ? "malware" : f.severity}${f.score === null ? "" : ` (${f.score})`} | \`${f.pkg}@${f.version}\` | ${f.id} | ${f.fixAvailable ? "yes" : "no"} | ${f.summary.replace(/\|/g, "\\|")} |`,
    );
}

function counts(findings) {
  const by = new Map();
  for (const f of findings) {
    const key = f.malware ? "malware" : f.severity;
    by.set(key, (by.get(key) ?? new Set()).add(`${f.pkg}\0${f.id}`));
  }
  const parts = ["malware", ...SEVERITY_ORDER]
    .filter((s) => by.has(s))
    .map((s) => `${by.get(s).size} ${s}`);
  return parts.length ? parts.join(", ") : "none";
}

const MAX_LISTED = 20;

function packageList(packages) {
  const listed = packages.slice(0, MAX_LISTED).map((p) => `\`${p}\``);
  if (packages.length > MAX_LISTED)
    listed.push(`and ${packages.length - MAX_LISTED} more`);
  return listed.join(", ");
}

/**
 * What osv-scanner read of the lockfile. `coverage.head` and `coverage.base`
 * come from `unreadPackages`; `base` is null for a lockfile the PR adds.
 */
function coverageLines(coverage, lockfile) {
  const { head, base } = coverage;
  const lines = [];
  if (head.missing.length) {
    lines.push(
      `**Blocked:** osv-scanner did not read ${head.missing.length} of the ${head.total} registry packages locked in \`${lockfile}\`, so they were never checked for advisories: ${packageList(head.missing)}. Check that the lockfile is one the package manager wrote, and the osv-scanner version.`,
    );
  } else {
    const hidden = head.hidden.length
      ? `, apart from ${head.hidden.length} that \`[[PackageOverrides]]\` entries hide with \`ignore = true\``
      : "";
    lines.push(
      `osv-scanner read all ${head.total} registry packages locked in \`${lockfile}\`${hidden}.`,
    );
  }
  if (head.other)
    lines.push(
      `${head.other} workspace, link, file or Git entries are not counted.`,
    );
  if (base === null)
    lines.push(
      `\`${lockfile}\` is new in this PR, so every advisory in it counts as introduced.`,
    );
  else if (base.missing.length)
    lines.push(
      `**Warning:** osv-scanner did not read ${base.missing.length} of the ${base.total} registry packages in the merge base's \`${lockfile}\`: ${packageList(base.missing)}. Advisories already on them may show as introduced by this PR.`,
    );
  return [lines.join(" "), ""];
}

export function renderSummary(result, licenses, lockfile, coverage) {
  const header =
    "| Severity | Package | Advisory | Fix | Summary |\n| --- | --- | --- | --- | --- |";
  const lines = [
    `## Vulnerable dependencies in \`${lockfile}\``,
    "",
    ...coverageLines(coverage, lockfile),
  ];
  if (result.blocking.length) {
    lines.push(
      `**Blocked:** this PR introduces ${result.blocking.length} critical, high or malware advisories in \`${lockfile}\`. Upgrade or remove the package, or add an \`[[IgnoredVulns]]\` entry with a \`reason\` to \`osv-scanner.toml\`.`,
      "",
      header,
      ...findingRows(result.blocking),
      "",
    );
  } else {
    lines.push(
      `No critical, high or malware advisories introduced in \`${lockfile}\`.`,
      "",
    );
  }
  const other = result.introduced.filter((f) => !result.blocking.includes(f));
  if (other.length)
    lines.push(
      "### Other introduced advisories",
      "",
      header,
      ...findingRows(other),
      "",
    );
  lines.push(
    "### Already in the lockfile",
    "",
    `Not blocking: ${counts(result.existing)}.`,
    "",
  );
  const existingSevere = result.existing.filter(isBlocking);
  if (existingSevere.length) {
    lines.push(
      "<details><summary>Critical and high</summary>",
      "",
      header,
      ...findingRows(existingSevere),
      "",
      "</details>",
      "",
    );
  }
  if (result.addedPackages.length) {
    lines.push(
      `### Added packages (${result.addedPackages.length})`,
      "",
      "| Package | License |",
      "| --- | --- |",
      ...result.addedPackages.map(
        (p) => `| \`${p}\` | ${licenses.get(p) ?? "not looked up"} |`,
      ),
      "",
    );
  }
  return lines.join("\n");
}

const MAX_LICENSE_LOOKUPS = 200;

export async function lookupLicenses(
  packages,
  fetcher = fetch,
  timeoutMs = 10_000,
) {
  const licenses = new Map();
  const queue = packages.slice(0, MAX_LICENSE_LOOKUPS);
  const worker = async () => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
      const at = p.lastIndexOf("@");
      const name = p.slice(0, at);
      const version = p.slice(at + 1);
      const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`;
      try {
        // A stalled registry must not hold up the verdict; the body read shares the deadline.
        const res = await fetcher(url, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          licenses.set(p, `unknown (registry ${res.status})`);
          continue;
        }
        const meta = await res.json();
        const license =
          typeof meta.license === "string" ? meta.license : meta.license?.type;
        licenses.set(p, license || "none declared");
      } catch {
        // Report-only: a registry failure leaves the license unknown and the gate unchanged.
        licenses.set(p, "unknown (registry unreachable)");
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return licenses;
}

export function parseArgs(argv) {
  const opts = { lockfiles: [], base: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--lockfile", "--base"].includes(flag))
      throw new Error(`Unknown argument ${flag}`);
    if (!value || value.startsWith("--"))
      throw new Error(`${flag} needs a value`);
    if (flag === "--lockfile") {
      if (opts.lockfiles.includes(value))
        throw new Error(`${value} is given twice`);
      opts.lockfiles.push(value);
    } else opts.base = value;
    i++;
  }
  if (!opts.lockfiles.length) opts.lockfiles.push("bun.lock");
  return opts;
}

function git(args) {
  const res = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

/** The trunk as the remote names it, never hardcoded. */
function defaultBranchRef() {
  const res = spawnSync(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { encoding: "utf8" },
  );
  if (res.status !== 0)
    throw new Error(
      "Cannot tell the default branch: origin/HEAD is not set. Run `git remote set-head origin --auto`, or pass --base <ref>.",
    );
  return res.stdout.trim();
}

function scan(lockfiles, config) {
  const args = [
    "scan",
    "source",
    // Full offline mode: only the advisory database download below touches the
    // network; no other scanner feature can send the dependency list anywhere.
    "--offline",
    "--download-offline-databases",
    "--all-packages",
    "--format",
    "json",
    ...lockfiles.flatMap((l) => ["-L", l]),
    ...(config ? ["--config", config] : []),
  ];
  const res = spawnSync("osv-scanner", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error)
    throw new Error(`osv-scanner could not run: ${res.error.message}`);
  // 0: nothing found, 1: vulnerabilities found. Anything else is a failed scan.
  if (res.status !== 0 && res.status !== 1)
    throw new Error(
      `osv-scanner failed on ${lockfiles.join(", ")} (exit ${res.status}): ${res.stderr}`,
    );
  return JSON.parse(res.stdout);
}

/**
 * Splits one osv-scanner result into a scan per lockfile, by the path it
 * reports for each source. A result for any other path fails the gate, and so
 * does a lockfile with no packages in the result: osv-scanner returns none when
 * exceptions hide every package, which would switch the gate off, or when the
 * lockfile has no packages at all.
 */
export function splitBySource(scanned, lockfiles, platform = process.platform) {
  // osv-scanner reports Windows paths with forward slashes; Node returns them with backslashes.
  const key = (path) =>
    platform === "win32" ? path?.replaceAll("\\", "/") : path;
  const scans = new Map(lockfiles.map((l) => [key(l), { results: [] }]));
  for (const r of scanned.results ?? []) {
    const own = scans.get(key(r.source?.path));
    if (!own)
      throw new Error(
        `osv-scanner reported ${r.source?.path}, which is not a scanned lockfile`,
      );
    own.results.push(r);
  }
  for (const lockfile of lockfiles)
    if (!packagesOf(scans.get(key(lockfile))).length)
      throw new Error(
        `osv-scanner returned no packages for ${lockfile}: exceptions hide every package, or it has none`,
      );
  return lockfiles.map((l) => scans.get(key(l)));
}

/**
 * Scans every gated lockfile and its merge-base copy in one run, then compares
 * each pair. `pairs` is `[{ base, head }]`; `base` is null for a lockfile the
 * PR adds, which is compared against an empty scan, so every advisory in it is
 * introduced. Returns `[{ base, head, result }]` with the split scans.
 */
export function scanAndCompare(pairs, config, scanner = scan) {
  // One osv-scanner run matches every lockfile against one download of the
  // advisory database, so an advisory published mid-gate cannot look
  // introduced, and it loads every ecosystem any lockfile has, so one only
  // the head has (a first Git dependency) does not fail the scan. All honor
  // the exceptions: a finding hidden only on the head would read as a version
  // the PR removed, and let a new affected version replace it.
  const lockfiles = pairs.flatMap((p) =>
    p.base ? [p.base, p.head] : [p.head],
  );
  const scans = splitBySource(scanner(lockfiles, config), lockfiles);
  return pairs.map((p) => {
    const base = p.base ? scans.shift() : { results: [] };
    const head = scans.shift();
    return { base, head, result: compareScans(base, head) };
  });
}

/**
 * bun.lock is JSON that allows trailing commas. Drops each comma that only
 * precedes a closing bracket, outside strings, then parses it as JSON.
 */
export function parseJsonWithTrailingCommas(text) {
  const out = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        out.push(c, text[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === ",") {
      let j = i + 1;
      while (j < text.length && " \t\r\n".includes(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out.push(c);
  }
  return JSON.parse(out.join(""));
}

// A version a registry package can have. Anything else in a lockfile entry is
// a workspace, link, file, Git or tarball dependency, which osv-scanner reports
// under another name or with no version, or an entry the gate cannot read.
const REGISTRY_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const BUN_NOT_REGISTRY =
  /^(?:workspace:|link:|file:|root:|git\+|git:|github:|https?:)/;
const NPM_NOT_REGISTRY = /^(?:git\+|git:|github:|file:)/;

/**
 * The registry packages a lockfile holds, as `name@version`, read without
 * osv-scanner so the gate can check what the scanner read. Each name and
 * version is counted once, as osv-scanner lists it, however many places it
 * is installed. Other entries are counted in `other` and not checked. An entry
 * the gate cannot read fails the gate.
 *
 * - bun.lock: each `packages` entry is an array whose first item is the
 *   resolved `name@version`. An npm alias already resolves to the real name.
 * - package-lock.json: each `packages` key is an install path. The root `""`,
 *   links, and workspace or out-of-tree targets (keys without `node_modules/`)
 *   are not registry packages; the name is the entry's `name` (an alias) or
 *   the path after the last `node_modules/`.
 */
export function lockedPackages(path, text) {
  const isBun = basename(path) === "bun.lock";
  if (!isBun && basename(path) !== "package-lock.json")
    throw new Error(
      `${path}: the gate reads bun.lock and package-lock.json only`,
    );
  const lock = isBun ? parseJsonWithTrailingCommas(text) : JSON.parse(text);
  if (
    !lock ||
    typeof lock.packages !== "object" ||
    lock.packages === null ||
    Array.isArray(lock.packages)
  )
    throw new Error(`${path} has no packages map the gate can read`);
  const registry = new Set();
  let other = 0;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (isBun) {
      const id = Array.isArray(entry) ? entry[0] : undefined;
      const at = typeof id === "string" ? id.indexOf("@", 1) : -1;
      if (at < 1)
        throw new Error(`${path}: cannot read the package entry "${key}"`);
      const version = id.slice(at + 1);
      if (REGISTRY_VERSION.test(version)) registry.add(id);
      else if (BUN_NOT_REGISTRY.test(version)) other++;
      else
        throw new Error(`${path}: cannot read the version of "${key}" (${id})`);
      continue;
    }
    if (key === "") continue;
    if (!entry || typeof entry !== "object")
      throw new Error(`${path}: cannot read the package entry "${key}"`);
    const at = key.lastIndexOf("node_modules/");
    if (
      entry.link === true ||
      at === -1 ||
      (typeof entry.resolved === "string" &&
        NPM_NOT_REGISTRY.test(entry.resolved))
    ) {
      other++;
      continue;
    }
    const name =
      typeof entry.name === "string"
        ? entry.name
        : key.slice(at + "node_modules/".length);
    if (
      typeof entry.version !== "string" ||
      !REGISTRY_VERSION.test(entry.version)
    )
      throw new Error(
        `${path}: cannot read the version of "${key}" (${entry.version})`,
      );
    registry.add(`${name}@${entry.version}`);
  }
  return { registry, other };
}

/**
 * Locked registry packages missing from osv-scanner's result for that
 * lockfile. A package the scanner never read was never matched against an
 * advisory, so its advisories cannot block. Packages a `[[PackageOverrides]]`
 * entry hides with `ignore = true` are left out of the scan on purpose and
 * are returned as `hidden` instead; the gate already requires their reason.
 */
export function unreadPackages(locked, scan, overrides) {
  const read = packageVersions(scan);
  const missing = [];
  const hidden = [];
  for (const p of [...locked.registry].sort()) {
    if (read.has(p)) continue;
    const at = p.lastIndexOf("@");
    const name = p.slice(0, at);
    const version = p.slice(at + 1);
    const ignored = overrides.some(
      (o) =>
        o.ignore === true &&
        o.name === name &&
        (o.version === undefined || o.version === version) &&
        (o.ecosystem === undefined ||
          String(o.ecosystem).toLowerCase() === "npm"),
    );
    (ignored ? hidden : missing).push(p);
  }
  return { total: locked.registry.size, other: locked.other, missing, hidden };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseRef = opts.base ?? defaultBranchRef();
  process.chdir(git(["rev-parse", "--show-toplevel"]).trim());

  const config = resolve("osv-scanner.toml");
  let problems;
  let overrides;
  try {
    const parsed = parseOsvConfig(readFileSync(config, "utf8"));
    problems = invalidExceptions(parsed);
    overrides = parsed.PackageOverrides;
  } catch (err) {
    // A config the gate cannot read is a failed gate, reported where it points.
    console.log(`::error file=osv-scanner.toml::${err.message}`);
    process.exit(1);
  }
  if (problems.length) {
    for (const p of problems)
      console.log(`::error file=osv-scanner.toml::Exception ${p}`);
    process.exit(1);
  }

  const mergeBase = git(["merge-base", baseRef, "HEAD"]).trim();
  const baseDir = mkdtempSync(join(tmpdir(), "osv-gate-base-"));
  let gated;
  try {
    const pairs = opts.lockfiles.map((lockfile, i) => {
      const headText = readFileSync(lockfile, "utf8");
      const baseText = gitFileAt(mergeBase, lockfile);
      let base = null;
      if (baseText !== null) {
        // Same file name as the head lockfile, which is how osv-scanner picks its parser.
        mkdirSync(join(baseDir, String(i)));
        base = join(baseDir, String(i), basename(lockfile));
        writeFileSync(base, baseText);
        // Real paths, as osv-scanner names each source in its results.
        base = realpathSync(base);
      }
      return {
        lockfile,
        headText,
        baseText,
        base,
        head: realpathSync(lockfile),
      };
    });
    gated = scanAndCompare(pairs, config).map((scanned, i) => {
      const { lockfile, headText, baseText } = pairs[i];
      const coverage = {
        head: unreadPackages(
          lockedPackages(lockfile, headText),
          scanned.head,
          overrides,
        ),
        base:
          baseText === null
            ? null
            : unreadPackages(
                lockedPackages(lockfile, baseText),
                scanned.base,
                overrides,
              ),
      };
      return { lockfile, result: scanned.result, coverage };
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }

  const licenses = await lookupLicenses([
    ...new Set(gated.flatMap((g) => g.result.addedPackages)),
  ]);

  let failed = false;
  for (const { lockfile, result, coverage } of gated) {
    const summary = renderSummary(result, licenses, lockfile, coverage);
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    for (const f of result.blocking)
      console.log(
        `::error file=${lockfile},title=Vulnerable dependency::${f.pkg}@${f.version} ${f.id} (${f.malware ? "malware" : f.severity})`,
      );
    for (const f of result.warnings)
      console.log(
        `::warning file=${lockfile},title=Unscored advisory::${f.pkg}@${f.version} ${f.id}`,
      );
    if (coverage.head.missing.length)
      console.log(
        `::error file=${lockfile},title=Packages osv-scanner did not read::${coverage.head.missing.length} of ${coverage.head.total} registry packages, starting with ${coverage.head.missing.slice(0, 5).join(", ")}`,
      );
    if (coverage.base?.missing.length)
      console.log(
        `::warning file=${lockfile},title=Base packages osv-scanner did not read::${coverage.base.missing.length} of ${coverage.base.total} registry packages in the merge base's copy`,
      );
    if (result.blocking.length || coverage.head.missing.length) failed = true;
  }
  if (failed) process.exit(1);
}

/** The file at a commit, or null when the commit does not have it. */
function gitFileAt(ref, path) {
  const exists = spawnSync("git", ["cat-file", "-e", `${ref}:${path}`]);
  if (exists.status !== 0) return null;
  return git(["show", `${ref}:${path}`]);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
