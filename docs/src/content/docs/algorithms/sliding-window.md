---
title: Sliding Window
description: Weighted window rate limiting that fixes the boundary problem.
---

## How it works

Sliding window eliminates the [boundary problem](/algorithms/fixed-window/#the-boundary-problem) of fixed windows by weighting the previous window's count against the current one based on how far into the current window you are.

The formula:

```
effective_count = (previous_window_count × weight) + current_window_count + cost
weight = 1 - (elapsed_time_in_current_window / window_duration)
```

**Example**: If you're 30% into the current window:

- Previous window count: 8
- Current window count: 3
- Cost: 1 (default)
- Effective count: (8 × 0.7) + 3 + 1 = 9.6

This smooths out the rate calculation and prevents the burst-at-boundary exploit.

## SQL strategy

Sliding window requires reading the previous window's count, calculating the weighted total, and updating - a multi-step operation. It uses `SELECT ... FOR UPDATE` row-level locking within a transaction to ensure concurrency safety.

```sql
BEGIN;
  -- Ensure row exists so FOR UPDATE can lock it (concurrent-safe)
  INSERT INTO rate_limit_ephemeral (prefix, key, count, prev_count, window_start, expires_at)
  VALUES ($prefix, $key, 0, 0, $now, $now + 2 * $window)
  ON CONFLICT (prefix, key) DO NOTHING;

  SELECT count, prev_count, window_start, expires_at
  FROM rate_limit_ephemeral
  WHERE prefix = $prefix AND key = $key
  FOR UPDATE;

  -- In application code, determine state based on the SELECT result:
  --
  -- Same window (window_start + window > now):
  --   prev_count = unchanged, count = unchanged, window_start = unchanged
  --
  -- One window elapsed (window_start + 2*window > now):
  --   prev_count = old count, count = 0, window_start = old window_start + window
  --
  -- 2+ windows elapsed:
  --   prev_count = 0, count = 0, window_start = now
  --
  -- Then calculate:
  --   weight = 1 - ((now - window_start) / window_duration)
  --   effective = (prev_count × weight) + count + rate
  --   success = effective <= limit
  --
  -- Only upsert on success - denied requests do not modify DB state:
  -- IF success THEN
  INSERT INTO rate_limit_ephemeral (prefix, key, count, prev_count, window_start, expires_at)
  VALUES ($prefix, $key, $count + $rate, $prev_count, $window_start, $window_start + 2 * $window)
  ON CONFLICT (prefix, key) DO UPDATE
    SET count = $count + $rate,
        prev_count = $prev_count,
        window_start = $window_start,
        expires_at = $window_start + 2 * $window;
  -- END IF
COMMIT;
```

The initial `INSERT ... ON CONFLICT DO NOTHING` ensures the row exists before the `SELECT ... FOR UPDATE`. Without this, concurrent first requests for the same key would all see "no row", bypassing the row lock and allowing more requests than the limit. The `DO NOTHING` is safe - if the row already exists, it's untouched.

Note: `expires_at` is set to `window_start + 2 * window` because the row is needed through the _next_ window (when this window's count becomes `prev_count`).

The `FOR UPDATE` lock only affects the specific key being checked - different keys don't block each other.

## Usage

```typescript
import { Pool } from "pg";
import { Ratelimit } from "pg-ratelimit";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ratelimit = new Ratelimit({
  pool,
  limiter: Ratelimit.slidingWindow(50, "30s"),
  prefix: "api",
});

const result = await ratelimit.limit("user:123");
```

## When to use it

- When you need accurate rate limiting without boundary exploits
- APIs where consistent rate enforcement is important
- Default choice when you're unsure which algorithm to pick
