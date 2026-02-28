import type { Pool } from "pg";
import _sql from "./tables.sql";
export const TABLE_SQL: string = _sql;

const initialized = new WeakSet<Pool>();

export async function ensureTables(pool: Pool): Promise<void> {
  if (initialized.has(pool)) {
    return;
  }
  if (process.env.PG_RATELIMIT_DISABLE_AUTO_MIGRATE === "true") {
    initialized.add(pool);
    return;
  }

  await pool.query(TABLE_SQL);
  initialized.add(pool);
}
