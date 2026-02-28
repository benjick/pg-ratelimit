This is a [Next.js](https://nextjs.org) demo app for [pg-ratelimit](../../packages/pg-ratelimit/), a PostgreSQL-backed rate limiting library.

## Getting Started

First, copy the example env file:

```bash
cp .env.example .env.local
```

Then, run the development server (starts both Postgres via Docker and Next.js):

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

A dropdown lets you switch between all three algorithms:

- **Fixed Window** - 10 tokens per 10s window
- **Sliding Window** - 10 tokens per 10s, smoothed across windows
- **Token Bucket** - 1 token/s refill, 10 max burst

Three buttons demo different API methods:

- **Send Request** - consumes a token via `limit()`
- **Peek Remaining** - checks quota without consuming via `getRemaining()`
- **Wait & Send** - blocks until a token is available via `blockUntilReady()`

## How It Works

- `src/lib/strategies.ts` - Shared `Strategy` type and metadata
- `src/lib/ratelimit.ts` - One `Ratelimit` instance per algorithm, sharing a `Pool` singleton (survives Next.js hot reload)
- `src/actions/limit.ts` - Server actions that validate the strategy and delegate to the right limiter
- `src/app/page.tsx` - Client component with strategy picker and action buttons

## Learn More

To learn more about pg-ratelimit, take a look at the following resources:

- [pg-ratelimit Documentation](../../docs/) - learn about pg-ratelimit features and API.
- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
