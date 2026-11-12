import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bunfigWritesExact,
  findUnpinned,
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
    const lib = manifest("packages/lib/package.json", { name: "@scope/lib" });
    const app = manifest("app/package.json", {
      name: "app",
      dependencies: { "@scope/lib": "workspace:*" },
    });
    assert.deepEqual(findUnpinned([lib, app]), []);

    for (const spec of ["*", "1.0.0", "workspace:^"]) {
      const loose = manifest("app/package.json", {
        dependencies: { "@scope/lib": spec },
      });
      const [violation] = findUnpinned([lib, loose]);
      assert.equal(violation.name, "@scope/lib");
      assert.equal(violation.fix, "use `workspace:*`");
    }
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
});
