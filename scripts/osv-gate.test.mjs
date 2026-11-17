import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  compareScans,
  findingsFromScan,
  invalidExceptions,
  lookupLicenses,
  parseArgs,
  parseOsvConfig,
  renderSummary,
  severityOf,
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
    assert.deepEqual(parseArgs([]), {
      lockfile: "bun.lock",
      report: [],
      base: null,
    });
  });

  it("reads the lockfile, repeated report lockfiles and the base", () => {
    assert.deepEqual(
      parseArgs([
        "--lockfile",
        "package-lock.json",
        "--report",
        "a/bun.lock",
        "--report",
        "b/bun.lock",
        "--base",
        "abc",
      ]),
      {
        lockfile: "package-lock.json",
        report: ["a/bun.lock", "b/bun.lock"],
        base: "abc",
      },
    );
  });

  it("rejects unknown flags and missing values", () => {
    assert.throws(() => parseArgs(["--lock", "x"]), /Unknown argument/);
    assert.throws(() => parseArgs(["--base"]), /needs a value/);
    assert.throws(() => parseArgs(["--base", "--report"]), /needs a value/);
  });
});

describe("renderSummary", () => {
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
      [{ path: "scripts/package-lock.json", findings: [] }],
      "package-lock.json",
    );
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
    assert.ok(
      summary.includes("Not gated, `scripts/package-lock.json`: none."),
    );
    assert.ok(summary.includes("| `new@1.0.0` | MIT |"));
  });

  it("says nothing was introduced when the PR is clean", () => {
    assert.match(
      renderSummary(
        compareScans(scanOf(), scanOf()),
        new Map(),
        [],
        "bun.lock",
      ),
      /No critical, high or malware advisories introduced in `bun.lock`/,
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
