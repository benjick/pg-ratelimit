---
title: Token Bucket
description: Burst-friendly rate limiting with steady refill.
---

## How it works

Token bucket maintains a virtual bucket of tokens that refills at a steady rate up to a maximum capacity. Each request consumes one or more tokens. If the bucket doesn't have enough tokens, the request is denied and no tokens are consumed - only successful requests deduct from the bucket.

```
Max capacity: 20 tokens
Refill rate: 5 tokens every 10 seconds

Time 0:00  - Bucket: 20/20 (full)
             5 requests → Bucket: 15/20
Time 0:10  - Refill +5 → Bucket: 20/20 (capped at max)
Time 0:15  - 18 requests → Bucket: 2/20
Time 0:20  - Refill +5 → Bucket: 7/20 (not full yet)
```

There's no actual bucket - the implementation stores a `tokens` count and `last_refill` timestamp, then calculates refilled tokens on each request.

## SQL strategy

Token bucket requires reading the current state, calculating refilled tokens, and updating - a multi-step operation. It uses `SELECT ... FOR UPDATE` row-level locking within a transaction.

```sql
BEGIN;
  -- Ensure row exists so FOR UPDATE can lock it (concurrent-safe)
  INSERT INTO rate_limit_ephemeral (prefix, key, tokens, last_refill, expires_at)
  VALUES ($prefix, $key, $max_tokens, $now, $now + $ttl)
  ON CONFLICT (prefix, key) DO NOTHING;

  SELECT tokens, last_refill, expires_at
  FROM rate_limit_ephemeral
  WHERE prefix = $prefix AND key = $key
  FOR UPDATE;

  -- In application code:
  -- elapsed = now - last_refill
  -- refilled = floor(elapsed / interval) * refill_rate
  -- current_tokens = min(tokens + refilled, max_tokens)
  -- new_tokens = current_tokens - cost
  -- success = new_tokens >= 0
  -- tokens_to_write = success ? new_tokens : current_tokens (no deduction on denial)
  -- ttl = (max_tokens / refill_rate) * interval

  INSERT INTO rate_limit_ephemeral (prefix, key, tokens, last_refill, expires_at)
  VALUES ($prefix, $key, $tokens_to_write, $now, $now + $ttl)
  ON CONFLICT (prefix, key) DO UPDATE
    SET tokens = $tokens_to_write, last_refill = $now, expires_at = $now + $ttl;
COMMIT;
```

The initial `INSERT ... ON CONFLICT DO NOTHING` ensures the row exists before the `SELECT ... FOR UPDATE`. New buckets start full at `$max_tokens`. Without this, concurrent first requests would all see "no row" and bypass the row lock.

Denied requests do not deduct tokens - `$tokens_to_write` is the unchanged `current_tokens` on denial. This prevents denied requests from accumulating a debt that delays future refills.

On denial, `reset` is the time until enough tokens refill to satisfy the request: `ceil((cost - current_tokens) / refill_rate) * interval`. On success, `reset` is `now + ttl` (the row's expiry time).

The `FOR UPDATE` lock only affects the specific key being checked.

## Usage

```typescript
import { Pool } from "pg";
import { Ratelimit } from "pg-ratelimit";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ratelimit = new Ratelimit({
  pool,
  limiter: Ratelimit.tokenBucket(5, "10s", 20),
  prefix: "api",
});

// Each request consumes 1 token by default
const result = await ratelimit.limit("user:123");

// Consume multiple tokens for expensive operations
const result2 = await ratelimit.limit("user:123", { rate: 5 });
```

## When to use it

- Quota-style rate limiting (e.g., API credits, upload limits)
- When you want to allow short bursts while enforcing an average rate
- Scenarios where different operations have different costs (using weighted `rate`)
