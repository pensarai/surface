#!/usr/bin/env bun

import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
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
import {
  formatImpactTable,
  formatImpactJson,
  formatImpactNdjson,
  formatImpactMarkdown,
} from "./format-impact.ts";
import type { GroupBy, FormatOptions } from "./format.ts";
import type { FrameworkId, ImpactResult, MapResult } from "./types.ts";
import { EndpointIndex } from "./endpoint-index.ts";
import { parseDiff } from "./diff.ts";
import { impact } from "./impact.ts";

// ---------------------------------------------------------------------------
// Exit codes — 0 success, 1 runtime error, 2 usage error
// ---------------------------------------------------------------------------

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

type OutputFormat = "table" | "json" | "ndjson" | "markdown";

type Formatter = (r: MapResult, o?: FormatOptions) => string;

const FORMATTERS: Record<OutputFormat, Formatter> = {
  table: formatTable,
  json: formatJson,
  ndjson: formatNdjson,
  markdown: formatMarkdown,
};

type ImpactFormatter = (r: ImpactResult) => string;

const IMPACT_FORMATTERS: Record<OutputFormat, ImpactFormatter> = {
  table: formatImpactTable,
  json: formatImpactJson,
  ndjson: formatImpactNdjson,
  markdown: formatImpactMarkdown,
};

const USAGE = `
  surface — discover HTTP endpoints in source code

  Commands:
    surface map <target>                  Discover all endpoints
    surface diff <target> --base <ref>     Find endpoints affected by a diff

  Output formats:
    --json                Structured JSON with summary (for tools & agents)
    --ndjson              One JSON object per line (for streaming/piping)
    --markdown            Markdown table

  Map options:
    --framework <name>    Force a specific framework
    --group-by <key>      Group output by: auto, service, framework (default: auto)
    --service <name>      Show only endpoints from a specific service
    --include-internal    Include internal routes (/health, /metrics, etc.)
    -o, --output <path>   Write output to a file

  Diff options:
    --base <ref>          Base ref to compare from (commit, branch, tag)
    --head <ref>          Head ref to compare to (default: HEAD)
    --ref <git-ref>       Single ref (shorthand, e.g. main, HEAD~3, sha1..sha2)
    --diff-file <path>    Read diff from a file instead of git
    (stdin)               Pipe a diff: git diff main | surface diff .
    --framework <name>    Force a specific framework
    --include-internal    Include internal routes in results
    -o, --output <path>   Write output to a file

  General:
    -h, --help            Show this help

  Examples:
    surface map ./my-project
    surface map ./my-project --json
    surface map ./my-project --ndjson | jq 'select(.method == "POST")'
    surface map ./monorepo --group-by service
    surface diff . --base main --head feature-branch
    surface diff . --base abc123 --head def456 --json
    surface diff . --ref main
    surface diff . --ref HEAD~3 --json
    git diff main | surface diff . --json

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
  groupBy: GroupBy;
  serviceFilter?: string;
  includeInternal: boolean;
  format: OutputFormat;
  output?: string;
  ref?: string;
  base?: string;
  head?: string;
  diffFile?: string;
  help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    includeInternal: false,
    format: "table",
    groupBy: "auto",
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
    } else if (arg === "--group-by" && i + 1 < args.length) {
      const val = args[++i]!;
      if (val === "auto" || val === "service" || val === "framework") {
        parsed.groupBy = val;
      } else {
        console.error(
          `Error: --group-by must be auto, service, or framework (got "${val}")`,
        );
        process.exit(EXIT_USAGE);
      }
    } else if (arg === "--service" && i + 1 < args.length) {
      parsed.serviceFilter = args[++i];
    } else if (arg === "--ref" && i + 1 < args.length) {
      parsed.ref = args[++i];
    } else if (arg === "--base" && i + 1 < args.length) {
      parsed.base = args[++i];
    } else if (arg === "--head" && i + 1 < args.length) {
      parsed.head = args[++i];
    } else if (arg === "--diff-file" && i + 1 < args.length) {
      parsed.diffFile = args[++i];
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

  if (args.command !== "map" && args.command !== "diff") {
    console.error(`Unknown command: ${args.command}`);
    console.error(USAGE);
    process.exit(EXIT_USAGE);
  }

  if (!args.target) {
    console.error("Error: target path or URL required");
    console.error(USAGE);
    process.exit(EXIT_USAGE);
  }

  if (args.command === "diff") {
    runDiff(args);
  } else {
    runMap(args);
  }
}

function runMap(args: ParsedArgs) {
  const { path, cleanup } = resolveTarget(args.target!);

  try {
    const result = map(path, {
      frameworkOverride: args.framework,
      includeInternal: args.includeInternal,
    });

    // Apply --service filter
    let finalResult = result;
    if (args.serviceFilter) {
      const svcName = args.serviceFilter;
      const filtered = result.endpoints.all.filter(
        (ep) => ep.service === svcName,
      );
      finalResult = {
        ...result,
        endpoints: new EndpointIndex(filtered),
      };
    }

    const formatOpts: FormatOptions = { groupBy: args.groupBy };
    const output = FORMATTERS[args.format](finalResult, formatOpts);
    writeOutput(output, args.output);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: scan failed\n  ${msg}`);
    process.exit(EXIT_ERROR);
  } finally {
    cleanup?.();
  }
}

function runDiff(args: ParsedArgs) {
  const target = args.target!;

  // Git ref options are not supported with remote URLs (shallow clone has no history)
  const isRemote =
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("git@");
  if ((args.ref || args.base) && isRemote) {
    console.error(
      "Error: --ref/--base/--head are not supported with remote URLs (shallow clones lack history)",
    );
    console.error(
      "  Clone the repo locally first, then run: surface diff <path> --base <ref> --head <ref>",
    );
    process.exit(EXIT_USAGE);
  }

  const { path, cleanup } = resolveTarget(target);

  try {
    // Resolve diff text from one of three sources
    const diffText = resolveDiffText(args, path);
    if (!diffText) {
      console.error(
        "Error: no diff provided. Use --ref <git-ref>, --diff-file <path>, or pipe via stdin",
      );
      process.exit(EXIT_USAGE);
    }

    const hunks = parseDiff(diffText);
    const result = impact(path, hunks, {
      frameworkOverride: args.framework,
      includeInternal: args.includeInternal,
    });

    const output = IMPACT_FORMATTERS[args.format](result);
    writeOutput(output, args.output);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: diff analysis failed\n  ${msg}`);
    process.exit(EXIT_ERROR);
  } finally {
    cleanup?.();
  }
}

function resolveDiffText(args: ParsedArgs, targetPath: string): string | null {
  // Priority 1: --base/--head — compare two refs (commits, branches, tags)
  if (args.base) {
    const head = args.head ?? "HEAD";
    const range = `${args.base}..${head}`;
    try {
      return execFileSync("git", ["diff", args.base, head], {
        cwd: targetPath,
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: git diff failed for "${range}"\n  ${msg}`);
      process.exit(EXIT_ERROR);
    }
  }

  // Priority 2: --ref — single ref (diff against working tree, or range like main..HEAD)
  if (args.ref) {
    try {
      return execFileSync("git", ["diff", args.ref], {
        cwd: targetPath,
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: git diff failed for ref "${args.ref}"\n  ${msg}`);
      process.exit(EXIT_ERROR);
    }
  }

  // Priority 2: --diff-file
  if (args.diffFile) {
    const diffPath = resolve(args.diffFile);
    if (!existsSync(diffPath)) {
      console.error(`Error: diff file does not exist: ${diffPath}`);
      process.exit(EXIT_ERROR);
    }
    return readFileSync(diffPath, "utf-8");
  }

  // Priority 3: stdin (only if piped, not interactive)
  if (!process.stdin.isTTY) {
    try {
      return readFileSync("/dev/stdin", "utf-8");
    } catch {
      return null;
    }
  }

  return null;
}

function writeOutput(output: string, path?: string) {
  if (path) {
    writeFileSync(path, output);
    console.error(`Results saved to ${path}`);
  } else {
    console.log(output);
  }
}

main();
