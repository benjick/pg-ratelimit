CREATE UNLOGGED TABLE IF NOT EXISTS rate_limit_ephemeral (
  prefix       TEXT NOT NULL,
  key          TEXT NOT NULL,
  count        BIGINT,
  prev_count   BIGINT,
  window_start TIMESTAMPTZ,
  tokens       DOUBLE PRECISION,
  last_refill  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (prefix, key)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_ephemeral_cleanup
  ON rate_limit_ephemeral (prefix, expires_at);

CREATE TABLE IF NOT EXISTS rate_limit_durable (
  prefix       TEXT NOT NULL,
  key          TEXT NOT NULL,
  count        BIGINT,
  prev_count   BIGINT,
  window_start TIMESTAMPTZ,
  tokens       DOUBLE PRECISION,
  last_refill  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (prefix, key)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_durable_cleanup
  ON rate_limit_durable (prefix, expires_at);
