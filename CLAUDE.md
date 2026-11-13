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

## GitHub Actions — pinned to a commit SHA

A tag such as `@v4` can be repointed by whoever controls the action's repository, and the next run then executes their code with this repository's npm publish credentials. So nothing a workflow runs is referenced by a movable name. The `zizmor` job in `.github/workflows/ci.yml` enforces this on every PR (config: `.github/zizmor.yml`).

- **Actions are pinned to a full commit SHA with the full version in a comment**: `uses: owner/repo@<40-character SHA> # v4.2.2`. This includes GitHub's own `actions/*`. The comment must be the release the SHA belongs to (`# v4` is rejected); upgrade tooling and the advisory check read the version from it.
- **Container images** (`container:`, `services.*.image`, `docker://`) carry a digest: `name:tag@sha256:<digest>`.
- **Find the SHA from the release tag**: `gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object`. When `.type` is `tag`, follow it with `gh api repos/<owner>/<repo>/git/tags/<sha> --jq .object.sha`. Pin a release that has been out for at least 7 days.
- **Reach for `gh` or a few lines of shell before adding a third-party action.** Every action is code that runs with the job's token.
- **Check locally** with `zizmor --pedantic .` (`brew install zizmor`). Set `GH_TOKEN` to include the checks that need the GitHub API.
- **Permissions start empty.** Every workflow sets `permissions: {}`, and each job lists only what it uses. Each write, `id-token` or non-`contents` grant carries a comment saying what needs it: `contents: write # creates the release and its tag`.
- **Expressions never go inside a script.** Pass `${{ … }}` values to `run:` steps through `env:` and quote them (`"$VERSION"`). Default variables like `$GITHUB_EVENT_NAME` and `$GITHUB_SHA` are already in the environment.
- **Checkouts set `persist-credentials: false`** unless a later step runs git against the remote. Prefer `gh api` or `gh release` for tags and releases, which need no saved credential.
- **CI workflows set a `concurrency` group** that cancels superseded PR runs. A release or publish workflow uses a group that queues instead of cancelling.
- **Never disable an audit or add an ignore to get a check green.** Each ignore in `.github/zizmor.yml` or inline `# zizmor: ignore[...]` comment says why the finding is safe. A new one needs the same, and a review. Otherwise fix the finding, or ask.

## Dependencies — exact versions

`bun.lock` pins what CI installs. `package.json` pins what we ask for: every version is exact, so a version only changes when a diff says so. A range such as `^1.2.3` lets `bun add <pkg>`, `bun update` or a regenerated lockfile pull a release nobody chose, and a compromised release arrives the same way. `node scripts/check-dependency-pins.mjs` enforces this in CI.

- **Versions are exact**: `"left-pad": "1.3.0"`, never `^`, `~`, `*`, `latest` or a tag. This covers `dependencies`, `devDependencies`, `optionalDependencies` and `overrides`. `bun add <pkg>` writes an exact version because `bunfig.toml` sets `exact = true`; do not remove that setting.
- **The one exception is a package in this repository's own workspace**, which is referenced with `workspace:*`. The check rejects an exact version there. There are no workspace packages today.
- **`peerDependencies` stay ranges.** They describe what a consumer may bring, not what we install.
- **This package is published.** Everyone who installs it gets its `dependencies` at exactly these versions, so keep them few, and ship a release when one of them needs a security fix.
- **To change a version**, edit it (or `bun add <pkg>@<version>`), run `bun install`, and read the `bun.lock` diff: it should show that package and what it pulled in, nothing else.
- **Do not work around the release-age gate.** `bunfig.toml` refuses packages published too recently (`minimumReleaseAge`). If an install fails on it, pick an older version; do not lower the setting or add an exclusion without asking.
- **Before adding a dependency**, check that a few lines of our own code would not do, that the package is maintained and widely used, and whether it runs an install script. Bun runs install scripts only for trusted packages. With no `trustedDependencies` in `package.json`, as here today, those are the packages on Bun's built-in default list (`bun pm default-trusted`). Defining `trustedDependencies` replaces that list, so the first time one is added, also list every default-trusted package we still need. A trusted package runs code on every machine that installs, so say why in the PR.
- **Run tools from the lockfile**: after `bun install`, `bunx <tool>` runs the installed, pinned version of a package we depend on. If the package is not installed, `bunx` downloads whatever version is current, so install first or name the version (`bunx <tool>@<version>`). Do not `bunx` or `npx` a package that is not in `bun.lock`.
