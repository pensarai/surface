# Surface

White-box endpoint discovery for source code repositories. Scans codebases to extract HTTP endpoints, API routes, server actions, and other entrypoints by detecting web frameworks and parsing route registrations.

## What it does

Given a repository, Surface:

1. **Detects frameworks** — reads dependency files (`package.json`, `requirements.txt`, `go.mod`, etc.) and marker files to identify which web frameworks are in use
2. **Extracts endpoints** — parses route decorators, file-based routing conventions, controller annotations, and infrastructure-as-code definitions
3. **Outputs a map** — structured list of every discovered endpoint with method, path, handler, source location, auth decorators, and parameters

## Supported frameworks

| Language              | Frameworks                                                                |
| --------------------- | ------------------------------------------------------------------------- |
| Python                | Flask, FastAPI, Django (+ DRF)                                            |
| JavaScript/TypeScript | Express, NestJS, Next.js (App Router + Pages Router), SST, Server Actions |
| Go                    | Gin, Echo, Fiber, net/http                                                |
| Java/Kotlin           | Spring Boot                                                               |
| Ruby                  | Rails                                                                     |
| PHP                   | Laravel                                                                   |
| Specs                 | OpenAPI / Swagger (JSON + YAML)                                           |

## Install

```bash
# Global CLI
npm install -g @pensar/surface
# or
bun add -g @pensar/surface

# As a library
npm install @pensar/surface
```

## Usage

```bash
# Scan a local repository
surface map ./my-project

# Scan a remote repository
surface map https://github.com/owner/repo

# Force a specific framework
surface map ./app --framework flask

# Include internal routes (/health, /metrics, etc.)
surface map ./app --include-internal
```

## Output formats

```bash
# Table (default) — grouped by framework, colored, human-readable
surface map ./app

# JSON — structured with summary stats, for tools and dashboards
surface map ./app --json

# NDJSON — one JSON object per line, for streaming and piping
surface map ./app --ndjson

# Markdown — grouped tables, for docs and reports
surface map ./app --markdown

# Write to file
surface map ./app --json -o endpoints.json
```

### NDJSON for agents and pipelines

The `--ndjson` format outputs one JSON object per line. The first line is metadata, followed by one line per endpoint. This is ideal for `jq`, `grep`, and piping into other tools:

```bash
# Find all POST endpoints
surface map ./app --ndjson | jq 'select(.method == "POST")'

# List paths only
surface map ./app --ndjson | jq -r 'select(.path) | .path'

# Count endpoints per framework
surface map ./app --ndjson | jq -r 'select(.path) | .framework' | sort | uniq -c
```

### JSON schema

The `--json` output includes a summary block for quick consumption:

```json
{
  "$schema": "surface/v1",
  "target": "/path/to/repo",
  "summary": {
    "total": 68,
    "filesScanned": 46,
    "byFramework": { "nextjs": 13, "sst": 11, "server_action": 44 },
    "byMethod": { "GET": 14, "POST": 10, "ACTION": 44 }
  },
  "endpoints": [...]
}
```

## Programmatic API

```ts
import { map, type MapResult, type EndpointInfo } from "@pensar/surface";

const result: MapResult = map("./my-project", { includeInternal: false });

for (const endpoint of result.endpoints) {
  console.log(`${endpoint.method} ${endpoint.path} (${endpoint.framework})`);
}
```

The package exports `map`, `impact`, `detectServices`, `findFunctions`, the formatters (`formatTable`, `formatJson`, `formatNdjson`, `formatMarkdown`, plus their `formatImpact*` siblings), and all public types from `src/index.ts`.

## Development

Requires [Bun](https://bun.sh).

```bash
# Install dependencies
bun install

# Run directly
bun run src/cli.ts map ./some-repo

# Type check
bun run tsc

# Lint
bun run lint

# Format check
bun run format:check

# Build the npm publish bundle (dist/)
bun run build

# Smoke-test the built bundle
bun run test:smoke
```

## Architecture

```
src/
├── cli.ts              CLI entry point, arg parsing
├── mapper.ts           Framework detection + orchestration
├── scan-context.ts     File system walker with caching
├── types.ts            Core types: EndpointInfo, Extractor interface
├── utils.ts            Path normalization, auth detection, param extraction
├── format.ts           Output formatters (table, JSON, NDJSON, markdown)
└── extractors/
    ├── index.ts         Extractor registry
    ├── flask.ts         Flask (blueprints, route decorators)
    ├── fastapi.ts       FastAPI (APIRouter, include_router)
    ├── django.ts        Django (urlpatterns, DRF api_view)
    ├── express.ts       Express (router mounts, route handlers)
    ├── nestjs.ts        NestJS (controller decorators, guards)
    ├── nextjs.ts        Next.js (App Router routes, Pages API)
    ├── go.ts            Gin, Echo, Fiber, net/http
    ├── spring.ts        Spring Boot (RequestMapping, GetMapping, etc.)
    ├── rails.ts         Rails (routes.rb, resources)
    ├── laravel.ts       Laravel (Route::, prefix groups)
    ├── sst.ts           SST (API Gateway route definitions)
    ├── server-actions.ts Next.js Server Actions ('use server')
    └── openapi.ts       OpenAPI/Swagger spec parsing
```

Each extractor implements the `Extractor` interface — a single `extract(ctx)` method that receives a `ScanContext` (file system abstraction with caching) and returns `EndpointInfo[]`. Adding a new framework means creating one file and registering it.
