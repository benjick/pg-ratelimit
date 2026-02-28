# pg-ratelimit

PostgreSQL-backed rate limiting for Node.js. No Redis required.

```typescript
import { Pool } from "pg";
import { Ratelimit } from "pg-ratelimit";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ratelimit = new Ratelimit({
  pool,
  limiter: Ratelimit.slidingWindow(10, "1m"),
  prefix: "api",
});

const { success } = await ratelimit.limit("user:123");
```

## Features

- **Three algorithms** - fixed window, sliding window, token bucket
- **Zero runtime deps** - just `pg` as a peer dependency
- **Serverless-safe** - no background processes, probabilistic inline cleanup, no long-lived state
- **Upstash-compatible API** - same `limit()`, `blockUntilReady()`, `getRemaining()`, `resetUsedTokens()` surface

## Install

```bash
npm install pg-ratelimit pg
```

## Docs

[benjick.js.org/pg-ratelimit](https://benjick.js.org/pg-ratelimit)

## License

MIT
