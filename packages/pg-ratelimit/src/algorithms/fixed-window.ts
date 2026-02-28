import type { AlgorithmContext, LimitResult } from "../types.js";

export async function fixedWindow(
  ctx: AlgorithmContext,
  tokens: number,
  windowMs: number,
): Promise<LimitResult> {
  const { pool, table, prefix, key, rate, now, debug } = ctx;
  const windowInterval = `${windowMs} milliseconds`;

  const sql = `
    INSERT INTO ${table} (prefix, key, count, window_start, expires_at)
    VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + $5::interval)
    ON CONFLICT (prefix, key) DO UPDATE
      SET count = CASE
        WHEN ${table}.expires_at < $4::timestamptz THEN $3
        ELSE ${table}.count + $3
      END,
      window_start = CASE
        WHEN ${table}.expires_at < $4::timestamptz THEN $4::timestamptz
        ELSE ${table}.window_start
      END,
      expires_at = CASE
        WHEN ${table}.expires_at < $4::timestamptz THEN $4::timestamptz + $5::interval
        ELSE ${table}.expires_at
      END
    RETURNING count, expires_at
  `;

  const params = [prefix, key, rate, now, windowInterval];

  if (debug) {
    console.debug("pg-ratelimit fixed-window:", sql, params);
  }

  const result = await pool.query(sql, params);
  const row = result.rows[0];
  const count = Number(row.count);

  return {
    success: count <= tokens,
    limit: tokens,
    remaining: Math.max(0, tokens - count),
    reset: new Date(row.expires_at).getTime(),
  };
}
