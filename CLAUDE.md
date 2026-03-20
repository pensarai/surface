# Surface

White-box endpoint discovery for source code. Scans repositories to extract HTTP routes, API endpoints, and entrypoints across 16 web frameworks.

## Commands

```bash
# Run CLI
bun run src/cli.ts map <target>
bun run src/cli.ts map <target> --json
bun run src/cli.ts map <target> --ndjson
bun run src/cli.ts map <target> --markdown
bun run src/cli.ts map <target> --framework express
bun run src/cli.ts map <target> --include-internal
bun run src/cli.ts map <target> -o endpoints.json --json

# Programmatic API
import { map, EndpointIndex } from "./src/index.ts";

# Tests
bun test

# Type check, lint, format
bun run tsc
bun run lint
bun run format:check
```

## Architecture

```
src/
├── index.ts              Public API — stable contract for consumers
├── cli.ts                CLI entry point, arg parsing, exit codes
├── types.ts              Core types: EndpointInfo, MapResult, Extractor, ScanContext
├── endpoint-index.ts     Lazy multi-index over endpoints (by framework, file, method)
├── mapper.ts             Framework detection dispatch + extraction orchestration
├── scan-context.ts       File system walker with content cache + file index
├── utils.ts              Path normalization, auth detection, line index, endpoint factory
├── format.ts             Output formatters (table, JSON, NDJSON, markdown)
└── extractors/
    ├── index.ts           Extractor registry
    └── <framework>.ts     One file per framework (14 files + go.ts exports 4)
```

## Design Principles

These were applied throughout the codebase and should guide all future changes.

### Parse, don't validate

Push validation to the boundary. `EndpointInfo` has typed `file: string` + `line: number` fields, not a `location: string` that consumers parse. The CLI validates args at the boundary; internal code operates on correct-by-construction objects.

### Data over code

Framework detection is declarative. Each extractor declares a `detect` property (dep keywords + marker files), not imperative detection logic. The mapper dispatches generically. Adding a framework is a single file — no mapper changes needed.

### Single source of truth

`SKIP_DIRS` is defined once in scan-context.ts and imported everywhere. The file index is built once and cached. Dep content is lowercased once. There is exactly one place where each piece of knowledge lives.

### Lazy computation, cache everything

- File index: built on first `iterFiles()` call, cached for all subsequent calls
- Content cache: read-through, every file read from disk at most once
- EndpointIndex: lazy indexes by framework, file, method — built on first access, reused across all formatters
- Line index: `buildLineIndex()` precomputes line offsets once per file for O(log n) lookups

### Thin glue

The mapper is ~60 lines of orchestration. Extractors are self-contained. Formatters are pure functions over `MapResult`. The CLI is just arg parsing → `map()` → formatter → stdout. No layer knows about another's internals.

### Explicit boundaries

`src/index.ts` is the public API. Internal modules (extractors, scan-context, utils) are implementation details. Consumers import from the entry point, not from internal files.

## Performance Invariants

- **File walks**: O(n) where n = files in repo. Done once, cached in the file index.
- **File reads**: Each file read from disk at most once. Content cache is a `Map<path, string>`.
- **Line lookups**: O(log n) via binary search over precomputed line offsets. Never O(n) per match.
- **Endpoint indexing**: Framework/file/method indexes built in one pass on first access, then O(1) lookups.
- **Detection**: Dep files read once, lowercased once. Child dirs listed once. No per-extractor I/O.
- **No lock files**: `package-lock.json` excluded from dep scanning — can be 10MB+.

## Security Invariants

- **Symlink traversal**: All directory walkers (scan-context, nextjs, server-actions) use `lstatSync` + `realpathSync` to detect symlinks and verify resolved paths stay within the repo root.
- **No shell injection**: Git clone uses `execFileSync` with array args, not string interpolation.
- **NO_COLOR/TTY**: Output respects `NO_COLOR`, `FORCE_COLOR`, and `process.stdout.isTTY`. No ANSI codes in piped output.

## Exit Codes

- `0` — Success
- `1` — Runtime error (clone failure, scan error, path not found)
- `2` — Usage error (unknown command, missing target)

## Adding a New Framework

Single-file operation:

1. Create `src/extractors/<framework>.ts`
2. Export an `Extractor` object with `id`, `detect`, and `extract`
3. Register it in `src/extractors/index.ts`

The `detect` property can be declarative (dep keywords + markers) or a custom function. The mapper handles dispatch automatically — no detection code needed in mapper.ts.

```typescript
export const myFramework: Extractor = {
  id: "my_framework",
  detect: { depKeywords: ["my-framework"], markers: [], scope: "root" },
  extract(ctx) {
    // ...
  },
};
```

## Supported Frameworks

Flask, FastAPI, Django, Express, NestJS, Next.js (App Router + Pages Router),
Gin, Echo, Fiber, Go net/http, Spring Boot, Rails, Laravel, SST, Server Actions, OpenAPI specs.
