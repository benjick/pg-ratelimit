# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-03-01

### Added

- In-memory block strategy - cache blocked keys in-process to skip DB round trips for repeated 429s. Enable with `inMemoryBlock: true`. Reduces average latency by ~50% and doubles throughput under load.
- `maxBlockedKeys` option (default: 10,000) caps cache size with automatic expired-entry sweeping.
- `InMemoryBlockConfig` and `DurableConfig` discriminated union types. `maxBlockedKeys` is now a type error unless `inMemoryBlock: true` is set.
- Benchmark package comparing throughput and latency with and without `inMemoryBlock`.

### Fixed

- All internal doc links used absolute paths missing the `/pg-ratelimit` base, causing 404s on the deployed site.

## [0.1.0] - 2026-03-01

### Added

- Three rate limiting algorithms: fixed window, sliding window, and token bucket
- `limit()` - check and consume rate limit tokens
- `blockUntilReady()` - poll until success or timeout
- `getRemaining()` - read remaining quota without consuming
- `resetUsedTokens()` - full reset of a key's quota
- Two-table design: ephemeral (UNLOGGED) for speed, durable (logged) for crash safety
- Weighted costs via `rate` option
- Negative rate for token refunds
- Probabilistic inline cleanup of expired rows
- Injectable clock for deterministic testing
- `TABLE_SQL` export for manual migration
- Auto-migration with `CREATE TABLE IF NOT EXISTS` (disable via `PG_RATELIMIT_DISABLE_AUTO_MIGRATE`)
- `synchronousCommit` option for durable mode

### Fixed

- Sliding window no longer consumes tokens on denied requests
