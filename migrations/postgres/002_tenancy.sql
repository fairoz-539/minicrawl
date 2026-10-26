-- Multi-tenancy (v1.3): organizations, teams, hashed API keys, usage metering,
-- rate-limit counters and the audit log. Same tables as TENANCY_SCHEMA in src/db.js.

CREATE TABLE IF NOT EXISTS orgs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  settings   TEXT NOT NULL DEFAULT '{}',   -- {allowDomains, denyDomains}
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs (id),
  name            TEXT NOT NULL,
  limits          TEXT NOT NULL DEFAULT '{}', -- see TEAM_LIMITS in src/tenancy.js
  settings        TEXT NOT NULL DEFAULT '{}', -- {zdr, retentionHours, ipAllowlist}
  max_concurrency INTEGER,                    -- limits.concurrency, read by the job claim
  disabled        INTEGER NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_org_name_idx ON teams (org_id, name);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams (id),
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,               -- first characters, safe to display
  hash         TEXT NOT NULL UNIQUE,        -- sha256 of the key; the key itself is never stored
  role         TEXT NOT NULL,               -- owner | admin | member | viewer
  scopes       TEXT,                        -- JSON array, NULL = everything the role allows
  created_by   TEXT,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT,
  last_used_at BIGINT,
  revoked_at   BIGINT
);
CREATE INDEX IF NOT EXISTS api_keys_team_idx ON api_keys (team_id);

CREATE TABLE IF NOT EXISTS usage_daily (
  team_id TEXT NOT NULL,
  day     TEXT NOT NULL,                    -- YYYY-MM-DD (UTC)
  metric  TEXT NOT NULL,
  amount  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, day, metric)
);

CREATE TABLE IF NOT EXISTS rate_counters (
  bucket       TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  n            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      BIGSERIAL PRIMARY KEY,
  at      BIGINT NOT NULL,
  org_id  TEXT,
  team_id TEXT,
  key_id  TEXT,
  actor   TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  ip      TEXT,
  status  INTEGER,
  details TEXT
);
CREATE INDEX IF NOT EXISTS audit_org_at_idx ON audit_log (org_id, at);
CREATE INDEX IF NOT EXISTS audit_team_at_idx ON audit_log (team_id, at);

-- Every job and crawl belongs to a team. Rows from before 1.3 belong to "default".
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS expires_at BIGINT;
ALTER TABLE crawls ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE crawls ADD COLUMN IF NOT EXISTS expires_at BIGINT;
CREATE INDEX IF NOT EXISTS jobs_team_active_idx ON jobs (team_id) WHERE status = 'active';
