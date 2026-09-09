import type { Migration } from './types.js';

/**
 * Outbound playback reporting: one row per addon a configuration reports to,
 * holding only its health, and a durable queue of events waiting to leave.
 * Times are epoch ms. A delivery row carries the whole request, because a
 * background worker cannot decrypt a configuration to rebuild it later, and
 * `idempotency_key` is the item, the event and a one-minute bucket, so a
 * client that reports one stop twice scrobbles once.
 */
export const playbackHandoff: Migration = {
  id: 29,
  name: 'playback_handoff',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS watch_state_sinks (
        id                TEXT PRIMARY KEY,
        uuid              TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        addon_instance_id TEXT NOT NULL,
        addon_name        TEXT,
        base_url          TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'connected',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_push_at      INTEGER,
        last_error        TEXT,
        last_error_kind   TEXT,
        created_at        INTEGER NOT NULL DEFAULT 0,
        updated_at        INTEGER NOT NULL DEFAULT 0,
        UNIQUE (uuid, addon_instance_id)
      );

      CREATE INDEX IF NOT EXISTS idx_watch_state_sinks_uuid
        ON watch_state_sinks (uuid);

      CREATE TABLE IF NOT EXISTS watch_state_deliveries (
        id              TEXT PRIMARY KEY,
        sink_id         TEXT NOT NULL REFERENCES watch_state_sinks(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        event           TEXT NOT NULL,
        item_key        TEXT NOT NULL,
        url             TEXT NOT NULL,
        body            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        created_at      INTEGER NOT NULL DEFAULT 0,
        updated_at      INTEGER NOT NULL DEFAULT 0,
        delivered_at    INTEGER,
        UNIQUE (sink_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_watch_state_deliveries_due
        ON watch_state_deliveries (status, next_attempt_at);

      CREATE INDEX IF NOT EXISTS idx_watch_state_deliveries_sink
        ON watch_state_deliveries (sink_id, status);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS watch_state_sinks (
        id                TEXT PRIMARY KEY,
        uuid              TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        addon_instance_id TEXT NOT NULL,
        addon_name        TEXT,
        base_url          TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'connected',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_push_at      BIGINT,
        last_error        TEXT,
        last_error_kind   TEXT,
        created_at        BIGINT NOT NULL DEFAULT 0,
        updated_at        BIGINT NOT NULL DEFAULT 0,
        UNIQUE (uuid, addon_instance_id)
      );

      CREATE INDEX IF NOT EXISTS idx_watch_state_sinks_uuid
        ON watch_state_sinks (uuid);

      CREATE TABLE IF NOT EXISTS watch_state_deliveries (
        id              TEXT PRIMARY KEY,
        sink_id         TEXT NOT NULL REFERENCES watch_state_sinks(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        event           TEXT NOT NULL,
        item_key        TEXT NOT NULL,
        url             TEXT NOT NULL,
        body            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at BIGINT NOT NULL DEFAULT 0,
        last_error      TEXT,
        created_at      BIGINT NOT NULL DEFAULT 0,
        updated_at      BIGINT NOT NULL DEFAULT 0,
        delivered_at    BIGINT,
        UNIQUE (sink_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_watch_state_deliveries_due
        ON watch_state_deliveries (status, next_attempt_at);

      CREATE INDEX IF NOT EXISTS idx_watch_state_deliveries_sink
        ON watch_state_deliveries (sink_id, status);
    `,
  },
};
