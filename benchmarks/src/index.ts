import cluster from "node:cluster";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import autocannon from "autocannon";
import express from "express";
import { Pool } from "pg";
import { Ratelimit } from "pg-ratelimit";

const CONNECTIONS = parseInt(process.env.CONNECTIONS ?? "100", 10);
const DURATION = parseInt(process.env.DURATION ?? "30", 10);
const MAX_CONNECTIONS_PER_SECOND = parseInt(process.env.MAX_CONNECTIONS_PER_SECOND ?? "0", 10);
const WORKERS = parseInt(process.env.WORKERS ?? "1", 10);
const PORT = 3210;
const KEYS = ["user1", "user2", "user3", "user4", "user5"];

interface RunConfig {
  label: string;
  inMemoryBlock: boolean;
}

// --- Worker process ---

function startWorker() {
  const connectionUri = process.env._BENCH_CONNECTION_URI!;
  const inMemoryBlock = process.env._BENCH_IN_MEMORY_BLOCK === "true";
  const prefix = process.env._BENCH_PREFIX!;

  const pool = new Pool({ connectionString: connectionUri, max: 20 });

  const base = { pool, prefix, limiter: Ratelimit.fixedWindow(5, "1s") };
  const ratelimit = inMemoryBlock
    ? new Ratelimit({ ...base, inMemoryBlock: true })
    : new Ratelimit(base);

  let accepted = 0;
  let rejected = 0;

  const app = express();

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

  app.listen(PORT);

  process.on("message", (msg: unknown) => {
    if (msg === "report") {
      process.send!({ accepted, rejected });
    } else if (msg === "reset") {
      accepted = 0;
      rejected = 0;
    }
  });
}

// --- Primary process ---

async function runBenchmark(
  workers: ReturnType<typeof cluster.fork>[],
  config: RunConfig,
): Promise<{ result: autocannon.Result; accepted: number; rejected: number }> {
  // Reset counters
  for (const w of workers) {
    w.send("reset");
  }

  console.log(`\n--- ${config.label} ---`);
  console.log(
    `Benchmark: ${CONNECTIONS} connections, ${DURATION}s duration, ${WORKERS} worker(s)` +
      (MAX_CONNECTIONS_PER_SECOND ? `, max ${MAX_CONNECTIONS_PER_SECOND} req/s` : "") +
      "\n",
  );

  const result = await autocannon({
    url: `http://localhost:${PORT}`,
    connections: CONNECTIONS,
    duration: DURATION,
    ...(MAX_CONNECTIONS_PER_SECOND ? { overallRate: MAX_CONNECTIONS_PER_SECOND } : {}),
  });

  // Collect counts from workers
  let accepted = 0;
  let rejected = 0;
  await Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((resolve) => {
          w.once("message", (msg: { accepted: number; rejected: number }) => {
            accepted += msg.accepted;
            rejected += msg.rejected;
            resolve();
          });
          w.send("report");
        }),
    ),
  );

  return { result, accepted, rejected };
}

async function runSingleProcess(
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
    `Benchmark: ${CONNECTIONS} connections, ${DURATION}s duration, 1 worker` +
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

function forkWorkers(connectionUri: string, config: RunConfig) {
  const workers: ReturnType<typeof cluster.fork>[] = [];
  for (let i = 0; i < WORKERS; i++) {
    workers.push(
      cluster.fork({
        _BENCH_CONNECTION_URI: connectionUri,
        _BENCH_IN_MEMORY_BLOCK: String(config.inMemoryBlock),
        _BENCH_PREFIX: `bench-${config.label}`,
      }),
    );
  }
  return workers;
}

async function waitForWorkers(workers: ReturnType<typeof cluster.fork>[]) {
  await Promise.all(
    workers.map((w) => new Promise<void>((resolve) => w.once("listening", () => resolve()))),
  );
}

function killWorkers(workers: ReturnType<typeof cluster.fork>[]) {
  for (const w of workers) {
    w.kill();
  }
}

async function main() {
  console.log("Starting PostgreSQL container...");
  const container = await new PostgreSqlContainer().start();
  const connectionUri = container.getConnectionUri();
  console.log("PostgreSQL ready.");

  const pool = new Pool({ connectionString: connectionUri, max: 20 });

  // Warm up: ensure tables exist
  const warmupRl = new Ratelimit({
    pool,
    prefix: "warmup",
    limiter: Ratelimit.fixedWindow(1, "1s"),
  });
  await warmupRl.limit("init");

  const configs: RunConfig[] = [
    { label: "without inMemoryBlock", inMemoryBlock: false },
    { label: "with inMemoryBlock", inMemoryBlock: true },
  ];

  const results: {
    config: RunConfig;
    result: autocannon.Result;
    accepted: number;
    rejected: number;
  }[] = [];

  for (const config of configs) {
    await pool.query("TRUNCATE rate_limit_ephemeral, rate_limit_durable");

    let run;
    if (WORKERS <= 1) {
      run = await runSingleProcess(pool, config);
    } else {
      const workers = forkWorkers(connectionUri, config);
      await waitForWorkers(workers);
      run = await runBenchmark(workers, config);
      killWorkers(workers);
    }
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

if (cluster.isPrimary) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  startWorker();
}
