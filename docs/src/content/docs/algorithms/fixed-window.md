---
title: Fixed Window
description: Simple time-bucketed rate limiting with atomic SQL operations.
---

## How it works

Fixed window divides time into discrete buckets (e.g., "this minute") and counts requests within each bucket. When the window rolls over, the count resets to zero.

```
Window 1 (00:00–01:00)     Window 2 (01:00–02:00)
├── req 1                  ├── req 1 (count resets)
├── req 2                  ├── req 2
├── ...                    └── ...
└── req 10 (limit reached)
```

### The boundary problem

A user can send the maximum number of requests at the end of one window and the beginning of the next, effectively doubling the rate for a short period. If your limit is 10/minute and a user sends 10 requests at 0:59 and 10 at 1:00, they've made 20 requests in 2 seconds.

If this matters for your use case, use [Sliding Window](/algorithms/sliding-window/) instead.

## SQL strategy

Fixed window uses a single atomic `INSERT ... ON CONFLICT DO UPDATE` statement. No transaction is needed - the atomicity of the single statement provides concurrency safety.

```sql
INSERT INTO rate_limit_ephemeral (prefix, key, count, window_start, expires_at)
VALUES ($prefix, $key, $rate, $now, $now + $window)
ON CONFLICT (prefix, key) DO UPDATE
  SET count = CASE
    WHEN rate_limit_ephemeral.expires_at < $now THEN $rate
    ELSE rate_limit_ephemeral.count + $rate
  END,
  window_start = CASE
    WHEN rate_limit_ephemeral.expires_at < $now THEN $now
    ELSE rate_limit_ephemeral.window_start
  END,
  expires_at = CASE
    WHEN rate_limit_ephemeral.expires_at < $now THEN $now + $window
    ELSE rate_limit_ephemeral.expires_at
  END
RETURNING count, expires_at
```

If the existing row has expired (`expires_at < $now`), the window is reset - `count`, `window_start`, and `expires_at` are all replaced with fresh values. Otherwise, `count` is incremented within the current window. If the returned count exceeds the token limit, the request is denied. The returned `expires_at` is used as the `reset` time.

:::note[Consumes on denial]
Fixed window increments the counter even when the request is denied. This is a side effect of the single atomic statement - there's no conditional branch within the SQL. In practice this doesn't affect correctness: `remaining` is clamped to 0 and the counter resets with the window. If your use case is sensitive to this (e.g. paired with negative-rate refunds), use [sliding window](/algorithms/sliding-window/) instead, which only writes on success.
:::

## Usage

```typescript
import { Pool } from "pg";
import { Ratelimit } from "pg-ratelimit";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ratelimit = new Ratelimit({
  pool,
  limiter: Ratelimit.fixedWindow(10, "1m"),
  prefix: "api",
});

const result = await ratelimit.limit("user:123");
// result.success - whether the request is allowed
// result.remaining - tokens left in this window
// result.reset - when the current window expires
```

## When to use it

- High-throughput endpoints where simplicity and speed matter most
- Cases where the boundary problem is acceptable
- Simple "N requests per window" requirements
