import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { Ratelimit } from "../index.js";
import { setup, teardown } from "./setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setup();
});

afterEach(async () => {
  await pool.query("TRUNCATE rate_limit_ephemeral, rate_limit_durable");
});

afterAll(async () => {
  await teardown();
});

describe("durability", () => {
  it("creates ephemeral table as UNLOGGED", async () => {
    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(5, "1m"),
      prefix: "eph",
    });

    // Trigger table creation
    await ratelimit.limit("user:1");

    const result = await pool.query(
      `SELECT relpersistence FROM pg_class WHERE relname = 'rate_limit_ephemeral'`,
    );
    expect(result.rows[0].relpersistence).toBe("u");
  });

  it("creates durable table as logged", async () => {
    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(5, "1m"),
      prefix: "dur",
      durable: true,
    });

    // Trigger table creation
    await ratelimit.limit("user:1");

    const result = await pool.query(
      `SELECT relpersistence FROM pg_class WHERE relname = 'rate_limit_durable'`,
    );
    expect(result.rows[0].relpersistence).toBe("p");
  });
});

describe("crash survival", () => {
  it("durable data survives restart, ephemeral data is lost", async () => {
    // Use a dedicated container so the restart doesn't affect other tests
    const container = await new PostgreSqlContainer().start();
    let crashPool = new Pool({ connectionString: container.getConnectionUri() });

    try {
      const durable = new Ratelimit({
        pool: crashPool,
        limiter: Ratelimit.fixedWindow(10, "10m"),
        prefix: "crash-dur",
        durable: true,
      });

      const ephemeral = new Ratelimit({
        pool: crashPool,
        limiter: Ratelimit.fixedWindow(10, "10m"),
        prefix: "crash-eph",
      });

      // Consume 3 tokens from each
      for (let i = 0; i < 3; i++) {
        await durable.limit("user:1");
        await ephemeral.limit("user:1");
      }

      // Verify both show 7 remaining
      expect((await durable.getRemaining("user:1")).remaining).toBe(7);
      expect((await ephemeral.getRemaining("user:1")).remaining).toBe(7);

      // End the pool (connections will be broken after restart)
      await crashPool.end();

      // Simulate a crash using pg_ctl immediate stop mode (SIGQUIT).
      // A graceful restart preserves UNLOGGED tables; only crash
      // recovery truncates them.
      await container.exec([
        "su",
        "postgres",
        "-c",
        "pg_ctl stop -m immediate -D /var/lib/postgresql/data",
      ]);
      await container.restart();

      // Create a new pool after restart
      crashPool = new Pool({ connectionString: container.getConnectionUri() });

      const durableAfter = new Ratelimit({
        pool: crashPool,
        limiter: Ratelimit.fixedWindow(10, "10m"),
        prefix: "crash-dur",
        durable: true,
      });

      const ephemeralAfter = new Ratelimit({
        pool: crashPool,
        limiter: Ratelimit.fixedWindow(10, "10m"),
        prefix: "crash-eph",
      });

      // Durable data survived - still shows 7 remaining
      expect((await durableAfter.getRemaining("user:1")).remaining).toBe(7);

      // Ephemeral data was lost - back to full quota
      expect((await ephemeralAfter.getRemaining("user:1")).remaining).toBe(10);
    } finally {
      await crashPool.end();
      await container.stop();
    }
  }, 30_000);
});
