import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Pool } from "pg";
import { Ratelimit } from "pg-ratelimit";
import { ratelimit } from "pg-ratelimit/hono";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:6724/ratelimit",
});

const limiter = new Ratelimit({
  pool,
  limiter: Ratelimit.slidingWindow(10, "10s"),
  prefix: "hono-demo",
});

const app = new Hono();

// Apply rate limiting to all /api/* routes
app.use("/api/*", ratelimit({ limiter }));

app.get("/", (c) => c.json({ message: "pg-ratelimit Hono demo", docs: "/api/hello" }));

app.get("/api/hello", (c) => c.json({ message: "Hello! You are within the rate limit." }));

app.get("/api/time", (c) => c.json({ time: new Date().toISOString() }));

serve({ fetch: app.fetch, port: 3001 }, (info) => {
  console.log(`Hono server running at http://localhost:${info.port}`);
});
