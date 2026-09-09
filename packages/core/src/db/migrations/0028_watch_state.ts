import type { Migration } from './types.js';

/**
 * Per-configuration watch state keyed by content identity, plus the two small
 * tables the Jellyfin-compatible API needs: hashed item ids that cannot be
 * rebuilt from their Stremio id, and client display preferences.
 *
 * `item_key` is `"{type}|{baseId}"` for movies and series and
 * `"{type}|{baseId}|{season}|{episode}"` for episodes. Times are epoch ms.
 */
export const watchState: Migration = {
  id: 28,
  name: 'watch_state',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS user_watch_state (
        uuid            TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        item_key        TEXT NOT NULL,
        media_type      TEXT NOT NULL,
        base_id         TEXT NOT NULL,
        season          INTEGER,
        episode         INTEGER,
        video_id        TEXT,
        series_key      TEXT,
        position_ms     INTEGER NOT NULL DEFAULT 0,
        duration_ms     INTEGER NOT NULL DEFAULT 0,
        played          INTEGER NOT NULL DEFAULT 0,
        play_count      INTEGER NOT NULL DEFAULT 0,
        favorite        INTEGER NOT NULL DEFAULT 0,
        last_played_at  INTEGER,
        updated_at      INTEGER NOT NULL DEFAULT 0,
        snapshot        TEXT,
        PRIMARY KEY (uuid, item_key)
      );

      CREATE INDEX IF NOT EXISTS idx_user_watch_state_uuid_updated
        ON user_watch_state (uuid, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_user_watch_state_uuid_series
        ON user_watch_state (uuid, series_key);

      CREATE TABLE IF NOT EXISTS jellyfin_id_map (
        id        TEXT PRIMARY KEY,
        payload   TEXT NOT NULL,
        seen_at   INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_jellyfin_id_map_seen
        ON jellyfin_id_map (seen_at);

      CREATE TABLE IF NOT EXISTS jellyfin_display_prefs (
        uuid        TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        pref_id     TEXT NOT NULL,
        client      TEXT NOT NULL,
        payload     TEXT NOT NULL,
        updated_at  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (uuid, pref_id, client)
      );
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS user_watch_state (
        uuid            TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        item_key        TEXT NOT NULL,
        media_type      TEXT NOT NULL,
        base_id         TEXT NOT NULL,
        season          INTEGER,
        episode         INTEGER,
        video_id        TEXT,
        series_key      TEXT,
        position_ms     BIGINT NOT NULL DEFAULT 0,
        duration_ms     BIGINT NOT NULL DEFAULT 0,
        played          SMALLINT NOT NULL DEFAULT 0,
        play_count      INTEGER NOT NULL DEFAULT 0,
        favorite        SMALLINT NOT NULL DEFAULT 0,
        last_played_at  BIGINT,
        updated_at      BIGINT NOT NULL DEFAULT 0,
        snapshot        TEXT,
        PRIMARY KEY (uuid, item_key)
      );

      CREATE INDEX IF NOT EXISTS idx_user_watch_state_uuid_updated
        ON user_watch_state (uuid, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_user_watch_state_uuid_series
        ON user_watch_state (uuid, series_key);

      CREATE TABLE IF NOT EXISTS jellyfin_id_map (
        id        TEXT PRIMARY KEY,
        payload   TEXT NOT NULL,
        seen_at   BIGINT NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_jellyfin_id_map_seen
        ON jellyfin_id_map (seen_at);

      CREATE TABLE IF NOT EXISTS jellyfin_display_prefs (
        uuid        TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        pref_id     TEXT NOT NULL,
        client      TEXT NOT NULL,
        payload     TEXT NOT NULL,
        updated_at  BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (uuid, pref_id, client)
      );
    `,
  },
};
