---
title: Database Design
description: How pg-ratelimit uses PostgreSQL tables for rate limiting.
---

## Two-table design

pg-ratelimit uses two tables with different durability guarantees:

- **`rate_limit_ephemeral`** - `UNLOGGED`. Spam/abuse protection. Faster writes, data lost on crash.
- **`rate_limit_durable`** - Logged. Billing/quota tracking. Survives crashes.

The `durable` option in `RatelimitConfig` controls which table is used:

```typescript
// Uses rate_limit_ephemeral (default)
new Ratelimit({ pool, limiter: algo, prefix: "spam", durable: false });

// Uses rate_limit_durable
new Ratelimit({ pool, limiter: algo, prefix: "billing", durable: true });
```

### Why UNLOGGED?

PostgreSQL `UNLOGGED` tables skip write-ahead log (WAL) writes, making them significantly faster. The tradeoff is that data is lost if the server crashes. For rate limiting spam protection, this is fine - a crash effectively resets everyone's counters, which is acceptable.

For billing or quota tracking where you need to survive crashes, use `durable: true`.

### `synchronousCommit`

Even with the durable table, the library defaults to `SET LOCAL synchronous_commit = off` in transactions. This tells PostgreSQL not to wait for WAL to flush to disk before confirming the commit - a significant performance gain.

The tradeoff is small: on a crash you may lose the last ~few hundred milliseconds of committed writes. For rate limiting this is almost always fine. If you need strict durability guarantees, set `synchronousCommit: true`:

```typescript
new Ratelimit({
  pool,
  limiter: algo,
  prefix: "billing",
  durable: true,
  synchronousCommit: true, // wait for WAL flush
});
```

This option has no effect when `durable: false` since UNLOGGED tables don't write WAL at all.

This option only applies to sliding window and token bucket, which use transactions (`BEGIN`/`COMMIT`). Fixed window uses a single atomic statement with no transaction, so `SET LOCAL` has nowhere to apply. This is fine - fixed window is already the fastest path.

:::tip[Pool sizing]
Consider using a small dedicated pool for rate limiting (e.g., `new Pool({ connectionString, max: 5 })`) rather than sharing your application's main pool. Sliding window and token bucket hold brief transactions with row locks - a separate pool prevents rate limiting from competing with application queries.
:::

## Schema

Both tables share the same schema. Each algorithm uses different columns - unused columns are `NULL`.

```sql
CREATE UNLOGGED TABLE IF NOT EXISTS rate_limit_ephemeral (
  prefix       TEXT NOT NULL,
  key          TEXT NOT NULL,
  count        BIGINT,
  prev_count   BIGINT,
  window_start TIMESTAMPTZ,
  tokens       DOUBLE PRECISION,
  last_refill  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (prefix, key)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_ephemeral_cleanup
  ON rate_limit_ephemeral (prefix, expires_at);

CREATE TABLE IF NOT EXISTS rate_limit_durable (
  prefix       TEXT NOT NULL,
  key          TEXT NOT NULL,
  count        BIGINT,
  prev_count   BIGINT,
  window_start TIMESTAMPTZ,
  tokens       DOUBLE PRECISION,
  last_refill  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (prefix, key)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_durable_cleanup
  ON rate_limit_durable (prefix, expires_at);
```

### Columns by algorithm

| Column         | Fixed Window               | Sliding Window                | Token Bucket                |
| -------------- | -------------------------- | ----------------------------- | --------------------------- |
| `prefix`       | limiter namespace          | limiter namespace             | limiter namespace           |
| `key`          | rate limit subject         | rate limit subject            | rate limit subject          |
| `count`        | requests in current window | current window count          | -                           |
| `prev_count`   | -                          | previous window count         | -                           |
| `window_start` | when window began          | current window start          | -                           |
| `tokens`       | -                          | -                             | current token count (float) |
| `last_refill`  | -                          | -                             | timestamp of last refill    |
| `expires_at`   | window expiry              | 2x window (covers prev_count) | bucket TTL                  |

### Indexes

- **`PRIMARY KEY (prefix, key)`** - composite PK doubles as the lookup index for `limit()` queries. Two different limiters can rate limit the same key (e.g., `user:123`) without collision.
- **`(prefix, expires_at)`** - efficient inline cleanup of expired rows, scoped per prefix

## Key format

`prefix` and `key` are separate columns - not concatenated into a single string. Lookups use `WHERE prefix = $1 AND key = $2`, which hits the composite primary key directly.

```
new Ratelimit({ pool, ..., prefix: 'api' })
  → ratelimit.limit('user:123')
  → stored as prefix='api', key='user:123'

new Ratelimit({ pool, ..., prefix: 'upload' })
  → ratelimit.limit('user:123')
  → stored as prefix='upload', key='user:123'
```

Both rows coexist - no collision.

## Auto-migration

Tables are created automatically via `CREATE TABLE IF NOT EXISTS` on first use. This is:

- **Idempotent** - safe to run multiple times
- **Serverless-safe** - runs on every cold start, but `IF NOT EXISTS` makes it a no-op after the first time
- **Optimized** - a module-level `WeakSet<Pool>` tracks which pools have been initialized, preventing re-running the SQL in long-running servers

### Disabling auto-migration

Set `PG_RATELIMIT_DISABLE_AUTO_MIGRATE=true` to skip automatic table creation. Then create the tables yourself using the exported SQL:

```typescript
import { TABLE_SQL } from "pg-ratelimit";

// In your migration file
export async function up(pool) {
  await pool.query(TABLE_SQL);
}
```

## Cleanup strategy

pg-ratelimit uses probabilistic inline cleanup - each `limit()` call has a 10% chance of deleting expired rows for its own prefix:

```sql
-- Runs against whichever table the limiter uses (ephemeral or durable)
DELETE FROM rate_limit_ephemeral -- or rate_limit_durable
WHERE prefix = $1 AND expires_at < $now
```

This approach is:

- **Self-cleaning** - each limiter cleans up its own data
- **Serverless-safe** - no background intervals or singletons
- **Scoped** - only deletes rows matching the limiter's prefix, using the cleanup index
- **Low overhead** - only ~10% of `limit()` calls run the cleanup query, and expired rows are cleaned incrementally, not in bulk
- **Concurrency-friendly** - under high concurrency, fewer callers compete to delete the same expired rows

The default probability of `0.1` (10%) keeps cleanup overhead minimal while ensuring expired rows don't accumulate. Tune it via `cleanupProbability`:

```typescript
new Ratelimit({
  pool,
  limiter: algo,
  prefix: "api",
  cleanupProbability: 0.5, // run cleanup 50% of the time
});
```

Set to `1` to clean on every call (useful in tests), or `0` to disable entirely if you handle cleanup externally.

If a limiter stops being called, only its rows linger - but rows are small (two TEXT columns + a few numbers), so this is fine for most use cases. To clean up retired prefixes, use the global DELETE below or schedule it via `pg_cron` or a deploy hook.

:::tip[Retired prefixes]
Inline cleanup only runs per-prefix during `limit()` calls. If a prefix is retired (e.g. you remove the limiter from your code), its expired rows won't be cleaned up automatically. Run a periodic global cleanup:

```sql
DELETE FROM rate_limit_ephemeral WHERE expires_at < now();
DELETE FROM rate_limit_durable WHERE expires_at < now();
```

:::

## Reducing database load with in-memory blocking

Under sustained traffic, most rate-limited requests are repeated 429s for keys that are already blocked. Each of these still executes a full SQL round trip even though the answer is already known. The `inMemoryBlock` option caches blocked keys in the Node.js process so these requests never reach PostgreSQL:

```typescript
const ratelimit = new Ratelimit({
  pool,
  limiter: Ratelimit.fixedWindow(100, "1m"),
  prefix: "api",
  inMemoryBlock: true,
});
```

With this enabled, blocked keys are served from an in-process `Map` until their reset time passes. This dramatically reduces query volume and latency under load - in benchmarks, average latency drops significantly because the majority of requests skip the database entirely.

:::caution
In multi-process deployments, a refund (`rate: -1`) or `resetUsedTokens()` on one server won't clear the cached block on other servers. Those servers will keep serving stale 429s until the cached reset time expires. If you use refunds and run multiple processes, consider whether this staleness is acceptable for your use case.
:::

See the [API reference](../api-reference/#in-memory-blocking) for configuration details.
