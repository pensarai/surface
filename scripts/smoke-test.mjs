// Smoke test: import the published bundle, run map() against a tiny fixture,
// and confirm we get a non-empty endpoint set.
//
// Runs under Node (the consumer runtime). Gates `prepublishOnly` and CI so a
// broken dist/ cannot reach npm.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, "..", "dist", "index.js");

if (!existsSync(distEntry)) {
  console.error(
    `smoke-test: dist/index.js missing — run \`npm run build\` first`,
  );
  process.exit(1);
}

const { map } = await import(distEntry);

if (typeof map !== "function") {
  console.error(`smoke-test: expected map to be a function, got ${typeof map}`);
  process.exit(1);
}

const fixture = resolve(here, "fixtures", "tiny-express");
const result = map(fixture);

if (!result || typeof result !== "object") {
  console.error(`smoke-test: map() returned non-object: ${result}`);
  process.exit(1);
}

const endpoints = result.endpoints;
const count = endpoints?.size ?? endpoints?.length ?? 0;

if (count === 0) {
  console.error(
    `smoke-test: expected at least one endpoint from tiny-express fixture, got 0`,
  );
  console.error(`  result keys: ${Object.keys(result).join(", ")}`);
  process.exit(1);
}

console.log(
  `smoke-test: OK — found ${count} endpoint(s) in tiny-express fixture`,
);
