import type { Pool } from "pg";
import type {
  Algorithm,
  AlgorithmContext,
  Clock,
  Duration,
  LimitResult,
  RatelimitConfig,
} from "./types.js";
import { toMs } from "./duration.js";
import { ensureTables } from "./tables.js";
import { fixedWindow } from "./algorithms/fixed-window.js";
import { slidingWindow } from "./algorithms/sliding-window.js";
import { tokenBucket } from "./algorithms/token-bucket.js";

export class Ratelimit {
  private readonly pool: Pool;
  private readonly algorithm: Algorithm;
  private readonly prefix: string;
  private readonly table: string;
  private readonly debug: boolean;
  private readonly clock: Clock;
  private readonly durable: boolean;
  private readonly synchronousCommit: boolean;
  private readonly cleanupProbability: number;
  private readonly inMemoryBlock: boolean;
  private readonly maxBlockedKeys: number;
  private readonly limitValue: number;
  private readonly blockedKeys: Map<string, number>;

  // Pre-parsed durations (only the relevant one is used per algorithm)
  private readonly windowMs: number;
  private readonly intervalMs: number;

  constructor(config: RatelimitConfig) {
    if (!config.prefix) {
      throw new Error("prefix must be a non-empty string");
    }

    const cleanupProbability = config.cleanupProbability ?? 0.1;
    if (cleanupProbability < 0 || cleanupProbability > 1) {
      throw new Error("cleanupProbability must be between 0 and 1");
    }

    this.pool = config.pool;
    this.algorithm = config.limiter;
    this.prefix = config.prefix;
    this.debug = config.debug ?? false;
    this.clock = config.clock ?? (() => new Date());
    this.durable = "durable" in config && config.durable === true;
    this.table = this.durable ? "rate_limit_durable" : "rate_limit_ephemeral";

    this.cleanupProbability = cleanupProbability;

    // synchronousCommit only applies to durable + transaction-based algorithms
    this.synchronousCommit =
      !this.durable || ("synchronousCommit" in config && config.synchronousCommit === true);

    // Pre-parse durations to throw early on invalid config
    if (this.algorithm.type === "fixedWindow" || this.algorithm.type === "slidingWindow") {
      this.windowMs = toMs(this.algorithm.window);
      this.intervalMs = 0;
    } else {
      this.windowMs = 0;
      this.intervalMs = toMs(this.algorithm.interval);
    }

    this.inMemoryBlock = "inMemoryBlock" in config && config.inMemoryBlock === true;
    this.maxBlockedKeys =
      this.inMemoryBlock && "maxBlockedKeys" in config ? (config.maxBlockedKeys ?? 10_000) : 10_000;
    this.blockedKeys = new Map();
    this.limitValue =
      this.algorithm.type === "tokenBucket" ? this.algorithm.maxTokens : this.algorithm.tokens;
  }

  static fixedWindow(tokens: number, window: Duration | number): Algorithm {
    return { type: "fixedWindow", tokens, window };
  }

  static slidingWindow(tokens: number, window: Duration | number): Algorithm {
    return { type: "slidingWindow", tokens, window };
  }

  static tokenBucket(
    refillRate: number,
    interval: Duration | number,
    maxTokens: number,
  ): Algorithm {
    return { type: "tokenBucket", refillRate, interval, maxTokens };
  }

  async limit(key: string, opts?: { rate?: number }): Promise<LimitResult> {
    const rate = opts?.rate ?? 1;
    const now = this.clock();
    const nowMs = now.getTime();

    // In-memory block: serve synthetic 429 for known-blocked keys (positive rate only)
    if (this.inMemoryBlock && rate > 0) {
      const cachedReset = this.blockedKeys.get(key);
      if (cachedReset !== undefined) {
        if (cachedReset > nowMs) {
          return { success: false, limit: this.limitValue, remaining: 0, reset: cachedReset };
        }
        this.blockedKeys.delete(key);
      }
    }

    await ensureTables(this.pool);

    const ctx: AlgorithmContext = {
      pool: this.pool,
      table: this.table,
      prefix: this.prefix,
      key,
      rate,
      now,
      debug: this.debug,
      synchronousCommit: this.synchronousCommit,
    };

    let result: LimitResult;

    switch (this.algorithm.type) {
      case "fixedWindow":
        result = await fixedWindow(ctx, this.algorithm.tokens, this.windowMs);
        break;
      case "slidingWindow":
        result = await slidingWindow(ctx, this.algorithm.tokens, this.windowMs);
        break;
      case "tokenBucket":
        result = await tokenBucket(
          ctx,
          this.algorithm.maxTokens,
          this.algorithm.refillRate,
          this.intervalMs,
        );
        break;
    }

    // In-memory block: cache blocked keys after DB result
    if (this.inMemoryBlock) {
      if (rate < 0) {
        // Negative rate (refund) may have unblocked the key
        this.blockedKeys.delete(key);
      } else if (!result.success) {
        this.blockedKeys.set(key, result.reset);
        if (this.blockedKeys.size > this.maxBlockedKeys) {
          this.sweepExpired(nowMs);
        }
      }
    }

    // Fire-and-forget cleanup of expired rows for this prefix
    if (Math.random() < this.cleanupProbability) {
      void this.pool
        .query(`DELETE FROM ${this.table} WHERE prefix = $1 AND expires_at < $2`, [
          this.prefix,
          now,
        ])
        .catch(() => {});
    }

    return result;
  }

  async blockUntilReady(
    key: string,
    timeout: Duration | number,
    opts?: { rate?: number },
  ): Promise<LimitResult> {
    const timeoutMs = toMs(timeout);
    const deadline = this.clock().getTime() + timeoutMs;

    let result = await this.limit(key, opts);
    if (result.success) {
      return result;
    }

    while (true) {
      const now = this.clock().getTime();
      const remaining = deadline - now;

      if (remaining <= 0) {
        return result;
      }

      const sleepMs = result.reset - now;

      // If time until reset exceeds remaining timeout, return failure immediately
      if (sleepMs > remaining) {
        return result;
      }

      if (sleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }

      result = await this.limit(key, opts);
      if (result.success) {
        return result;
      }
    }
  }

  async getRemaining(key: string): Promise<{ remaining: number; reset: number }> {
    await ensureTables(this.pool);

    const now = this.clock();

    const selectSql = `
      SELECT count, prev_count, window_start, expires_at, tokens, last_refill
      FROM ${this.table}
      WHERE prefix = $1 AND key = $2
    `;

    if (this.debug) {
      console.debug("pg-ratelimit getRemaining:", selectSql, [this.prefix, key]);
    }

    const result = await this.pool.query(selectSql, [this.prefix, key]);

    if (result.rows.length === 0) {
      // No row - full quota
      switch (this.algorithm.type) {
        case "fixedWindow":
          return {
            remaining: this.algorithm.tokens,
            reset: now.getTime() + this.windowMs,
          };
        case "slidingWindow":
          return {
            remaining: this.algorithm.tokens,
            reset: now.getTime() + this.windowMs,
          };
        case "tokenBucket":
          return {
            remaining: this.algorithm.maxTokens,
            reset:
              now.getTime() +
              (this.algorithm.maxTokens / this.algorithm.refillRate) * this.intervalMs,
          };
      }
    }

    const row = result.rows[0];

    switch (this.algorithm.type) {
      case "fixedWindow": {
        if (new Date(row.expires_at).getTime() < now.getTime()) {
          // Expired - full quota
          return {
            remaining: this.algorithm.tokens,
            reset: now.getTime() + this.windowMs,
          };
        }
        const count = Number(row.count) || 0;
        return {
          remaining: Math.max(0, this.algorithm.tokens - count),
          reset: new Date(row.expires_at).getTime(),
        };
      }
      case "slidingWindow": {
        const oldWindowStart = new Date(row.window_start).getTime();
        const nowMs = now.getTime();
        let prevCount: number;
        let count: number;
        let windowStart: number;

        if (oldWindowStart + this.windowMs > nowMs) {
          // Same window
          prevCount = Number(row.prev_count) || 0;
          count = Number(row.count) || 0;
          windowStart = oldWindowStart;
        } else if (oldWindowStart + 2 * this.windowMs > nowMs) {
          // One window elapsed
          prevCount = Number(row.count) || 0;
          count = 0;
          windowStart = oldWindowStart + this.windowMs;
        } else {
          // 2+ windows elapsed - full quota
          return {
            remaining: this.algorithm.tokens,
            reset: nowMs + this.windowMs,
          };
        }

        const elapsed = nowMs - windowStart;
        const weight = 1 - elapsed / this.windowMs;
        const effective = prevCount * weight + count;
        return {
          remaining: Math.max(0, this.algorithm.tokens - effective),
          reset: windowStart + this.windowMs,
        };
      }
      case "tokenBucket": {
        const lastRefill = new Date(row.last_refill).getTime();
        const elapsed = now.getTime() - lastRefill;
        const refilled = Math.floor(elapsed / this.intervalMs) * this.algorithm.refillRate;
        const currentTokens = Math.min(Number(row.tokens) + refilled, this.algorithm.maxTokens);
        const ttlMs = (this.algorithm.maxTokens / this.algorithm.refillRate) * this.intervalMs;
        return {
          remaining: Math.max(0, currentTokens),
          reset: now.getTime() + ttlMs,
        };
      }
    }
  }

  async resetUsedTokens(key: string): Promise<void> {
    await ensureTables(this.pool);

    const sql = `DELETE FROM ${this.table} WHERE prefix = $1 AND key = $2`;

    if (this.debug) {
      console.debug("pg-ratelimit resetUsedTokens:", sql, [this.prefix, key]);
    }

    await this.pool.query(sql, [this.prefix, key]);

    this.blockedKeys.delete(key);
  }

  private sweepExpired(nowMs: number): void {
    for (const [k, reset] of this.blockedKeys) {
      if (reset <= nowMs) {
        this.blockedKeys.delete(k);
      }
    }
  }
}
