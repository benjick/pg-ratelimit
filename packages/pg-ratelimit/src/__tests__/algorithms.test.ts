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

describe("fixed window", () => {
  it("allows N requests and rejects N+1", async () => {
    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(5, "1m"),
      prefix: "fw-basic",
    });

    for (let i = 0; i < 5; i++) {
      const result = await ratelimit.limit("user:1");
      expect(result.success).toBe(true);
      expect(result.limit).toBe(5);
      expect(result.remaining).toBe(4 - i);
    }

    const rejected = await ratelimit.limit("user:1");
    expect(rejected.success).toBe(false);
    expect(rejected.remaining).toBe(0);
  });

  it("resets after window expires", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(5, "1m"),
      prefix: "fw-reset",
      clock,
    });

    for (let i = 0; i < 5; i++) {
      await ratelimit.limit("user:1");
    }
    expect((await ratelimit.limit("user:1")).success).toBe(false);

    // Fast forward past the window
    currentTime = new Date("2025-01-01T00:01:01Z");
    const result = await ratelimit.limit("user:1");
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("returns correct reset time", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.fixedWindow(5, "1m"),
      prefix: "fw-reset-time",
      clock,
    });

    const result = await ratelimit.limit("user:1");
    expect(result.reset).toBe(new Date("2025-01-01T00:01:00Z").getTime());
  });
});

describe("sliding window", () => {
  it("uses weighted previous window count", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.slidingWindow(10, "1m"),
      prefix: "sw-weight",
      clock,
    });

    // Use 8 tokens in the first window
    for (let i = 0; i < 8; i++) {
      await ratelimit.limit("user:1");
    }

    // Move to 30% into the next window (18 seconds past the 1m window)
    currentTime = new Date("2025-01-01T00:01:18Z");

    // Effective = 8 * 0.7 + 0 + 1 = 6.6 → success, remaining ~ 3.4
    const result = await ratelimit.limit("user:1");
    expect(result.success).toBe(true);

    // Now try more. Effective after first: 8*0.7 + 1 = 6.6
    // Each subsequent adds 1 to count: 8*0.7 + 2 = 7.6, 8*0.7 + 3 = 8.6, 8*0.7 + 4 = 9.6
    const r2 = await ratelimit.limit("user:1");
    expect(r2.success).toBe(true); // 7.6 <= 10

    const r3 = await ratelimit.limit("user:1");
    expect(r3.success).toBe(true); // 8.6 <= 10

    const r4 = await ratelimit.limit("user:1");
    expect(r4.success).toBe(true); // 9.6 <= 10

    const r5 = await ratelimit.limit("user:1");
    expect(r5.success).toBe(false); // 10.6 > 10
  });

  it("does not consume tokens on denial", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.slidingWindow(10, "1m"),
      prefix: "sw-no-consume-deny",
      clock,
    });

    // Exhaust 10 tokens
    for (let i = 0; i < 10; i++) {
      await ratelimit.limit("user:1");
    }

    // Fire 5 denied requests - should NOT consume tokens
    for (let i = 0; i < 5; i++) {
      const r = await ratelimit.limit("user:1");
      expect(r.success).toBe(false);
    }

    // Advance 2+ windows so everything resets
    currentTime = new Date("2025-01-01T00:03:00Z");

    // If denied requests consumed tokens, count would be 15 and prev_count
    // would carry over a non-zero value. With the fix, count stays at 10
    // and after 2+ windows both reset to 0.
    const result = await ratelimit.limit("user:1");
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it("rotates windows correctly", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.slidingWindow(5, "1m"),
      prefix: "sw-rotate",
      clock,
    });

    for (let i = 0; i < 5; i++) {
      await ratelimit.limit("user:1");
    }

    // 2+ windows later, everything resets
    currentTime = new Date("2025-01-01T00:03:00Z");
    const result = await ratelimit.limit("user:1");
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(4);
  });
});

describe("token bucket", () => {
  it("starts full at maxTokens", async () => {
    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.tokenBucket(5, "10s", 20),
      prefix: "tb-full",
    });

    const result = await ratelimit.limit("user:1");
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(19);
    expect(result.limit).toBe(20);
  });

  it("consumes and refills tokens", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.tokenBucket(5, "10s", 20),
      prefix: "tb-refill",
      clock,
    });

    // Use 15 tokens
    for (let i = 0; i < 15; i++) {
      await ratelimit.limit("user:1");
    }

    // Advance 10 seconds - should refill 5 tokens
    currentTime = new Date("2025-01-01T00:00:10Z");
    const result = await ratelimit.limit("user:1");
    // 5 remaining + 5 refilled - 1 consumed = 9
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it("caps refill at maxTokens", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.tokenBucket(5, "10s", 20),
      prefix: "tb-cap",
      clock,
    });

    // Use 2 tokens
    await ratelimit.limit("user:1");
    await ratelimit.limit("user:1");

    // Advance a long time - refill should cap at 20
    currentTime = new Date("2025-01-01T01:00:00Z");
    const result = await ratelimit.limit("user:1");
    expect(result.remaining).toBe(19); // 20 (capped) - 1 = 19
  });

  it("rejects when empty", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.tokenBucket(5, "10s", 20),
      prefix: "tb-empty",
      clock,
    });

    for (let i = 0; i < 20; i++) {
      await ratelimit.limit("user:1");
    }

    const result = await ratelimit.limit("user:1");
    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("does not consume tokens on denial", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.tokenBucket(5, "10s", 20),
      prefix: "tb-no-consume-deny",
      clock,
    });

    // Drain the bucket
    for (let i = 0; i < 20; i++) {
      await ratelimit.limit("user:1");
    }

    // Fire several denied requests
    for (let i = 0; i < 5; i++) {
      const r = await ratelimit.limit("user:1");
      expect(r.success).toBe(false);
    }

    // Advance 10s - should refill 5 tokens
    // If denied requests consumed tokens, the bucket would be at -5 + 5 = 0 (still denied)
    // If denied requests did NOT consume, the bucket is at 0 + 5 = 5 (allowed)
    currentTime = new Date("2025-01-01T00:00:10Z");
    const result = await ratelimit.limit("user:1");
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(4); // 5 refilled - 1 consumed
  });

  it("refills only full intervals (floor behavior)", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.tokenBucket(5, "10s", 20),
      prefix: "tb-floor",
      clock,
    });

    // Use 15 tokens (5 remaining)
    for (let i = 0; i < 15; i++) {
      await ratelimit.limit("user:1");
    }

    // Advance 15s (1.5 intervals) - should refill floor(1.5) * 5 = 5, not 7
    currentTime = new Date("2025-01-01T00:00:15Z");
    const result = await ratelimit.limit("user:1");
    // 5 remaining + 5 refilled - 1 consumed = 9
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it("returns accurate reset time on denial", async () => {
    let currentTime = new Date("2025-01-01T00:00:00Z");
    const clock = () => currentTime;

    const ratelimit = new Ratelimit({
      pool,
      limiter: Ratelimit.tokenBucket(5, "10s", 20),
      prefix: "tb-reset-denial",
      clock,
    });

    // Drain the bucket completely
    for (let i = 0; i < 20; i++) {
      await ratelimit.limit("user:1");
    }

    // Denied request: need 1 token, have 0, refillRate=5 per 10s
    // Should get tokens back in 1 interval (10s), not full TTL (40s)
    const denied = await ratelimit.limit("user:1");
    expect(denied.success).toBe(false);

    const resetMs = denied.reset - currentTime.getTime();
    // reset should be 10s (one interval to get 5 tokens), not 40s (full TTL)
    expect(resetMs).toBe(10_000);
  });
});
