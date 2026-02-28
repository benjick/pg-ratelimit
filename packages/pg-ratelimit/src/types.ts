import type { Pool } from "pg";

export type TimeUnit = "s" | "m" | "h" | "d";
export type Duration = `${number} ${TimeUnit}` | `${number}${TimeUnit}`;

export type Algorithm =
  | { type: "fixedWindow"; tokens: number; window: Duration | number }
  | { type: "slidingWindow"; tokens: number; window: Duration | number }
  | {
      type: "tokenBucket";
      refillRate: number;
      interval: Duration | number;
      maxTokens: number;
    };

export interface AlgorithmContext {
  pool: Pool;
  table: string;
  prefix: string;
  key: string;
  rate: number;
  now: Date;
  debug: boolean;
  synchronousCommit: boolean;
}

export interface LimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

export type Clock = () => Date;

export type RatelimitConfig = {
  pool: Pool;
  limiter: Algorithm;
  prefix: string;
  debug?: boolean;
  clock?: Clock;
  cleanupProbability?: number;
} & ({ durable?: false } | { durable: true; synchronousCommit?: boolean });
