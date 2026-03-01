import { PostgreSqlContainer } from "@testcontainers/postgresql";
import autocannon from "autocannon";
import express from "express";
import { Pool } from "pg";
import { Ratelimit } from "pg-ratelimit";

const CONNECTIONS = parseInt(process.env.CONNECTIONS ?? "100", 10);
const DURATION = parseInt(process.env.DURATION ?? "30", 10);
const MAX_CONNECTIONS_PER_SECOND = parseInt(process.env.MAX_CONNECTIONS_PER_SECOND ?? "0", 10);
const PORT = 3210;
const KEYS = ["user1", "user2", "user3", "user4", "user5"];

interface RunConfig {
  label: string;
  inMemoryBlock: boolean;
}

async function runBenchmark(
  pool: Pool,
  config: RunConfig,
): Promise<{ result: autocannon.Result; accepted: number; rejected: number }> {
  const base = {
    pool,
    prefix: `bench-${config.label}`,
    limiter: Ratelimit.fixedWindow(5, "1s"),
  };
  const ratelimit = config.inMemoryBlock
    ? new Ratelimit({ ...base, inMemoryBlock: true })
    : new Ratelimit(base);

  // Warm up: ensure tables are created before benchmarking
  await ratelimit.limit("warmup");

  const app = express();

  let accepted = 0;
  let rejected = 0;

  app.get("/", async (_req, res) => {
    const key = KEYS[Math.floor(Math.random() * KEYS.length)]!;
    const result = await ratelimit.limit(key);
    if (result.success) {
      accepted++;
      res.status(200).json({ success: true });
    } else {
      rejected++;
      res.status(429).json({ success: false });
    }
  });

  const server = app.listen(PORT);
  console.log(`\n--- ${config.label} ---`);
  console.log(
    `Benchmark: ${CONNECTIONS} connections, ${DURATION}s duration` +
      (MAX_CONNECTIONS_PER_SECOND ? `, max ${MAX_CONNECTIONS_PER_SECOND} req/s` : "") +
      "\n",
  );

  const result = await autocannon({
    url: `http://localhost:${PORT}`,
    connections: CONNECTIONS,
    duration: DURATION,
    ...(MAX_CONNECTIONS_PER_SECOND ? { overallRate: MAX_CONNECTIONS_PER_SECOND } : {}),
  });

  server.close();

  return { result, accepted, rejected };
}

async function main() {
  console.log("Starting PostgreSQL container...");
  const container = await new PostgreSqlContainer().start();
  const connectionUri = container.getConnectionUri();
  console.log("PostgreSQL ready.");

  const pool = new Pool({
    connectionString: connectionUri,
    max: 20,
  });

  const configs: RunConfig[] = [
    { label: "without inMemoryBlock", inMemoryBlock: false },
    { label: "with inMemoryBlock", inMemoryBlock: true },
  ];

  // Warm up: ensure tables exist before any truncate
  const warmupRl = new Ratelimit({
    pool,
    prefix: "warmup",
    limiter: Ratelimit.fixedWindow(1, "1s"),
  });
  await warmupRl.limit("init");

  const results: {
    config: RunConfig;
    result: autocannon.Result;
    accepted: number;
    rejected: number;
  }[] = [];

  for (const config of configs) {
    // Reset rate limit state between runs
    await pool.query("TRUNCATE rate_limit_ephemeral, rate_limit_durable");
    const run = await runBenchmark(pool, config);
    results.push({ config, ...run });
  }

  console.log("\n\n========== RESULTS ==========\n");

  for (const { config, result, accepted, rejected } of results) {
    console.log(`--- ${config.label} ---`);
    console.log(autocannon.printResult(result));
    console.log("Requests breakdown:");
    console.log(`  Accepted (2xx): ${accepted}`);
    console.log(`  Rejected (429): ${rejected}`);
    console.log(`  Total:          ${accepted + rejected}`);
    console.log();
  }

  if (results.length === 2) {
    const [without, with_] = results;
    const avgWithout = without!.result.latency.average;
    const avgWith = with_!.result.latency.average;
    const rpsWithout = without!.result.requests.average;
    const rpsWith = with_!.result.requests.average;
    console.log("--- Comparison ---");
    console.log(
      `  Avg latency:  ${avgWithout.toFixed(2)}ms → ${avgWith.toFixed(2)}ms (${((1 - avgWith / avgWithout) * 100).toFixed(1)}% reduction)`,
    );
    console.log(
      `  Avg req/s:    ${rpsWithout.toFixed(0)} → ${rpsWith.toFixed(0)} (${((rpsWith / rpsWithout - 1) * 100).toFixed(1)}% increase)`,
    );
  }

  await pool.end();
  await container.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
