import type { Context, MiddlewareHandler } from "hono";
import type { Ratelimit } from "./limiter.js";
import type { LimitResult } from "./types.js";

export interface RatelimitMiddlewareConfig {
  limiter: Ratelimit;
  key?: (c: Context) => string | Promise<string>;
  rate?: number | ((c: Context) => number | Promise<number>);
  response?: (c: Context, result: LimitResult) => Response | Promise<Response>;
}

function defaultKey(c: Context): string {
  const realIp = c.req.header("x-real-ip");
  if (realIp) {
    return realIp;
  }
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return "anonymous";
}

export function ratelimit(config: RatelimitMiddlewareConfig): MiddlewareHandler {
  const { limiter, key = defaultKey, rate: rateCfg = 1, response: customResponse } = config;

  return async (c, next) => {
    const identifier = await key(c);
    const rate = typeof rateCfg === "function" ? await rateCfg(c) : rateCfg;
    const result = await limiter.limit(identifier, { rate });

    c.header("RateLimit-Limit", String(result.limit));
    c.header("RateLimit-Remaining", String(result.remaining));
    c.header("RateLimit-Reset", String(Math.ceil(result.reset / 1000)));

    if (!result.success) {
      const retryAfter = Math.ceil((result.reset - Date.now()) / 1000);
      c.header("Retry-After", String(Math.max(0, retryAfter)));

      if (customResponse) {
        return customResponse(c, result);
      }

      return c.json({ error: "Too many requests" }, 429);
    }

    await next();
  };
}
