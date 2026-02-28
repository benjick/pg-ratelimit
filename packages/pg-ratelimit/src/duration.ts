import type { Duration } from "./types.js";

const MULTIPLIERS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_RE = /^\s*(\d+)\s*(s|m|h|d)\s*$/;

export function toMs(duration: Duration | number): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(
        `Invalid duration: ${duration}. Must be a positive finite number of milliseconds.`,
      );
    }
    return duration;
  }

  const match = DURATION_RE.exec(duration);
  if (!match) {
    throw new Error(
      `Invalid duration format: "${duration}". Expected format: "<number><unit>" where unit is s, m, h, or d.`,
    );
  }

  const value = Number(match[1]);
  const unit = match[2];

  if (value <= 0) {
    throw new Error(`Invalid duration: "${duration}". Value must be positive.`);
  }

  return value * MULTIPLIERS[unit];
}
