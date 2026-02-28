"use server";

import { limiters } from "@/lib/ratelimit";
import { strategies, type Strategy } from "@/lib/strategies";

export type LimitResponse = {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
};

export type RemainingResponse = {
  remaining: number;
  reset: number;
};

const validStrategies = new Set<string>(strategies.map((s) => s.value));

function getLimiter(strategy: string) {
  if (!validStrategies.has(strategy)) {
    throw new Error(`Unknown strategy: ${strategy}`);
  }
  return limiters[strategy as Strategy];
}

export async function sendRequest(strategy: string): Promise<LimitResponse> {
  return getLimiter(strategy).limit("global");
}

export async function peekRemaining(strategy: string): Promise<RemainingResponse> {
  return getLimiter(strategy).getRemaining("global");
}

export async function waitAndSend(strategy: string): Promise<LimitResponse> {
  return getLimiter(strategy).blockUntilReady("global", "15s");
}
