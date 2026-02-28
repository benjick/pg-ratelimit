import type { PoolClient } from "pg";
import type { AlgorithmContext, LimitResult } from "../types.js";

export async function tokenBucket(
  ctx: AlgorithmContext,
  maxTokens: number,
  refillRate: number,
  intervalMs: number,
): Promise<LimitResult> {
  const { pool, table, prefix, key, rate, now, debug, synchronousCommit } = ctx;
  const client: PoolClient = await pool.connect();
  const ttlMs = (maxTokens / refillRate) * intervalMs;

  try {
    await client.query("BEGIN");

    if (!synchronousCommit) {
      await client.query("SET LOCAL synchronous_commit = off");
    }

    // Ensure row exists so SELECT FOR UPDATE can lock it
    const ttlInterval = `${ttlMs} milliseconds`;
    const ensureSql = `
      INSERT INTO ${table} (prefix, key, tokens, last_refill, expires_at)
      VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + $5::interval)
      ON CONFLICT (prefix, key) DO NOTHING
    `;
    await client.query(ensureSql, [prefix, key, maxTokens, now, ttlInterval]);

    const selectSql = `
      SELECT tokens, last_refill, expires_at
      FROM ${table}
      WHERE prefix = $1 AND key = $2
      FOR UPDATE
    `;

    if (debug) {
      console.debug("pg-ratelimit token-bucket SELECT:", selectSql, [prefix, key]);
    }

    const existing = await client.query(selectSql, [prefix, key]);
    const row = existing.rows[0];
    const lastRefill = new Date(row.last_refill).getTime();
    const elapsed = now.getTime() - lastRefill;
    const refilled = Math.floor(elapsed / intervalMs) * refillRate;
    const currentTokens = Math.min(Number(row.tokens) + refilled, maxTokens);

    const newTokens = currentTokens - rate;
    const success = newTokens >= 0;

    // Only write on success - denied requests are a no-op on DB state.
    // Skipping the write avoids resetting last_refill, which would delay
    // token refill for subsequent requests.
    if (success) {
      const upsertSql = `
        INSERT INTO ${table} (prefix, key, tokens, last_refill, expires_at)
        VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + $5::interval)
        ON CONFLICT (prefix, key) DO UPDATE
          SET tokens = $3, last_refill = $4::timestamptz, expires_at = $4::timestamptz + $5::interval
      `;

      const upsertParams = [prefix, key, newTokens, now, ttlInterval];

      if (debug) {
        console.debug("pg-ratelimit token-bucket UPSERT:", upsertSql, upsertParams);
      }

      await client.query(upsertSql, upsertParams);
    }
    await client.query("COMMIT");

    // On denial, reset = time until enough tokens refill to satisfy the request
    let reset: number;
    if (success) {
      reset = now.getTime() + ttlMs;
    } else {
      const tokensNeeded = rate - currentTokens;
      const intervalsNeeded = Math.ceil(tokensNeeded / refillRate);
      reset = now.getTime() + intervalsNeeded * intervalMs;
    }

    return {
      success,
      limit: maxTokens,
      remaining: Math.max(0, success ? newTokens : currentTokens),
      reset,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
