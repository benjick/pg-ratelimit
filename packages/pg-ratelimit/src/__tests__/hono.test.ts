import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { ratelimit } from "../hono.js";
import type { LimitResult } from "../types.js";
import type { Ratelimit } from "../limiter.js";

function mockLimiter(result: LimitResult): Ratelimit {
  return { limit: vi.fn().mockResolvedValue(result) } as unknown as Ratelimit;
}

const allowed: LimitResult = { success: true, limit: 10, remaining: 9, reset: Date.now() + 10000 };
const blocked: LimitResult = { success: false, limit: 10, remaining: 0, reset: Date.now() + 5000 };

describe("ratelimit middleware", () => {
  it("allows requests and sets rate limit headers", async () => {
    const app = new Hono();
    app.use(ratelimit({ limiter: mockLimiter(allowed) }));
    app.get("/", (c) => c.text("ok"));

    const res = await app.request("/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("RateLimit-Limit")).toBe("10");
    expect(res.headers.get("RateLimit-Remaining")).toBe("9");
    expect(res.headers.get("RateLimit-Reset")).toBeTruthy();
  });

  it("returns 429 with Retry-After when blocked", async () => {
    const app = new Hono();
    app.use(ratelimit({ limiter: mockLimiter(blocked) }));
    app.get("/", (c) => c.text("ok"));

    const res = await app.request("/");

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(res.headers.get("RateLimit-Remaining")).toBe("0");
    const body = await res.json();
    expect(body.error).toBe("Too many requests");
  });

  it("uses custom key extractor", async () => {
    const limiter = mockLimiter(allowed);
    const app = new Hono();
    app.use(
      ratelimit({
        limiter,
        key: (c) => c.req.header("x-api-key") ?? "anonymous",
      }),
    );
    app.get("/", (c) => c.text("ok"));

    await app.request("/", { headers: { "x-api-key": "test-key-123" } });

    expect(limiter.limit).toHaveBeenCalledWith("test-key-123", { rate: 1 });
  });

  it("uses custom response handler", async () => {
    const app = new Hono();
    app.use(
      ratelimit({
        limiter: mockLimiter(blocked),
        response: (c) => c.json({ custom: "nope" }, 429),
      }),
    );
    app.get("/", (c) => c.text("ok"));

    const res = await app.request("/");

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.custom).toBe("nope");
  });

  it("propagates limiter errors", async () => {
    const limiter = {
      limit: vi.fn().mockRejectedValue(new Error("DB down")),
    } as unknown as Ratelimit;

    const app = new Hono();
    app.use(ratelimit({ limiter }));
    app.get("/", (c) => c.text("ok"));
    app.onError((err, c) => c.json({ error: err.message }, 500));

    const res = await app.request("/");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("DB down");
  });

  it("supports rate as a number", async () => {
    const limiter = mockLimiter(allowed);
    const app = new Hono();
    app.use(ratelimit({ limiter, rate: 5 }));
    app.get("/", (c) => c.text("ok"));

    await app.request("/");

    expect(limiter.limit).toHaveBeenCalledWith("anonymous", { rate: 5 });
  });

  it("supports rate as a function", async () => {
    const limiter = mockLimiter(allowed);
    const app = new Hono();
    app.use(
      ratelimit({
        limiter,
        rate: (c) => (c.req.path === "/heavy" ? 10 : 1),
      }),
    );
    app.get("/heavy", (c) => c.text("ok"));

    await app.request("/heavy");

    expect(limiter.limit).toHaveBeenCalledWith("anonymous", { rate: 10 });
  });

  it("extracts key from x-real-ip by default", async () => {
    const limiter = mockLimiter(allowed);
    const app = new Hono();
    app.use(ratelimit({ limiter }));
    app.get("/", (c) => c.text("ok"));

    await app.request("/", { headers: { "x-real-ip": "9.8.7.6" } });

    expect(limiter.limit).toHaveBeenCalledWith("9.8.7.6", { rate: 1 });
  });

  it("prefers x-real-ip over x-forwarded-for", async () => {
    const limiter = mockLimiter(allowed);
    const app = new Hono();
    app.use(ratelimit({ limiter }));
    app.get("/", (c) => c.text("ok"));

    await app.request("/", { headers: { "x-real-ip": "9.8.7.6", "x-forwarded-for": "1.2.3.4" } });

    expect(limiter.limit).toHaveBeenCalledWith("9.8.7.6", { rate: 1 });
  });

  it("falls back to x-forwarded-for when no x-real-ip", async () => {
    const limiter = mockLimiter(allowed);
    const app = new Hono();
    app.use(ratelimit({ limiter }));
    app.get("/", (c) => c.text("ok"));

    await app.request("/", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });

    expect(limiter.limit).toHaveBeenCalledWith("1.2.3.4", { rate: 1 });
  });
});
