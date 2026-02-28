import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import type { Pool } from "pg";
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

describe("concurrency", () => {
  it("correctly limits under concurrent requests", async () => {
    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(10, "1m"),
      prefix: "conc",
    });

    const results = await Promise.all(Array.from({ length: 100 }, () => ratelimit.limit("user:1")));

    const successes = results.filter((r) => r.success).length;
    expect(successes).toBe(10);
  });

  it("correctly limits sliding window under concurrent requests", async () => {
    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.slidingWindow(10, "1m"),
      prefix: "conc-sw",
    });

    const results = await Promise.all(Array.from({ length: 50 }, () => ratelimit.limit("user:1")));

    const successes = results.filter((r) => r.success).length;
    expect(successes).toBe(10);
  });

  it("correctly limits token bucket under concurrent requests", async () => {
    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.tokenBucket(5, "10s", 20),
      prefix: "conc-tb",
    });

    const results = await Promise.all(Array.from({ length: 50 }, () => ratelimit.limit("user:1")));

    const successes = results.filter((r) => r.success).length;
    expect(successes).toBe(20);
  });
});

describe("negative rate", () => {
  it("refunds tokens and can exceed max", async () => {
    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(5, "1m"),
      prefix: "neg",
    });

    // Use 3 tokens
    for (let i = 0; i < 3; i++) {
      await ratelimit.limit("user:1");
    }

    // Refund 10 tokens (negative rate)
    const result = await ratelimit.limit("user:1", { rate: -10 });
    expect(result.success).toBe(true);
    // count = 3 + (-10) = -7, remaining = max(0, 5 - (-7)) = 12
    expect(result.remaining).toBe(12);
  });
});

describe("weighted costs", () => {
  it("consumes multiple tokens with rate option", async () => {
    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(10, "1m"),
      prefix: "weighted",
    });

    const result = await ratelimit.limit("user:1", { rate: 5 });
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(5);

    const result2 = await ratelimit.limit("user:1", { rate: 5 });
    expect(result2.success).toBe(true);
    expect(result2.remaining).toBe(0);

    const result3 = await ratelimit.limit("user:1", { rate: 1 });
    expect(result3.success).toBe(false);
  });
});

describe("cleanup", () => {
  it("deletes expired rows for own prefix only when probability = 1", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const rl1 = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(5, "1m"),
      prefix: "clean-a",
      clock,
      cleanupProbability: 1,
    });

    const rl2 = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(5, "1m"),
      prefix: "clean-b",
      clock,
      cleanupProbability: 1,
    });

    await rl1.limit("user:1");
    await rl2.limit("user:1");

    // Move past window expiry
    currentTime = new Date("2025-01-01T00:02:00Z");

    // rl1 limit triggers cleanup for prefix 'clean-a' only
    await rl1.limit("user:1");

    // Wait a bit for fire-and-forget cleanup
    await new Promise((r) => setTimeout(r, 100));

    const result = await pool.query(
      `SELECT prefix FROM rate_limit_ephemeral WHERE key = 'user:1' ORDER BY prefix`,
    );

    // clean-a has a new row (from the limit call), clean-b's expired row should still exist
    // since rl1's cleanup only targets prefix='clean-a'
    const prefixes = result.rows.map((r: any) => r.prefix);
    expect(prefixes).toContain("clean-a");
    expect(prefixes).toContain("clean-b");
  });

  it("skips cleanup when probability = 0", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const rl = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(5, "1m"),
      prefix: "no-clean",
      clock,
      cleanupProbability: 0,
    });

    await rl.limit("user:1");

    // Move past window expiry
    currentTime = new Date("2025-01-01T00:02:00Z");

    // This creates a new window row, but cleanup should NOT run
    await rl.limit("user:1");

    await new Promise((r) => setTimeout(r, 100));

    // The old expired row should still exist alongside the new one
    // Query raw: we expect 1 row (the upsert replaced the old row in-place via ON CONFLICT)
    // Actually for fixed window, the UPSERT replaces the row. So we check a different way:
    // Insert a second key, expire it, and verify it's NOT cleaned up
    currentTime = new Date("2025-01-01T00:02:00Z");
    await rl.limit("user:2");

    // Expire user:2's row
    currentTime = new Date("2025-01-01T00:04:00Z");

    // This call for user:1 should NOT clean up expired user:2 row
    await rl.limit("user:1");

    await new Promise((r) => setTimeout(r, 100));

    const result = await pool.query(
      `SELECT key FROM rate_limit_ephemeral WHERE prefix = 'no-clean' ORDER BY key`,
    );

    const keys = result.rows.map((r: any) => r.key);
    expect(keys).toContain("user:1");
    expect(keys).toContain("user:2"); // still there - cleanup was skipped
  });
});

describe("blockUntilReady", () => {
  it("eventually succeeds", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(1, "1s"),
      prefix: "block-ok",
      clock,
    });

    // Exhaust limit
    await ratelimit.limit("user:1");

    // blockUntilReady should wait and succeed
    // Advance time after a short delay to simulate the sleep completing
    const blockPromise = ratelimit.blockUntilReady("user:1", 5000);

    // Advance time past the window
    setTimeout(() => {
      currentTime = new Date("2025-01-01T00:00:02Z");
    }, 50);

    const result = await blockPromise;
    expect(result.success).toBe(true);
  });

  it("returns failure on timeout", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(1, "1m"),
      prefix: "block-timeout",
      clock,
    });

    // Exhaust limit
    await ratelimit.limit("user:1");

    // Timeout is 500ms but reset is 1 minute away - should return failure immediately
    const result = await ratelimit.blockUntilReady("user:1", 500);
    expect(result.success).toBe(false);
  });
});

describe("getRemaining", () => {
  it("reads without consuming for fixed window", async () => {
    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(5, "1m"),
      prefix: "getrem-fw",
    });

    // No usage yet
    const before = await ratelimit.getRemaining("user:1");
    expect(before.remaining).toBe(5);

    // Use 2 tokens
    await ratelimit.limit("user:1");
    await ratelimit.limit("user:1");

    const after = await ratelimit.getRemaining("user:1");
    expect(after.remaining).toBe(3);

    // getRemaining should not have consumed anything
    const afterCheck = await ratelimit.getRemaining("user:1");
    expect(afterCheck.remaining).toBe(3);
  });

  it("reads without consuming for token bucket", async () => {
    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.tokenBucket(5, "10s", 20),
      prefix: "getrem-tb",
    });

    const before = await ratelimit.getRemaining("user:1");
    expect(before.remaining).toBe(20);

    await ratelimit.limit("user:1");
    await ratelimit.limit("user:1");

    const after = await ratelimit.getRemaining("user:1");
    expect(after.remaining).toBe(18);

    // Second call should return the same - proves no consumption
    const afterCheck = await ratelimit.getRemaining("user:1");
    expect(afterCheck.remaining).toBe(18);
  });

  it("reads without consuming for sliding window", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.slidingWindow(10, "1m"),
      prefix: "getrem-sw",
      clock,
    });

    // No usage yet
    const before = await ratelimit.getRemaining("user:1");
    expect(before.remaining).toBe(10);

    // Use 3 tokens
    await ratelimit.limit("user:1");
    await ratelimit.limit("user:1");
    await ratelimit.limit("user:1");

    const after = await ratelimit.getRemaining("user:1");
    expect(after.remaining).toBe(7);

    // Second call - proves no consumption
    const afterCheck = await ratelimit.getRemaining("user:1");
    expect(afterCheck.remaining).toBe(7);

    // Advance to 50% into next window - prev_count=3, weight=0.5
    // effective = 3 * 0.5 + 0 = 1.5, remaining = 10 - 1.5 = 8.5
    currentTime = new Date("2025-01-01T00:01:30Z");
    const weighted = await ratelimit.getRemaining("user:1");
    expect(weighted.remaining).toBe(8.5);
  });
});

describe("resetUsedTokens", () => {
  it("restores full quota", async () => {
    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(5, "1m"),
      prefix: "reset",
    });

    // Exhaust limit
    for (let i = 0; i < 5; i++) {
      await ratelimit.limit("user:1");
    }
    expect((await ratelimit.limit("user:1")).success).toBe(false);

    // Reset
    await ratelimit.resetUsedTokens("user:1");

    // Should be back to full
    const result = await ratelimit.limit("user:1");
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(4);
  });
});
