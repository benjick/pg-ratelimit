import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { Ratelimit, TABLE_SQL } from "../index.js";
import { setup, teardown } from "./setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setup();
});

afterAll(async () => {
  await teardown();
});

describe("duration validation", () => {
  it("accepts valid durations", () => {
    expect(() => Ratelimit.fixedWindow(5, "30s")).not.toThrow();
    expect(() => Ratelimit.fixedWindow(5, "30 s")).not.toThrow();
    expect(() => Ratelimit.fixedWindow(5, "5m")).not.toThrow();
    expect(() => Ratelimit.fixedWindow(5, "1h")).not.toThrow();
    expect(() => Ratelimit.fixedWindow(5, "1d")).not.toThrow();
    expect(() => Ratelimit.fixedWindow(5, 60000)).not.toThrow();
  });

  it("rejects invalid durations at construction time", () => {
    expect(
      () =>
        new Ratelimit({
          pool,
          limiter: Ratelimit.fixedWindow(5, "invalid" as any),
          prefix: "test",
        }),
    ).toThrow();

    expect(
      () =>
        new Ratelimit({
          pool,
          limiter: Ratelimit.fixedWindow(5, "0s" as any),
          prefix: "test",
        }),
    ).toThrow();

    expect(
      () =>
        new Ratelimit({
          pool,
          limiter: Ratelimit.fixedWindow(5, -1000),
          prefix: "test",
        }),
    ).toThrow();

    expect(
      () =>
        new Ratelimit({
          pool,
          limiter: Ratelimit.fixedWindow(5, Infinity),
          prefix: "test",
        }),
    ).toThrow();
  });
});

describe("TABLE_SQL export", () => {
  it("exports valid SQL", () => {
    expect(TABLE_SQL).toContain("rate_limit_ephemeral");
    expect(TABLE_SQL).toContain("rate_limit_durable");
    expect(TABLE_SQL).toContain("IF NOT EXISTS");
  });
});
