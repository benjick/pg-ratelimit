import type { PoolClient } from "pg";
import type { AlgorithmContext, LimitResult } from "../types.js";

export async function slidingWindow(
  ctx: AlgorithmContext,
  tokens: number,
  windowMs: number,
): Promise<LimitResult> {
  const { pool, table, prefix, key, rate, now, debug, synchronousCommit } = ctx;
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!synchronousCommit) {
      await client.query("SET LOCAL synchronous_commit = off");
    }

    // Ensure row exists so SELECT FOR UPDATE can lock it
    const doubleWindowInterval = `${2 * windowMs} milliseconds`;
    const ensureSql = `
      INSERT INTO ${table} (prefix, key, count, prev_count, window_start, expires_at)
      VALUES ($1, $2, 0, 0, $3::timestamptz, $3::timestamptz + $4::interval)
      ON CONFLICT (prefix, key) DO NOTHING
    `;
    await client.query(ensureSql, [prefix, key, now, doubleWindowInterval]);

    const selectSql = `
      SELECT count, prev_count, window_start, expires_at
      FROM ${table}
      WHERE prefix = $1 AND key = $2
      FOR UPDATE
    `;

    if (debug) {
      console.debug("pg-ratelimit sliding-window SELECT:", selectSql, [prefix, key]);
    }

    const existing = await client.query(selectSql, [prefix, key]);
    const row = existing.rows[0];
    const oldWindowStart = new Date(row.window_start).getTime();
    const nowMs = now.getTime();

    let prevCount: number;
    let count: number;
    let windowStart: Date;

    if (oldWindowStart + windowMs > nowMs) {
      // Same window (includes freshly inserted row where window_start == now)
      prevCount = Number(row.prev_count) || 0;
      count = Number(row.count) || 0;
      windowStart = new Date(row.window_start);
    } else if (oldWindowStart + 2 * windowMs > nowMs) {
      // One window elapsed
      prevCount = Number(row.count) || 0;
      count = 0;
      windowStart = new Date(oldWindowStart + windowMs);
    } else {
      // 2+ windows elapsed
      prevCount = 0;
      count = 0;
      windowStart = now;
    }

    // Calculate effective count
    const elapsed = now.getTime() - windowStart.getTime();
    const weight = 1 - elapsed / windowMs;
    const effective = prevCount * weight + count + rate;
    const success = effective <= tokens;

    // Only write on success - denied requests are a no-op on DB state.
    if (success) {
      const newCount = count + rate;

      const upsertSql = `
        INSERT INTO ${table} (prefix, key, count, prev_count, window_start, expires_at)
        VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + $6::interval)
        ON CONFLICT (prefix, key) DO UPDATE
          SET count = $3,
              prev_count = $4,
              window_start = $5::timestamptz,
              expires_at = $5::timestamptz + $6::interval
      `;

      const upsertParams = [prefix, key, newCount, prevCount, windowStart, doubleWindowInterval];

      if (debug) {
        console.debug("pg-ratelimit sliding-window UPSERT:", upsertSql, upsertParams);
      }

      await client.query(upsertSql, upsertParams);
    }
    await client.query("COMMIT");

    const reset = windowStart.getTime() + windowMs;

    return {
      success,
      limit: tokens,
      remaining: Math.max(0, tokens - effective),
      reset,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
