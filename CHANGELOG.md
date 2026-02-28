# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
