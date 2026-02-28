import { Pool } from "pg";
import { Ratelimit } from "pg-ratelimit";
import type { Strategy } from "./strategies";

const globalForPg = globalThis as unknown as { pgPool?: Pool };

const pool =
  globalForPg.pgPool ??
  new Pool({ connectionString: process.env.DATABASE_URL });

globalForPg.pgPool = pool;

export const limiters: Record<Strategy, Ratelimit> = {
  "fixed-window": new Ratelimit({
    pool,
    limiter: Ratelimit.fixedWindow(10, "10s"),
    prefix: "demo-fixed",
  }),
  "sliding-window": new Ratelimit({
    pool,
    limiter: Ratelimit.slidingWindow(10, "10s"),
    prefix: "demo-sliding",
  }),
  "token-bucket": new Ratelimit({
    pool,
    limiter: Ratelimit.tokenBucket(1, "1s", 10),
    prefix: "demo-bucket",
  }),
};
