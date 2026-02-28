# CLAUDE.md

pg-ratelimit is a PostgreSQL-backed rate limiting library for Node.js/TypeScript.

The documentation in `docs/src/content/docs/` is the source of truth for how the library should behave. Implementation should match the docs - if the code disagrees with the docs, the docs are correct.

## Build & Dev Commands

Monorepo using Turborepo + pnpm workspaces. Core library lives in `packages/pg-ratelimit/`.

```bash
pnpm install                    # install all dependencies
pnpm build                      # build all packages (turborepo)
pnpm test                       # run tests (requires Docker for testcontainers)
```

Bundled with tsup. TypeScript-first, ships types alongside.

## Core Library (`packages/pg-ratelimit/src/`)

- **`index.ts`** - Public API exports
- **`limiter.ts`** - `Ratelimit` class implementation
- **`algorithms/`** - One file per algorithm: `fixed-window.ts`, `sliding-window.ts`, `token-bucket.ts`
- **`tables.ts`** - `ensureTables()` (internal), `TABLE_SQL` export
- **`duration.ts`** - Duration template literal type + `toMs()` parser
- **`types.ts`** - All shared types

## Key Constraints

- Zero runtime deps beyond peer dep `pg: ^8.0.0`
- Raw parameterized SQL only - no ORM
- All SQL uses parameterized `$now` from injectable clock - never Postgres `now()`
- Negative `rate` values intentionally allowed, no clamping
- `remaining` clamped to `Math.max(0, ...)` but no ceiling clamp (negative rate can exceed max)
- Invalid/zero/negative durations throw
- Errors propagate directly from `pg` - no wrapping, no fail-open/fail-closed default
- `ensureTables()` tracks initialization per-pool via `WeakSet<Pool>`
- Cleanup is fire-and-forget after the main operation
