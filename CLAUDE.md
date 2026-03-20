# Surface

Discover HTTP endpoints and entrypoints in source code repositories.

## Commands

```bash
# Run CLI
bun run src/cli.ts map <target>
bun run src/cli.ts map <target> --json
bun run src/cli.ts map <target> --markdown
bun run src/cli.ts map <target> --framework express
bun run src/cli.ts map <target> --include-internal
bun run src/cli.ts map <target> -o endpoints.json --json

# Tests
bun test

# Type check
bunx tsc --noEmit
```

## Architecture

- **src/types.ts** — Core types: `EndpointInfo`, `MapResult`, `ScanContext`, `Extractor` interface
- **src/scan-context.ts** — File system abstraction: walks repo, caches file contents, indexes by extension
- **src/utils.ts** — Shared utilities: path normalization, auth decorator detection, path param extraction
- **src/mapper.ts** — Main orchestrator: framework detection + runs extractors + dedup/sort
- **src/extractors/** — One file per framework, each exports an `Extractor`. Registry in `index.ts`
- **src/format.ts** — Output formatters: table (ANSI), JSON, Markdown
- **src/cli.ts** — CLI entry point, arg parsing

## Supported Frameworks

Flask, FastAPI, Django, Express, NestJS, Next.js (App Router + Pages Router),
Gin, Echo, Fiber, Go net/http, Spring Boot, Rails, Laravel, SST, Server Actions, OpenAPI specs.

## Adding a New Extractor

1. Create `src/extractors/<framework>.ts` implementing the `Extractor` interface
2. Register it in `src/extractors/index.ts`
3. Add framework detection logic in `src/mapper.ts` `detectFrameworks()`
