import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  compareScans,
  findingsFromScan,
  invalidExceptions,
  lockedPackages,
  lookupLicenses,
  parseArgs,
  parseJsonWithTrailingCommas,
  parseOsvConfig,
  renderSummary,
  scanAndCompare,
  severityOf,
  splitBySource,
  unreadPackages,
} from "./osv-gate.mjs";

const pkg = (name, version, advisories = []) => ({
  package: { name, version, ecosystem: "npm" },
  vulnerabilities: advisories.map((a) => ({
    id: a.id,
    summary: `${a.id} summary`,
    affected: [
      {
        package: { name, ecosystem: "npm" },
        ranges: [
          {
            events:
              a.fixed === false
                ? [{ introduced: "0" }]
                : [{ introduced: "0" }, { fixed: "9.9.9" }],
          },
        ],
      },
    ],
  })),
  groups: advisories.map((a) => ({
    ids: [a.id],
    aliases: a.aliases ?? [],
    max_severity: a.score ?? "",
  })),
});

const scanOf = (...packages) => ({ results: [{ packages }] });
const ids = (findings) => findings.map((f) => f.id);

describe("severityOf", () => {
  for (const [score, severity] of [
    ["9.8", "critical"],
    ["9.0", "critical"],
    ["8.9", "high"],
    ["7.0", "high"],
    ["6.9", "medium"],
    ["4.0", "medium"],
    ["3.9", "low"],
    ["", "unscored"],
    [undefined, "unscored"],
  ]) {
    it(`maps ${JSON.stringify(score)} to ${severity}`, () => {
      assert.equal(severityOf(score).severity, severity);
    });
  }
});

describe("compareScans", () => {
  it("blocks a critical or high advisory the PR introduces", () => {
    const base = scanOf(pkg("left-pad", "1.0.0"));
    const head = scanOf(
      pkg("left-pad", "1.0.0"),
      pkg("evil", "2.0.0", [{ id: "GHSA-crit", score: "9.8" }]),
      pkg("meh", "1.0.0", [{ id: "GHSA-high", score: "7.5", fixed: false }]),
    );
    const result = compareScans(base, head);
    assert.deepEqual(ids(result.blocking).sort(), ["GHSA-crit", "GHSA-high"]);
    assert.deepEqual(result.addedPackages, ["evil@2.0.0", "meh@1.0.0"]);
  });

  it("blocks malware whatever its severity, by id or alias", () => {
    const head = scanOf(
      pkg("typo-squat", "1.0.0", [{ id: "MAL-2026-1", score: "" }]),
      pkg("x", "1.0.0", [
        { id: "GHSA-abc", score: "5.0", aliases: ["MAL-2026-2"] },
      ]),
    );
    const result = compareScans(scanOf(), head);
    assert.deepEqual(ids(result.blocking), ["MAL-2026-1", "GHSA-abc"]);
    assert.deepEqual(result.warnings, []);
  });

  it("does not block an advisory already on that package in the base", () => {
    const base = scanOf(
      pkg("undici", "6.25.0", [{ id: "GHSA-old", score: "7.5" }]),
    );
    const head = scanOf(
      pkg("undici", "6.25.1", [{ id: "GHSA-old", score: "7.5" }]),
    );
    const result = compareScans(base, head);
    assert.deepEqual(result.blocking, []);
    assert.deepEqual(ids(result.existing), ["GHSA-old"]);
  });

  it("matches the same advisory when its group ids change between scans", () => {
    const base = scanOf(
      pkg("qs", "6.0.0", [
        { id: "CVE-2026-1", score: "7.5", aliases: ["GHSA-qs"] },
      ]),
    );
    const head = scanOf(pkg("qs", "6.0.1", [{ id: "GHSA-qs", score: "7.5" }]));
    const result = compareScans(base, head);
    assert.deepEqual(result.blocking, []);
    assert.deepEqual(ids(result.existing), ["GHSA-qs"]);
  });

  it("blocks a known advisory when it arrives on a package that did not have it", () => {
    const base = scanOf(
      pkg("a", "1.0.0", [{ id: "GHSA-shared", score: "8.0" }]),
    );
    const head = scanOf(
      pkg("a", "1.0.0", [{ id: "GHSA-shared", score: "8.0" }]),
      pkg("b", "1.0.0", [{ id: "GHSA-shared", score: "8.0" }]),
    );
    assert.deepEqual(
      compareScans(base, head).blocking.map((f) => f.pkg),
      ["b"],
    );
  });

  it("warns on an unscored advisory and passes medium and low", () => {
    const head = scanOf(
      pkg("x", "1.0.0", [{ id: "GHSA-none" }]),
      pkg("y", "1.0.0", [{ id: "GHSA-med", score: "5.3" }]),
      pkg("z", "1.0.0", [{ id: "GHSA-low", score: "2.0" }]),
    );
    const result = compareScans(scanOf(), head);
    assert.deepEqual(result.blocking, []);
    assert.deepEqual(ids(result.warnings), ["GHSA-none"]);
    assert.equal(result.introduced.length, 3);
  });

  it("records whether a fix exists", () => {
    const findings = findingsFromScan(
      scanOf(
        pkg("a", "1.0.0", [
          { id: "GHSA-fix", score: "8" },
          { id: "GHSA-nofix", score: "8", fixed: false },
        ]),
      ),
    );
    assert.deepEqual(
      findings.map((f) => [f.id, f.fixAvailable]),
      [
        ["GHSA-fix", true],
        ["GHSA-nofix", false],
      ],
    );
  });

  it("blocks a second affected version added beside one already there", () => {
    const base = scanOf(pkg("qs", "1.0.0", [{ id: "GHSA-qs", score: "7.5" }]));
    const head = scanOf(
      pkg("qs", "1.0.0", [{ id: "GHSA-qs", score: "7.5" }]),
      pkg("qs", "2.0.0", [{ id: "GHSA-qs", score: "7.5" }]),
    );
    const result = compareScans(base, head);
    assert.deepEqual(
      result.blocking.map((f) => f.version),
      ["2.0.0"],
    );
    assert.deepEqual(
      result.existing.map((f) => f.version),
      ["1.0.0"],
    );
  });

  it("lets an affected version replace one the PR removed", () => {
    const base = scanOf(
      pkg("qs", "1.0.0", [{ id: "GHSA-qs", score: "7.5" }]),
      pkg("qs", "2.0.0", [{ id: "GHSA-qs", score: "7.5" }]),
    );
    const head = scanOf(
      pkg("qs", "2.0.0", [{ id: "GHSA-qs", score: "7.5" }]),
      pkg("qs", "3.0.0", [{ id: "GHSA-qs", score: "7.5" }]),
    );
    assert.deepEqual(compareScans(base, head).blocking, []);
  });

  it("reads the fix from the reported package only", () => {
    const scan = scanOf(
      pkg("a", "1.0.0", [{ id: "GHSA-multi", score: "8", fixed: false }]),
    );
    scan.results[0].packages[0].vulnerabilities[0].affected.push({
      package: { name: "other", ecosystem: "npm" },
      ranges: [{ events: [{ introduced: "0" }, { fixed: "2.0.0" }] }],
    });
    assert.equal(findingsFromScan(scan)[0].fixAvailable, false);
  });

  it("finds a fix listed on any record in the advisory group", () => {
    const scan = scanOf(
      pkg("a", "1.0.0", [{ id: "CVE-2026-9", score: "8", fixed: false }]),
    );
    const p = scan.results[0].packages[0];
    p.groups[0].ids.push("GHSA-9");
    p.vulnerabilities.push({
      id: "GHSA-9",
      affected: [
        {
          package: { name: "a", ecosystem: "npm" },
          ranges: [{ events: [{ introduced: "0" }, { fixed: "1.0.1" }] }],
        },
      ],
    });
    assert.equal(findingsFromScan(scan)[0].fixAvailable, true);
  });

  it("handles a scan with no results", () => {
    assert.deepEqual(
      compareScans({ results: null }, { results: [] }).introduced,
      [],
    );
  });
});

describe("scanAndCompare", () => {
  const at = (path, ...packages) => ({
    source: { path, type: "lockfile" },
    packages,
  });
  const qs = (version) => pkg("qs", version, [{ id: "GHSA-qs", score: "7.5" }]);
  // Stands in for osv-scanner: an override in the config accepts GHSA-qs on qs@1.0.0 only.
  const fakeScanner = (calls) => (lockfiles, config) => {
    calls.push({ lockfiles, config });
    const shown = (versions) =>
      versions.filter((v) => !(config && v === "1.0.0")).map(qs);
    const clean = pkg("left-pad", "1.3.0");
    return {
      results: [
        at("/base/bun.lock", clean, ...shown(["1.0.0"])),
        at("/head/bun.lock", clean, ...shown(["1.0.0", "2.0.0"])),
      ],
    };
  };

  const pair = [{ base: "/base/bun.lock", head: "/head/bun.lock" }];
  const only = (gated) => gated[0].result;

  it("blocks a new affected version beside one an exception accepts", () => {
    const result = only(
      scanAndCompare(pair, "osv-scanner.toml", fakeScanner([])),
    );
    assert.deepEqual(
      result.blocking.map((f) => f.version),
      ["2.0.0"],
    );
  });

  it("scans both lockfiles in one run under the config", () => {
    const calls = [];
    scanAndCompare(pair, "osv-scanner.toml", fakeScanner(calls));
    assert.deepEqual(calls, [
      {
        lockfiles: ["/base/bun.lock", "/head/bun.lock"],
        config: "osv-scanner.toml",
      },
    ]);
  });

  it("blocks an advisory in an ecosystem only the head has", () => {
    const gitDep = {
      ...pkg("https://github.com/a/b", "1.0.0", [
        { id: "GHSA-git", score: "9.8" },
      ]),
      package: {
        name: "https://github.com/a/b",
        version: "1.0.0",
        ecosystem: "GIT",
      },
    };
    const scanner = () => ({
      results: [
        at("/base/bun.lock", qs("2.0.0")),
        at("/head/bun.lock", qs("2.0.0"), gitDep),
      ],
    });
    const result = only(scanAndCompare(pair, "osv-scanner.toml", scanner));
    assert.deepEqual(ids(result.blocking), ["GHSA-git"]);
    assert.deepEqual(ids(result.existing), ["GHSA-qs"]);
  });

  it("fails closed when the scanner fails", () => {
    const scanner = () => {
      throw new Error("osv-scanner failed (exit 127)");
    };
    assert.throws(() => scanAndCompare(pair, null, scanner), /exit 127/);
  });

  it("scans every gated lockfile and its base in the same run, and compares each pair", () => {
    const calls = [];
    const scanner = (lockfiles, config) => {
      calls.push({ lockfiles, config });
      return {
        results: [
          at("/base/bun.lock", qs("2.0.0")),
          at("/head/bun.lock", qs("2.0.0")),
          at("/base/scripts/package-lock.json", pkg("left-pad", "1.3.0")),
          at(
            "/head/scripts/package-lock.json",
            pkg("left-pad", "1.3.0"),
            qs("1.0.0"),
          ),
        ],
      };
    };
    const gated = scanAndCompare(
      [
        { base: "/base/bun.lock", head: "/head/bun.lock" },
        {
          base: "/base/scripts/package-lock.json",
          head: "/head/scripts/package-lock.json",
        },
      ],
      "osv-scanner.toml",
      scanner,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].lockfiles, [
      "/base/bun.lock",
      "/head/bun.lock",
      "/base/scripts/package-lock.json",
      "/head/scripts/package-lock.json",
    ]);
    assert.deepEqual(ids(gated[0].result.existing), ["GHSA-qs"]);
    assert.deepEqual(ids(gated[0].result.blocking), []);
    assert.deepEqual(ids(gated[1].result.blocking), ["GHSA-qs"]);
    assert.equal(
      gated[1].head.results[0].source.path,
      "/head/scripts/package-lock.json",
    );
  });

  it("treats every advisory in a lockfile the PR adds as introduced", () => {
    const calls = [];
    const scanner = (lockfiles) => {
      calls.push(lockfiles);
      return { results: [at("/head/new/bun.lock", qs("1.0.0"))] };
    };
    const [gated] = scanAndCompare(
      [{ base: null, head: "/head/new/bun.lock" }],
      "osv-scanner.toml",
      scanner,
    );
    assert.deepEqual(calls, [["/head/new/bun.lock"]]);
    assert.deepEqual(gated.base, { results: [] });
    assert.deepEqual(ids(gated.result.blocking), ["GHSA-qs"]);
  });
});

describe("splitBySource", () => {
  const at = (path, ...packages) => ({
    source: { path, type: "lockfile" },
    packages,
  });
  const one = (path) => at(path, pkg(path, "1.0.0"));

  it("splits results by lockfile path", () => {
    assert.deepEqual(
      splitBySource({ results: [one("/b"), one("/a")] }, ["/a", "/b"]),
      [{ results: [one("/a")] }, { results: [one("/b")] }],
    );
  });

  it("matches Windows paths that osv-scanner reports with forward slashes", () => {
    const scanned = {
      results: [one("C:/w/base/bun.lock"), one("C:/w/head/bun.lock")],
    };
    const native = ["C:\\w\\base\\bun.lock", "C:\\w\\head\\bun.lock"];
    assert.deepEqual(splitBySource(scanned, native, "win32"), [
      { results: [one("C:/w/base/bun.lock")] },
      { results: [one("C:/w/head/bun.lock")] },
    ]);
    // Elsewhere a backslash can be part of a file name, so paths match exactly.
    assert.throws(
      () => splitBySource(scanned, native, "linux"),
      /not a scanned lockfile/,
    );
  });

  it("fails on a lockfile with no packages, as when exceptions hide every package", () => {
    assert.throws(
      () => splitBySource({ results: [one("/a")] }, ["/a", "/b"]),
      /no packages for \/b/,
    );
    assert.throws(
      () => splitBySource({ results: [one("/b"), at("/a")] }, ["/a", "/b"]),
      /no packages for \/a/,
    );
    assert.throws(
      () => splitBySource({ results: [] }, ["/a", "/b"]),
      /no packages for \/a/,
    );
  });

  it("fails on a result for a path the gate did not scan", () => {
    assert.throws(
      () =>
        splitBySource({ results: [one("/a"), one("/b"), one("/elsewhere")] }, [
          "/a",
          "/b",
        ]),
      /not a scanned lockfile/,
    );
  });
});

describe("parseOsvConfig and invalidExceptions", () => {
  it("reads entries, trailing comments, spaced headers and a # inside a string", () => {
    const toml = [
      "# header comment",
      "[[IgnoredVulns]] # temporary",
      'id = "GHSA-1" # trailing comment',
      "ignoreUntil = 2027-01-01",
      'reason = "dev server only, \\"quoted\\" #not-a-comment"',
      "",
      "[[ IgnoredVulns ]]",
      "id = 'GHSA-2'",
    ].join("\n");
    const config = parseOsvConfig(toml);
    assert.deepEqual(config.IgnoredVulns, [
      {
        id: "GHSA-1",
        ignoreuntil: "2027-01-01",
        reason: 'dev server only, "quoted" #not-a-comment',
      },
      { id: "GHSA-2" },
    ]);
    assert.deepEqual(invalidExceptions(config), ["GHSA-2 has no reason"]);
  });

  it("reads a commented-out example as no entries", () => {
    assert.deepEqual(parseOsvConfig('# [[IgnoredVulns]]\n# id = "GHSA-x"\n'), {
      IgnoredVulns: [],
      PackageOverrides: [],
    });
  });

  it("requires a reason on every package override that hides vulnerabilities", () => {
    const toml = [
      "[[PackageOverrides]]",
      'name = "a"',
      "ignore = true",
      "[[PackageOverrides]]",
      'name = "b"',
      "vulnerability.ignore = true",
      "[[PackageOverrides]]",
      'name = "d"',
      "vulnerability.ignore = true",
      'reason = "vendored and patched"',
      "[[PackageOverrides]]",
      'name = "e"',
      'license.override = ["MIT"]',
      ,
      "[[PackageOverrides]]",
      'name = "f"',
      "license.ignore = true",
    ].join("\n");
    assert.deepEqual(invalidExceptions(parseOsvConfig(toml)), [
      "a ignores vulnerabilities without a reason",
      "b ignores vulnerabilities without a reason",
    ]);
  });

  it("matches table and key names case-insensitively, as osv-scanner does", () => {
    const toml = [
      "[[ignoredvulns]]",
      'ID = "GHSA-1"',
      "[[PACKAGEOVERRIDES]]",
      'Name = "a"',
      "Ignore = true",
      "[[PackageOverrides]]",
      'name = "b"',
      "Vulnerability.IGNORE = true",
      'Reason = "patched in our fork"',
    ].join("\n");
    assert.deepEqual(invalidExceptions(parseOsvConfig(toml)), [
      "GHSA-1 has no reason",
      "a ignores vulnerabilities without a reason",
    ]);
  });

  it("fails closed on what it cannot check", () => {
    assert.throws(
      () => parseOsvConfig('[[Unknown]]\nid = "x"'),
      /does not check \[\[Unknown\]\]/,
    );
    assert.throws(
      () => parseOsvConfig("[PackageOverrides.vulnerability]\nignore = true"),
      /cannot check/,
    );
    assert.throws(
      () => parseOsvConfig('[[IgnoredVulns]]\nreason = """\nwhy\n"""'),
      /multi-line/,
    );
    assert.throws(
      () => parseOsvConfig("[[IgnoredVulns]]\nid = \n"),
      /cannot read/,
    );
    for (const inline of [
      "{ ignore = true }",
      '{ "ignore" = true }',
      "{ 'ignore' = true }",
    ])
      assert.throws(
        () =>
          parseOsvConfig(
            `[[PackageOverrides]]\nname = "x"\nvulnerability = ${inline}`,
          ),
        /dotted keys/,
      );
    assert.throws(
      () =>
        parseOsvConfig('[[PackageOverrides]]\n"vulnerability".ignore = true'),
      /cannot read/,
    );
    for (const topLevel of [
      'IgnoredVulns = [{ id = "GHSA-1" }]',
      'PackageOverrides = [{ name = "x", ignore = true }]',
      "ignoredvulns = []",
      'GoVersionOverride = "1.22"',
    ])
      assert.throws(() => parseOsvConfig(topLevel), /no top-level settings/);
    assert.throws(
      () => parseOsvConfig('[[IgnoredVulns]]\nid = { value = "GHSA-1" }'),
      /dotted keys/,
    );
    assert.throws(
      () =>
        parseOsvConfig('[[PackageOverrides]]\nvulnerability."ignore" = true'),
      /cannot read/,
    );
    assert.throws(
      () => parseOsvConfig('[[IgnoredVulns]]\nid = "unterminated\n'),
      /cannot read the string/,
    );
  });

  it("rejects a key set twice in one entry, in any case", () => {
    assert.throws(
      () =>
        parseOsvConfig(
          '[[PackageOverrides]]\nname = "a"\nignore = true\nIgnore = false\nreason = "x"',
        ),
      /line 4: Ignore is already set/,
    );
    assert.throws(
      () =>
        parseOsvConfig(
          '[[IgnoredVulns]]\nid = "GHSA-1"\nreason = "x"\nREASON = ""',
        ),
      /already set/,
    );
    assert.throws(
      () =>
        parseOsvConfig(
          "[[PackageOverrides]]\nvulnerability.ignore = true\nVulnerability.Ignore = false",
        ),
      /already set/,
    );
    assert.deepEqual(
      parseOsvConfig(
        '[[IgnoredVulns]]\nid = "GHSA-1"\n[[IgnoredVulns]]\nid = "GHSA-2"',
      ).IgnoredVulns,
      [{ id: "GHSA-1" }, { id: "GHSA-2" }],
    );
  });

  it("flags a blank reason and a missing id", () => {
    assert.deepEqual(
      invalidExceptions({
        IgnoredVulns: [{ id: "GHSA-1", reason: "  " }, { reason: "why" }],
        PackageOverrides: [],
      }),
      ["GHSA-1 has no reason", "entry 2 has no id"],
    );
  });
});

describe("parseArgs", () => {
  it("defaults to bun.lock and the remote default branch", () => {
    assert.deepEqual(parseArgs([]), { lockfiles: ["bun.lock"], base: null });
  });

  it("reads repeated lockfiles and the base", () => {
    assert.deepEqual(
      parseArgs([
        "--lockfile",
        "bun.lock",
        "--lockfile",
        "scripts/package-lock.json",
        "--base",
        "abc",
      ]),
      {
        lockfiles: ["bun.lock", "scripts/package-lock.json"],
        base: "abc",
      },
    );
  });

  it("rejects unknown flags, missing values and a lockfile given twice", () => {
    assert.throws(() => parseArgs(["--lock", "x"]), /Unknown argument/);
    assert.throws(
      () => parseArgs(["--report", "scripts/package-lock.json"]),
      /Unknown argument/,
    );
    assert.throws(() => parseArgs(["--base"]), /needs a value/);
    assert.throws(() => parseArgs(["--base", "--lockfile"]), /needs a value/);
    assert.throws(
      () => parseArgs(["--lockfile", "bun.lock", "--lockfile", "bun.lock"]),
      /given twice/,
    );
  });
});

describe("renderSummary", () => {
  const read = (total, extra = {}) => ({
    total,
    other: 0,
    missing: [],
    hidden: [],
    ...extra,
  });

  it("names blocking findings, counts existing ones and lists added licenses", () => {
    const base = scanOf(
      pkg("old", "1.0.0", [{ id: "GHSA-old", score: "9.1" }]),
    );
    const head = scanOf(
      pkg("old", "1.0.0", [{ id: "GHSA-old", score: "9.1" }]),
      pkg("new", "1.0.0", [{ id: "GHSA-new", score: "7.2" }]),
    );
    const summary = renderSummary(
      compareScans(base, head),
      new Map([["new@1.0.0", "MIT"]]),
      "package-lock.json",
      {
        head: read(2),
        base: read(1),
      },
    );
    assert.match(summary, /^## Vulnerable dependencies in `package-lock.json`/);
    assert.match(
      summary,
      /\*\*Blocked:\*\* this PR introduces 1 critical, high or malware advisories in `package-lock.json`/,
    );
    assert.ok(
      summary.includes(
        "| high (7.2) | `new@1.0.0` | GHSA-new | yes | GHSA-new summary |",
      ),
    );
    assert.ok(summary.includes("Not blocking: 1 critical."));
    assert.ok(summary.includes("| `new@1.0.0` | MIT |"));
    assert.ok(
      summary.includes(
        "osv-scanner read all 2 registry packages locked in `package-lock.json`.",
      ),
    );
    assert.ok(!summary.includes("Not gated"));
  });

  it("says nothing was introduced when the PR is clean", () => {
    assert.match(
      renderSummary(compareScans(scanOf(), scanOf()), new Map(), "bun.lock", {
        head: read(0),
        base: read(0),
      }),
      /No critical, high or malware advisories introduced in `bun.lock`/,
    );
  });

  it("blocks on unread head packages and warns on unread base packages", () => {
    const missing = Array.from(
      { length: 22 },
      (_, i) => `p${String(i).padStart(2, "0")}@1.0.0`,
    );
    const summary = renderSummary(
      compareScans(scanOf(), scanOf()),
      new Map(),
      "bun.lock",
      {
        head: read(40, { missing, other: 3 }),
        base: read(40, { missing: ["old@1.0.0"] }),
      },
    );
    assert.ok(
      summary.includes(
        "**Blocked:** osv-scanner did not read 22 of the 40 registry packages locked in `bun.lock`",
      ),
    );
    assert.ok(summary.includes("`p19@1.0.0`, and 2 more."));
    assert.ok(!summary.includes("p20@1.0.0"));
    assert.ok(
      summary.includes(
        "3 workspace, link, file or Git entries are not counted.",
      ),
    );
    assert.ok(
      summary.includes(
        "**Warning:** osv-scanner did not read 1 of the 40 registry packages in the merge base's `bun.lock`: `old@1.0.0`.",
      ),
    );
  });

  it("notes packages hidden by an override and a lockfile new in the PR", () => {
    const summary = renderSummary(
      compareScans(scanOf(), scanOf()),
      new Map(),
      "new/bun.lock",
      {
        head: read(5, { hidden: ["js-yaml@4.3.2"] }),
        base: null,
      },
    );
    assert.ok(
      summary.includes(
        "osv-scanner read all 5 registry packages locked in `new/bun.lock`, apart from 1 that `[[PackageOverrides]]` entries hide with `ignore = true`.",
      ),
    );
    assert.ok(
      summary.includes(
        "`new/bun.lock` is new in this PR, so every advisory in it counts as introduced.",
      ),
    );
  });
});

describe("parseJsonWithTrailingCommas", () => {
  it("drops trailing commas before a closing bracket, at any depth and across lines", () => {
    assert.deepEqual(
      parseJsonWithTrailingCommas('{ "a": [1, 2,], "b": { "c": "d", },\n}'),
      {
        a: [1, 2],
        b: { c: "d" },
      },
    );
  });

  it("keeps commas, brackets and escaped quotes inside strings", () => {
    assert.deepEqual(
      parseJsonWithTrailingCommas('{ "a": ",}", "b": "x\\",]", }'),
      { a: ",}", b: 'x",]' },
    );
  });

  it("fails on JSON it cannot read", () => {
    assert.throws(() => parseJsonWithTrailingCommas('{ "a": '), SyntaxError);
  });
});

// A bun.lock as bun writes it: trailing commas, workspaces, nested copies.
const BUN_LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "root", "dependencies": { "left-pad": "1.3.0", }, },
  },
  "packages": {
    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-a"],
    "@scope/pkg": ["@scope/pkg@2.0.0-beta.1", "", {}, "sha512-b"],
    "foo/left-pad": ["left-pad@1.3.0", "", {}, "sha512-a"],
    "bar/left-pad": ["left-pad@1.2.0", "", {}, "sha512-c"],
    "string-width-cjs": ["string-width@4.2.3", "", {}, "sha512-d"],
    "showcase": ["showcase@workspace:showcase"],
    "linked": ["linked@link:../linked", {}],
    "local": ["local@file:../local", {}],
    "rooted": ["rooted@root:", {}],
    "gitdep": ["gitdep@git+https://github.com/a/gitdep.git#0123456", {}, "0123456"],
    "ghdep": ["ghdep@github:a/ghdep#0123456", {}, "a-ghdep-0123456"],
    "tardep": ["tardep@https://example.com/tardep-1.0.0.tgz", {}],
  },
}
`;

const PACKAGE_LOCK = JSON.stringify({
  name: "root",
  lockfileVersion: 3,
  packages: {
    "": { name: "root", workspaces: ["packages/a"] },
    "packages/a": { name: "a", version: "0.1.0" },
    "node_modules/a": { resolved: "packages/a", link: true },
    "node_modules/minimist": {
      version: "1.2.5",
      resolved: "https://registry.npmjs.org/minimist/-/minimist-1.2.5.tgz",
    },
    "node_modules/foo/node_modules/minimist": { version: "1.2.5" },
    "node_modules/foo": { version: "2.0.0", dev: true },
    "node_modules/my-alias": { name: "lodash", version: "4.17.20" },
    "node_modules/@scope/x": { version: "1.0.0" },
    "node_modules/gitdep": {
      version: "1.0.0",
      resolved: "git+ssh://git@github.com/a/gitdep.git#0123456",
    },
    "node_modules/tardep": {
      version: "1.0.0",
      resolved: "https://example.com/tardep-1.0.0.tgz",
    },
  },
});

describe("lockedPackages", () => {
  it("reads the distinct registry packages of a bun.lock, aliases under their real name", () => {
    const locked = lockedPackages("bun.lock", BUN_LOCK);
    assert.deepEqual([...locked.registry].sort(), [
      "@scope/pkg@2.0.0-beta.1",
      "left-pad@1.2.0",
      "left-pad@1.3.0",
      "string-width@4.2.3",
    ]);
    // Workspace, link, file, root, Git, GitHub and tarball entries.
    assert.equal(locked.other, 7);
  });

  it("reads the distinct registry packages of a package-lock.json", () => {
    const locked = lockedPackages("scripts/package-lock.json", PACKAGE_LOCK);
    assert.deepEqual([...locked.registry].sort(), [
      "@scope/x@1.0.0",
      "foo@2.0.0",
      "lodash@4.17.20",
      "minimist@1.2.5",
      "tardep@1.0.0",
    ]);
    // The workspace target, its link and the Git dependency.
    assert.equal(locked.other, 3);
  });

  it("fails on a bun.lock entry it cannot read, such as one with an empty version", () => {
    const lock = (entry) => `{ "packages": { "foo": ${entry}, }, }`;
    assert.throws(
      () => lockedPackages("bun.lock", lock('["foo@", "", {}, "sha512-a"]')),
      /cannot read the version of "foo" \(foo@\)/,
    );
    assert.throws(
      () => lockedPackages("bun.lock", lock('["foo"]')),
      /cannot read the package entry "foo"/,
    );
    assert.throws(
      () => lockedPackages("bun.lock", lock('"foo@1.0.0"')),
      /cannot read the package entry "foo"/,
    );
    assert.throws(
      () => lockedPackages("bun.lock", lock("[]")),
      /cannot read the package entry "foo"/,
    );
    assert.throws(
      () => lockedPackages("bun.lock", lock('["foo@latest"]')),
      /cannot read the version/,
    );
  });

  it("fails on a package-lock.json entry without a version it can read", () => {
    const lock = (entry) =>
      JSON.stringify({ packages: { "": {}, "node_modules/foo": entry } });
    assert.throws(
      () => lockedPackages("package-lock.json", lock({})),
      /cannot read the version of "node_modules\/foo"/,
    );
    assert.throws(
      () => lockedPackages("package-lock.json", lock({ version: "" })),
      /cannot read the version/,
    );
  });

  it("fails on a lockfile with no packages map, or one it does not read", () => {
    assert.throws(
      () => lockedPackages("bun.lock", '{ "lockfileVersion": 1, }'),
      /no packages map/,
    );
    assert.throws(
      () =>
        lockedPackages(
          "package-lock.json",
          JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
        ),
      /no packages map/,
    );
    assert.throws(
      () => lockedPackages("yarn.lock", ""),
      /reads bun.lock and package-lock.json only/,
    );
    assert.throws(
      () => lockedPackages("bun.lock", '{ "packages": '),
      SyntaxError,
    );
  });
});

describe("unreadPackages", () => {
  const locked = {
    registry: new Set(["left-pad@1.3.0", "js-yaml@4.3.2", "@scope/pkg@2.0.0"]),
    other: 2,
  };

  it("passes when osv-scanner read every registry package", () => {
    const scan = scanOf(
      pkg("left-pad", "1.3.0"),
      pkg("js-yaml", "4.3.2"),
      pkg("@scope/pkg", "2.0.0"),
      pkg("ws", "workspace:ws"),
    );
    assert.deepEqual(unreadPackages(locked, scan, []), {
      total: 3,
      other: 2,
      missing: [],
      hidden: [],
    });
  });

  it("names each registry package the scan is missing", () => {
    assert.deepEqual(
      unreadPackages(locked, scanOf(pkg("left-pad", "1.3.0")), []).missing,
      ["@scope/pkg@2.0.0", "js-yaml@4.3.2"],
    );
  });

  it("counts a package osv-scanner read with an empty version as unread", () => {
    // osv-scanner 2.7.1 reads a malformed bun.lock entry such as ["js-yaml@"] as js-yaml with no version.
    const scan = scanOf(
      pkg("left-pad", "1.3.0"),
      pkg("js-yaml", ""),
      pkg("@scope/pkg", "2.0.0"),
    );
    assert.deepEqual(unreadPackages(locked, scan, []).missing, [
      "js-yaml@4.3.2",
    ]);
  });

  it("excepts a package a [[PackageOverrides]] entry hides with ignore = true", () => {
    const scan = scanOf(pkg("left-pad", "1.3.0"), pkg("@scope/pkg", "2.0.0"));
    const hides = (o) =>
      unreadPackages(locked, scan, [{ ignore: true, reason: "r", ...o }]);
    assert.deepEqual(hides({ name: "js-yaml" }), {
      total: 3,
      other: 2,
      missing: [],
      hidden: ["js-yaml@4.3.2"],
    });
    assert.deepEqual(
      hides({ name: "js-yaml", version: "4.3.2", ecosystem: "npm" }).hidden,
      ["js-yaml@4.3.2"],
    );
    // Only the version and ecosystem it names, and only an ignore of the whole package.
    assert.deepEqual(hides({ name: "js-yaml", version: "4.0.0" }).missing, [
      "js-yaml@4.3.2",
    ]);
    assert.deepEqual(hides({ name: "js-yaml", ecosystem: "PyPI" }).missing, [
      "js-yaml@4.3.2",
    ]);
    assert.deepEqual(hides({ name: "left-pad" }).missing, ["js-yaml@4.3.2"]);
    assert.deepEqual(
      unreadPackages(locked, scan, [
        { name: "js-yaml", "vulnerability.ignore": true, reason: "r" },
      ]).missing,
      ["js-yaml@4.3.2"],
    );
  });

  it("reads a real bun.lock against the scan osv-scanner returns for it", () => {
    const scan = scanOf(
      pkg("left-pad", "1.3.0"),
      pkg("left-pad", "1.2.0"),
      pkg("@scope/pkg", "2.0.0-beta.1"),
      pkg("string-width", "4.2.3"),
      pkg("showcase", "workspace:showcase"),
      pkg("https://github.com/a/gitdep", ""),
    );
    assert.deepEqual(
      unreadPackages(lockedPackages("bun.lock", BUN_LOCK), scan, []).missing,
      [],
    );
  });
});

describe("lookupLicenses", () => {
  const respond = (body, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("reads string and object licenses, scoped names included", async () => {
    const fetcher = mock.fn((url) =>
      url.includes("@scope%2fpkg")
        ? respond({ license: { type: "Apache-2.0" } })
        : respond({ license: "MIT" }),
    );
    const licenses = await lookupLicenses(
      ["plain@1.0.0", "@scope/pkg@2.0.0"],
      fetcher,
    );
    assert.equal(licenses.get("plain@1.0.0"), "MIT");
    assert.equal(licenses.get("@scope/pkg@2.0.0"), "Apache-2.0");
    assert.ok(
      fetcher.mock.calls.some(
        (c) =>
          c.arguments[0] === "https://registry.npmjs.org/@scope%2fpkg/2.0.0",
      ),
    );
  });

  it("reports a missing license and registry failures without throwing", async () => {
    const fetcher = mock.fn((url) => {
      if (url.includes("down")) return Promise.reject(new Error("ECONNRESET"));
      if (url.includes("gone")) return respond({}, 404);
      return respond({});
    });
    const licenses = await lookupLicenses(
      ["bare@1.0.0", "gone@1.0.0", "down@1.0.0"],
      fetcher,
    );
    assert.equal(licenses.get("bare@1.0.0"), "none declared");
    assert.equal(licenses.get("gone@1.0.0"), "unknown (registry 404)");
    assert.equal(licenses.get("down@1.0.0"), "unknown (registry unreachable)");
  });

  it("gives up on a registry request that stalls", async () => {
    const fetcher = (_url, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal.reason),
        ),
      );
    // AbortSignal.timeout does not keep Node running; a real request's socket
    // would, so hold the loop open while the fake one waits.
    const keepAlive = setInterval(() => {}, 1000);
    const licenses = await lookupLicenses(["slow@1.0.0"], fetcher, 20).finally(
      () => clearInterval(keepAlive),
    );
    assert.equal(licenses.get("slow@1.0.0"), "unknown (registry unreachable)");
  });

  it("stops after the lookup cap", async () => {
    const packages = Array.from({ length: 250 }, (_, i) => `p${i}@1.0.0`);
    const licenses = await lookupLicenses(packages, () =>
      respond({ license: "MIT" }),
    );
    assert.equal(licenses.size, 200);
  });
});
