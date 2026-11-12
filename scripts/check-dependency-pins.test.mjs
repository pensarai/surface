import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bunfigWritesExact,
  findUnpinned,
  installConfigProblems,
  npmrcSavesExact,
} from "./check-dependency-pins.mjs";

const manifest = (path, pkg) => ({ path, pkg });
const specs = (manifests) =>
  findUnpinned(manifests).map((v) => `${v.section}.${v.name}`);

describe("findUnpinned", () => {
  it("accepts exact versions, prereleases and exact aliases", () => {
    const root = manifest("package.json", {
      name: "root",
      dependencies: { next: "16.2.6", left: "1.0.0-beta.2" },
      devDependencies: { typescript7: "npm:typescript@7.0.2" },
      optionalDependencies: { "@img/sharp-linux-x64": "0.35.5" },
      overrides: { react: "19.2.6" },
    });
    assert.deepEqual(findUnpinned([root]), []);
  });

  it("rejects ranges, tags and partial versions", () => {
    for (const spec of [
      "^1.2.3",
      "~1.2.3",
      "*",
      "latest",
      ">=1.2.3",
      "1.x",
      "1.2",
      "",
    ]) {
      const root = manifest("package.json", { dependencies: { left: spec } });
      assert.deepEqual(specs([root]), ["dependencies.left"], spec);
    }
  });

  it("rejects an alias to a range", () => {
    const root = manifest("package.json", {
      devDependencies: { ts: "npm:typescript@^7.0.0" },
    });
    assert.deepEqual(specs([root]), ["devDependencies.ts"]);
  });

  it("checks every section, including overrides", () => {
    const root = manifest("package.json", {
      dependencies: { a: "^1.0.0" },
      devDependencies: { b: "^1.0.0" },
      optionalDependencies: { c: "^1.0.0" },
      overrides: { d: "^1.0.0" },
    });
    assert.deepEqual(specs([root]), [
      "dependencies.a",
      "devDependencies.b",
      "optionalDependencies.c",
      "overrides.d",
    ]);
  });

  it("leaves peerDependencies as ranges", () => {
    const lib = manifest("package.json", {
      peerDependencies: { react: "^19.0.0" },
    });
    assert.deepEqual(findUnpinned([lib]), []);
  });

  it("requires workspace:* for a workspace package", () => {
    const root = manifest("package.json", {
      name: "root",
      workspaces: ["packages/*", "app"],
    });
    const lib = manifest("packages/lib/package.json", { name: "@scope/lib" });
    const app = manifest("app/package.json", {
      name: "app",
      dependencies: { "@scope/lib": "workspace:*" },
    });
    assert.deepEqual(findUnpinned([root, lib, app]), []);

    for (const spec of ["*", "1.0.0", "workspace:^"]) {
      const loose = manifest("app/package.json", {
        dependencies: { "@scope/lib": spec },
      });
      const [violation] = findUnpinned([root, lib, loose]);
      assert.equal(violation.name, "@scope/lib");
      assert.equal(violation.fix, "use `workspace:*`");
    }
  });

  it("treats a manifest outside the declared workspaces as a separate project", () => {
    const root = manifest("package.json", {
      name: "root",
      workspaces: ["packages/*"],
    });
    const tools = manifest("scripts/package.json", { name: "repo-scripts" });
    const nested = manifest("packages/lib/tools/package.json", {
      name: "nested-tools",
    });
    const lib = manifest("packages/lib/package.json", {
      name: "@scope/lib",
      dependencies: { "repo-scripts": "1.0.0", "nested-tools": "2.0.0" },
    });
    assert.deepEqual(findUnpinned([root, tools, nested, lib]), []);
  });

  it("requires an exact version of a workspace package from a project outside the workspace", () => {
    const root = manifest("package.json", {
      name: "root",
      workspaces: ["packages/*"],
    });
    const lib = manifest("packages/lib/package.json", { name: "@scope/lib" });
    const exact = manifest("scripts/package.json", {
      dependencies: { "@scope/lib": "1.0.0" },
    });
    assert.deepEqual(findUnpinned([root, lib, exact]), []);

    const linked = manifest("scripts/package.json", {
      dependencies: { "@scope/lib": "workspace:*" },
    });
    const [violation] = findUnpinned([root, lib, linked]);
    assert.equal(violation.fix, "use the exact version from the lockfile");
  });

  it("requires workspace:* from the root manifest too", () => {
    const root = manifest("package.json", {
      workspaces: ["packages/*"],
      devDependencies: { "@scope/lib": "1.0.0" },
    });
    const lib = manifest("packages/lib/package.json", { name: "@scope/lib" });
    assert.equal(findUnpinned([root, lib])[0].fix, "use `workspace:*`");
  });

  it("does not treat the workspace root as a member", () => {
    const root = manifest("package.json", {
      name: "root",
      workspaces: ["packages/*"],
    });
    const lib = manifest("packages/lib/package.json", {
      name: "@scope/lib",
      dependencies: { root: "1.0.0" },
    });
    assert.deepEqual(findUnpinned([root, lib]), []);
  });

  it("matches nested, deep and negated workspace globs", () => {
    const root = manifest("package.json", {
      workspaces: ["packages/*/plugins/*", "tools/**", "!tools/legacy/**"],
    });
    const plugin = manifest("packages/a/plugins/p/package.json", {
      name: "plugin",
    });
    const deep = manifest("tools/x/y/package.json", { name: "deep" });
    const legacy = manifest("tools/legacy/old/package.json", {
      name: "legacy",
    });
    const shallow = manifest("packages/a/package.json", { name: "shallow" });
    const app = manifest("tools/app/package.json", {
      dependencies: {
        plugin: "workspace:*",
        deep: "workspace:*",
        legacy: "1.0.0",
        shallow: "1.0.0",
      },
    });
    assert.deepEqual(
      findUnpinned([root, plugin, deep, legacy, shallow, app]),
      [],
    );
  });

  it("lets a globstar match zero directories", () => {
    const root = manifest("package.json", {
      workspaces: ["packages/**/plugins/*", "tools/**"],
    });
    const direct = manifest("packages/plugins/foo/package.json", {
      name: "direct",
    });
    const nested = manifest("packages/a/b/plugins/bar/package.json", {
      name: "nested",
    });
    const app = manifest("tools/package.json", {
      dependencies: { direct: "workspace:*", nested: "workspace:*" },
    });
    assert.deepEqual(findUnpinned([root, direct, nested, app]), []);
  });

  it("reads the object form of workspaces", () => {
    const root = manifest("package.json", {
      workspaces: { packages: ["packages/*"] },
    });
    const lib = manifest("packages/lib/package.json", { name: "@scope/lib" });
    const app = manifest("packages/app/package.json", {
      dependencies: { "@scope/lib": "1.0.0" },
    });
    assert.deepEqual(specs([root, lib, app]), ["dependencies.@scope/lib"]);
  });

  it("rejects workspace:* for a package that is not in the workspace", () => {
    const root = manifest("package.json", {
      dependencies: { lodash: "workspace:*" },
    });
    assert.deepEqual(specs([root]), ["dependencies.lodash"]);
  });

  it("rejects a nested override it cannot verify", () => {
    const root = manifest("package.json", {
      overrides: { parent: { child: "1.0.0" } },
    });
    assert.deepEqual(specs([root]), ["overrides.parent"]);
  });

  it("reports the manifest and a fix for each finding", () => {
    const app = manifest("app/package.json", {
      dependencies: { left: "^1.0.0" },
    });
    assert.deepEqual(findUnpinned([app]), [
      {
        path: "app/package.json",
        section: "dependencies",
        name: "left",
        spec: "^1.0.0",
        fix: "use the exact version from the lockfile",
      },
    ]);
  });

  it("fails loudly on a section that is not an object", () => {
    const root = manifest("package.json", { dependencies: "nope" });
    assert.throws(() => findUnpinned([root]), /not an object/);
  });
});

describe("bunfigWritesExact", () => {
  it("finds exact = true under [install]", () => {
    assert.equal(bunfigWritesExact("[install]\nexact = true\n"), true);
    assert.equal(
      bunfigWritesExact("[install]\nminimumReleaseAge = 1\nexact=true # yes\n"),
      true,
    );
  });

  it("rejects a missing, false, commented or misplaced setting", () => {
    assert.equal(
      bunfigWritesExact("[install]\nminimumReleaseAge = 1\n"),
      false,
    );
    assert.equal(bunfigWritesExact("[install]\nexact = false\n"), false);
    assert.equal(bunfigWritesExact("[install]\n# exact = true\n"), false);
    assert.equal(bunfigWritesExact("[test]\nexact = true\n"), false);
  });
});

describe("npmrcSavesExact", () => {
  it("finds save-exact=true", () => {
    assert.equal(npmrcSavesExact("save-exact=true\n"), true);
    assert.equal(
      npmrcSavesExact(
        "registry=https://registry.npmjs.org/\nsave-exact = true\n",
      ),
      true,
    );
  });

  it("rejects a missing, false or commented setting", () => {
    assert.equal(npmrcSavesExact(""), false);
    assert.equal(npmrcSavesExact("save-exact=false\n"), false);
    assert.equal(npmrcSavesExact("# save-exact=true\n"), false);
  });

  it("uses the last assignment, as npm does", () => {
    assert.equal(npmrcSavesExact("save-exact=true\nsave-exact=false\n"), false);
    assert.equal(npmrcSavesExact("save-exact=false\nsave-exact=true\n"), true);
  });

  it("ignores an assignment under a section header", () => {
    assert.equal(npmrcSavesExact("[install]\nsave-exact=true\n"), false);
    assert.equal(
      npmrcSavesExact("save-exact=true\n[install]\nsave-exact=false\n"),
      true,
    );
  });
});

describe("installConfigProblems", () => {
  const read = (files) => (path) => files[path];
  const projects = [
    manifest("package.json", {}),
    manifest("scripts/package.json", {}),
  ];

  it("accepts exact settings next to each lockfile", () => {
    const files = {
      "bun.lock": "",
      "bunfig.toml": "[install]\nexact = true\n",
      "scripts/package-lock.json": "{}",
      "scripts/.npmrc": "save-exact=true\n",
    };
    assert.deepEqual(installConfigProblems(projects, read(files)), []);
  });

  it("reports a nested npm project without save-exact", () => {
    const files = {
      "bun.lock": "",
      "bunfig.toml": "[install]\nexact = true\n",
      "scripts/package-lock.json": "{}",
    };
    const problems = installConfigProblems(projects, read(files));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^scripts\/\.npmrc must set/);
  });

  it("reports a bun project whose bunfig does not set exact", () => {
    const files = { "bun.lock": "", "bunfig.toml": "[install]\n" };
    const problems = installConfigProblems(projects, read(files));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^bunfig\.toml must set/);
  });

  it("ignores a project with no lockfile", () => {
    assert.deepEqual(installConfigProblems(projects, read({})), []);
  });
});
