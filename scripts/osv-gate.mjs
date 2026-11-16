#!/usr/bin/env node
/**
 * Fails a PR that introduces a dependency with a critical or high advisory, or
 * any malware advisory, in the repository's lockfile.
 *
 * Both lockfiles are scanned offline with `osv-scanner`: the head checkout and
 * the merge base's copy. An advisory is introduced when none of its ids or
 * aliases is on that package in the base scan, so moving to a less vulnerable
 * version passes, and an advisory published against an unchanged package is
 * reported without blocking the PR that happened to run.
 *
 * Severity is the OSV CVSS score: 9.0 and up is critical, 7.0 and up is high.
 * An introduced advisory with no score is a warning. Existing advisories, the
 * report-only lockfiles and the licenses of added packages (from the npm
 * registry, so the dependency list never goes to OSV or deps.dev) are reported
 * only.
 *
 * Exceptions are `[[IgnoredVulns]]` entries in `osv-scanner.toml`, each with a
 * `reason`.
 *
 * Usage: node scripts/osv-gate.mjs [--lockfile bun.lock] [--report <lockfile>]...
 *        [--base <ref>]. The base defaults to the remote default branch.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
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
        fixAvailable: (vuln?.affected ?? []).some((a) =>
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
  // An advisory is the same one when any id or alias matches on that package:
  // osv-scanner's group ids are only sorted, so the first id can change
  // between scans when the duplicate records that apply change.
  const baseAliases = new Map();
  for (const f of findingsFromScan(base)) {
    const known = baseAliases.get(f.pkg) ?? new Set();
    for (const a of f.aliases) known.add(a);
    baseAliases.set(f.pkg, known);
  }
  const inBase = (f) => f.aliases.some((a) => baseAliases.get(f.pkg)?.has(a));
  const headFindings = findingsFromScan(head);
  const introduced = headFindings.filter((f) => !inBase(f));
  const basePackages = packageVersions(base);
  return {
    introduced,
    existing: headFindings.filter(inBase),
    blocking: introduced.filter(isBlocking),
    warnings: introduced.filter(
      (f) => !isBlocking(f) && f.severity === "unscored",
    ),
    addedPackages: [...packageVersions(head)]
      .filter((p) => !basePackages.has(p))
      .sort(),
  };
}

/** The `[[IgnoredVulns]]` entries of osv-scanner.toml: string and date values only. */
export function parseIgnoredVulns(toml) {
  const entries = [];
  let current = null;
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/^\s+|\s+$/g, "");
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      current = line === "[[IgnoredVulns]]" ? {} : null;
      if (current) entries.push(current);
      continue;
    }
    if (!current) continue;
    const m = /^([A-Za-z]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^#\s]+))/.exec(line);
    if (!m) throw new Error(`osv-scanner.toml: cannot read "${line}"`);
    current[m[1]] = m[2] !== undefined ? JSON.parse(`"${m[2]}"`) : m[3];
  }
  return entries;
}

/** Every exception must name an advisory and say why it is accepted. */
export function invalidExceptions(entries) {
  return entries.flatMap((e, i) => {
    const problems = [];
    if (typeof e.id !== "string" || !e.id)
      problems.push(`entry ${i + 1} has no id`);
    if (typeof e.reason !== "string" || !e.reason.trim())
      problems.push(
        `${typeof e.id === "string" ? e.id : `entry ${i + 1}`} has no reason`,
      );
    return problems;
  });
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

export function renderSummary(result, licenses, reportOnly, lockfile) {
  const header =
    "| Severity | Package | Advisory | Fix | Summary |\n| --- | --- | --- | --- | --- |";
  const lines = ["## Vulnerable dependencies", ""];
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
  for (const lock of reportOnly)
    lines.push(`Not gated, \`${lock.path}\`: ${counts(lock.findings)}.`, "");
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
  const opts = { lockfile: "bun.lock", report: [], base: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--lockfile", "--report", "--base"].includes(flag))
      throw new Error(`Unknown argument ${flag}`);
    if (!value || value.startsWith("--"))
      throw new Error(`${flag} needs a value`);
    if (flag === "--report") opts.report.push(value);
    else opts[flag.slice(2)] = value;
    i++;
  }
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

function scan(lockfile, config) {
  const args = [
    "scan",
    "source",
    "--offline-vulnerabilities",
    "--download-offline-databases",
    "--all-packages",
    "--format",
    "json",
    "-L",
    lockfile,
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
      `osv-scanner failed on ${lockfile} (exit ${res.status}): ${res.stderr}`,
    );
  return JSON.parse(res.stdout);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseRef = opts.base ?? defaultBranchRef();
  process.chdir(git(["rev-parse", "--show-toplevel"]).trim());

  const config = resolve("osv-scanner.toml");
  const problems = invalidExceptions(
    parseIgnoredVulns(readFileSync(config, "utf8")),
  );
  if (problems.length) {
    for (const p of problems)
      console.log(`::error file=osv-scanner.toml::Exception ${p}`);
    process.exit(1);
  }

  const mergeBase = git(["merge-base", baseRef, "HEAD"]).trim();
  const baseDir = mkdtempSync(join(tmpdir(), "osv-gate-base-"));
  let baseScan;
  try {
    // Same file name as the head lockfile, which is how osv-scanner picks its parser.
    const baseLock = join(baseDir, basename(opts.lockfile));
    writeFileSync(baseLock, git(["show", `${mergeBase}:${opts.lockfile}`]));
    baseScan = scan(baseLock);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }

  const result = compareScans(baseScan, scan(opts.lockfile, config));
  const reportOnly = opts.report.map((path) => ({
    path,
    findings: findingsFromScan(scan(path)),
  }));
  const licenses = await lookupLicenses(result.addedPackages);

  const summary = renderSummary(result, licenses, reportOnly, opts.lockfile);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  for (const f of result.blocking)
    console.log(
      `::error file=${opts.lockfile},title=Vulnerable dependency::${f.pkg}@${f.version} ${f.id} (${f.malware ? "malware" : f.severity})`,
    );
  for (const f of result.warnings)
    console.log(
      `::warning file=${opts.lockfile},title=Unscored advisory::${f.pkg}@${f.version} ${f.id}`,
    );
  if (result.blocking.length) process.exit(1);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
