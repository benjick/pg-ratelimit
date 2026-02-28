import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { TABLE_SQL } from "../index.js";

let container: any;
let pool: Pool;

export async function setup() {
  container = await new PostgreSqlContainer().start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(TABLE_SQL);
  return pool;
}

export async function teardown() {
  await pool.end();
  await container.stop();
}

export function getPool(): Pool {
  return pool;
}
