#!/usr/bin/env bun

import { resolve } from "path";
import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { map } from "./mapper.ts";
import {
  formatTable,
  formatJson,
  formatMarkdown,
  formatNdjson,
} from "./format.ts";
import type { FrameworkId, MapResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Exit codes — 0 success, 1 runtime error, 2 usage error
// ---------------------------------------------------------------------------

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

type OutputFormat = "table" | "json" | "ndjson" | "markdown";

const FORMATTERS: Record<OutputFormat, (r: MapResult) => string> = {
  table: formatTable,
  json: formatJson,
  ndjson: formatNdjson,
  markdown: formatMarkdown,
};

const USAGE = `
  surface — discover HTTP endpoints in source code

  Usage:
    surface map <target>

  Output formats:
    --json                Structured JSON with summary (for tools & agents)
    --ndjson              One JSON object per line (for streaming/piping)
    --markdown            Markdown table

  Options:
    --framework <name>    Force a specific framework
    --include-internal    Include internal routes (/health, /metrics, etc.)
    -o, --output <path>   Write output to a file
    -h, --help            Show this help

  Examples:
    surface map ./my-project
    surface map ./my-project --json
    surface map ./my-project --ndjson | jq 'select(.method == "POST")'
    surface map https://github.com/owner/repo --framework express

  Exit codes:
    0  Success
    1  Runtime error (git clone failed, scan error, etc.)
    2  Usage error (bad arguments, missing target, unknown command)
`;

// ---------------------------------------------------------------------------
// Arg parsing — validates at the boundary, returns typed result
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command?: string;
  target?: string;
  framework?: FrameworkId;
  includeInternal: boolean;
  format: OutputFormat;
  output?: string;
  help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    includeInternal: false,
    format: "table",
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else if (arg === "--json") {
      parsed.format = "json";
    } else if (arg === "--ndjson") {
      parsed.format = "ndjson";
    } else if (arg === "--markdown") {
      parsed.format = "markdown";
    } else if (arg === "--include-internal") {
      parsed.includeInternal = true;
    } else if (arg === "--framework" && i + 1 < args.length) {
      parsed.framework = args[++i] as FrameworkId;
    } else if ((arg === "-o" || arg === "--output") && i + 1 < args.length) {
      parsed.output = args[++i];
    } else if (!parsed.command) {
      parsed.command = arg;
    } else if (!parsed.target) {
      parsed.target = arg;
    }

    i++;
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Target resolution — local path or git clone
// ---------------------------------------------------------------------------

function resolveTarget(target: string): { path: string; cleanup?: () => void } {
  if (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("git@")
  ) {
    const tmp = mkdtempSync(join(tmpdir(), "surface_"));
    const repoDir = join(tmp, "repo");
    console.error("Cloning repository...");
    try {
      execFileSync("git", ["clone", "--depth=1", target, repoDir], {
        stdio: "pipe",
      });
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      const msg =
        e instanceof Error ? e.message : "git clone failed for unknown reason";
      console.error(`Error: failed to clone ${target}\n  ${msg}`);
      process.exit(EXIT_ERROR);
    }
    return {
      path: repoDir,
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
  }

  const resolved = resolve(target);
  if (!existsSync(resolved)) {
    console.error(`Error: path does not exist: ${resolved}`);
    process.exit(EXIT_ERROR);
  }
  return { path: resolved };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.command) {
    console.log(USAGE);
    process.exit(EXIT_OK);
  }

  if (args.command !== "map") {
    console.error(`Unknown command: ${args.command}`);
    console.error(USAGE);
    process.exit(EXIT_USAGE);
  }

  if (!args.target) {
    console.error("Error: target path or URL required");
    console.error(USAGE);
    process.exit(EXIT_USAGE);
  }

  const { path, cleanup } = resolveTarget(args.target);

  try {
    const result = map(path, {
      frameworkOverride: args.framework,
      includeInternal: args.includeInternal,
    });

    const output = FORMATTERS[args.format](result);

    if (args.output) {
      Bun.write(args.output, output);
      console.error(`Results saved to ${args.output}`);
    } else {
      console.log(output);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: scan failed\n  ${msg}`);
    process.exit(EXIT_ERROR);
  } finally {
    cleanup?.();
  }
}

main();
