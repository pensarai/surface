// Post-build: prepend a shebang to the CLI entry and mark it executable.
// tsup's per-entry banner is awkward to drive from config — this is simpler.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "..", "dist", "cli.js");

const SHEBANG = "#!/usr/bin/env node\n";

const current = readFileSync(cliPath, "utf-8");
const stripped = current.startsWith("#!")
  ? current.slice(current.indexOf("\n") + 1)
  : current;
writeFileSync(cliPath, SHEBANG + stripped);
chmodSync(cliPath, 0o755);

console.log(`postbuild: shebang + +x applied to ${cliPath}`);
