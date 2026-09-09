import { getDb } from '../db.js';
import { join, sql } from '../sql.js';

/** What a list row needs to render without a metadata call. */
export interface WatchSnapshot {
  name?: string;
  seriesName?: string;
  poster?: string;
  backdrop?: string;
  thumb?: string;
  indexNumber?: number;
  parentIndexNumber?: number;
  runtimeMs?: number;
}

/** Content identity of one row. `itemKey` is the primary key with the uuid. */
export interface WatchIdentity {
  itemKey: string;
  mediaType: string;
  baseId: string;
  season?: number | null;
  episode?: number | null;
  videoId?: string | null;
  seriesKey?: string | null;
}

export interface WatchStateRow extends WatchIdentity {
  uuid: string;
  positionMs: number;
  durationMs: number;
  played: boolean;
  playCount: number;
  favorite: boolean;
  lastPlayedAt: number | null;
  updatedAt: number;
  snapshot: WatchSnapshot | null;
}

export interface WatchStatePatch {
  positionMs?: number;
  durationMs?: number;
  played?: boolean;
  incrementPlayCount?: boolean | 'if-unplayed';
  favorite?: boolean;
  /** `null` clears it; `undefined` leaves it alone. */
  lastPlayedAt?: number | null;
  snapshot?: WatchSnapshot;
}

export type WatchKind = 'movie' | 'series' | 'episode';

interface DbRow {
  uuid: string;
  item_key: string;
  media_type: string;
  base_id: string;
  season: number | string | null;
  episode: number | string | null;
  video_id: string | null;
  series_key: string | null;
  position_ms: number | string;
  duration_ms: number | string;
  played: number | string;
  play_count: number | string;
  favorite: number | string;
  last_played_at: number | string | null;
  updated_at: number | string;
  snapshot: string | null;
  [k: string]: unknown;
}

const CHUNK = 200;

function optionalNumber(v: number | string | null): number | null {
  return v == null ? null : Number(v);
}

function toRow(r: DbRow): WatchStateRow {
  let snapshot: WatchSnapshot | null = null;
  if (r.snapshot) {
    try {
      snapshot = JSON.parse(r.snapshot) as WatchSnapshot;
    } catch {
      snapshot = null;
    }
  }
  return {
    uuid: r.uuid,
    itemKey: r.item_key,
    mediaType: r.media_type,
    baseId: r.base_id,
    season: optionalNumber(r.season),
    episode: optionalNumber(r.episode),
    videoId: r.video_id,
    seriesKey: r.series_key,
    positionMs: Number(r.position_ms),
    durationMs: Number(r.duration_ms),
    played: Boolean(Number(r.played)),
    playCount: Number(r.play_count),
    favorite: Boolean(Number(r.favorite)),
    lastPlayedAt: optionalNumber(r.last_played_at),
    updatedAt: Number(r.updated_at),
    snapshot,
  };
}

export function watchKindOf(
  row: Pick<WatchIdentity, 'mediaType' | 'episode'>
): WatchKind {
  if (row.episode != null) return 'episode';
  return row.mediaType === 'movie' ? 'movie' : 'series';
}

function filterKinds(rows: WatchStateRow[], kinds?: WatchKind[]) {
  if (!kinds?.length) return rows;
  return rows.filter((r) => kinds.includes(watchKindOf(r)));
}

export class WatchStateRepository {
  static async get(
    uuid: string,
    itemKey: string
  ): Promise<WatchStateRow | null> {
    const row = await getDb().maybeOne<DbRow>(
      sql`SELECT * FROM user_watch_state WHERE uuid = ${uuid} AND item_key = ${itemKey}`
    );
    return row ? toRow(row) : null;
  }

  static async getMany(
    uuid: string,
    itemKeys: string[]
  ): Promise<Map<string, WatchStateRow>> {
    const out = new Map<string, WatchStateRow>();
    const wanted = [...new Set(itemKeys.filter(Boolean))];
    for (let i = 0; i < wanted.length; i += CHUNK) {
      const slice = wanted.slice(i, i + CHUNK);
      const rows = await getDb().query<DbRow>(
        sql`SELECT * FROM user_watch_state
             WHERE uuid = ${uuid} AND item_key IN (${join(slice.map((k) => sql`${k}`))})`
      );
      for (const r of rows) out.set(r.item_key, toRow(r));
    }
    return out;
  }

  static async upsert(
    uuid: string,
    identity: WatchIdentity,
    patch: WatchStatePatch
  ): Promise<WatchStateRow> {
    const now = Date.now();
    const pos = patch.positionMs ?? null;
    const dur = patch.durationMs ?? null;
    const played = patch.played == null ? null : patch.played ? 1 : 0;
    const fav = patch.favorite == null ? null : patch.favorite ? 1 : 0;
    const incMode =
      patch.incrementPlayCount === 'if-unplayed'
        ? 2
        : patch.incrementPlayCount
          ? 1
          : 0;
    const setLastPlayed = patch.lastPlayedAt === undefined ? 0 : 1;
    const lastPlayed = patch.lastPlayedAt ?? null;
    const snapshot = patch.snapshot ? JSON.stringify(patch.snapshot) : null;
    const season = identity.season ?? null;
    const episode = identity.episode ?? null;
    const videoId = identity.videoId ?? null;
    const seriesKey = identity.seriesKey ?? null;

    await getDb().exec(
      sql`INSERT INTO user_watch_state
            (uuid, item_key, media_type, base_id, season, episode, video_id, series_key,
             position_ms, duration_ms, played, play_count, favorite, last_played_at,
             updated_at, snapshot)
          VALUES (${uuid}, ${identity.itemKey}, ${identity.mediaType}, ${identity.baseId},
                  ${season}, ${episode}, ${videoId}, ${seriesKey},
                  COALESCE(${pos}, 0), COALESCE(${dur}, 0), COALESCE(${played}, 0),
                  CASE WHEN ${incMode} > 0 THEN 1 ELSE 0 END,
                  COALESCE(${fav}, 0), ${lastPlayed}, ${now}, ${snapshot})
          ON CONFLICT(uuid, item_key) DO UPDATE SET
            media_type = excluded.media_type,
            base_id = excluded.base_id,
            season = excluded.season,
            episode = excluded.episode,
            video_id = COALESCE(excluded.video_id, user_watch_state.video_id),
            series_key = COALESCE(excluded.series_key, user_watch_state.series_key),
            position_ms = COALESCE(${pos}, user_watch_state.position_ms),
            duration_ms = COALESCE(${dur}, user_watch_state.duration_ms),
            played = COALESCE(${played}, user_watch_state.played),
            play_count = user_watch_state.play_count +
              CASE ${incMode}
                WHEN 1 THEN 1
                WHEN 2 THEN CASE WHEN user_watch_state.played = 1 THEN 0 ELSE 1 END
                ELSE 0
              END,
            favorite = COALESCE(${fav}, user_watch_state.favorite),
            last_played_at = CASE WHEN ${setLastPlayed} = 1 THEN ${lastPlayed} ELSE user_watch_state.last_played_at END,
            updated_at = excluded.updated_at,
            snapshot = COALESCE(${snapshot}, user_watch_state.snapshot)`
    );

    const row = await this.get(uuid, identity.itemKey);
    if (row) return row;
    return {
      uuid,
      ...identity,
      season,
      episode,
      videoId,
      seriesKey,
      positionMs: pos ?? 0,
      durationMs: dur ?? 0,
      played: !!played,
      playCount: incMode > 0 ? 1 : 0,
      favorite: !!fav,
      lastPlayedAt: lastPlayed,
      updatedAt: now,
      snapshot: patch.snapshot ?? null,
    };
  }

  static async delete(uuid: string, itemKey: string): Promise<void> {
    await getDb().exec(
      sql`DELETE FROM user_watch_state WHERE uuid = ${uuid} AND item_key = ${itemKey}`
    );
  }

  /** In-progress items, newest activity first. */
  static async listResume(
    uuid: string,
    limit: number,
    kinds: WatchKind[] = ['movie', 'episode']
  ): Promise<WatchStateRow[]> {
    const rows = await getDb().query<DbRow>(
      sql`SELECT * FROM user_watch_state
           WHERE uuid = ${uuid} AND played = 0 AND position_ms > 0
           ORDER BY updated_at DESC
           LIMIT ${Math.max(limit * 3, 30)}`
    );
    return filterKinds(rows.map(toRow), kinds).slice(0, limit);
  }

  /** The most recently touched episode per series, for Next Up. */
  static async listRecentSeries(
    uuid: string,
    limit: number
  ): Promise<WatchStateRow[]> {
    const rows = await getDb().query<DbRow>(
      sql`SELECT * FROM user_watch_state
           WHERE uuid = ${uuid} AND series_key IS NOT NULL
             AND (played = 1 OR position_ms > 0)
           ORDER BY updated_at DESC
           LIMIT 500`
    );
    const seen = new Set<string>();
    const out: WatchStateRow[] = [];
    for (const r of rows.map(toRow)) {
      if (r.episode == null || !r.seriesKey) continue;
      if (seen.has(r.seriesKey)) continue;
      seen.add(r.seriesKey);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  static async listFavorites(
    uuid: string,
    kinds?: WatchKind[]
  ): Promise<WatchStateRow[]> {
    const rows = await getDb().query<DbRow>(
      sql`SELECT * FROM user_watch_state
           WHERE uuid = ${uuid} AND favorite = 1
           ORDER BY updated_at DESC
           LIMIT 500`
    );
    return filterKinds(rows.map(toRow), kinds);
  }

  static async listPlayed(
    uuid: string,
    kinds?: WatchKind[]
  ): Promise<WatchStateRow[]> {
    const rows = await getDb().query<DbRow>(
      sql`SELECT * FROM user_watch_state
           WHERE uuid = ${uuid} AND played = 1
           ORDER BY updated_at DESC
           LIMIT 500`
    );
    return filterKinds(rows.map(toRow), kinds);
  }

  static async listForSeries(
    uuid: string,
    seriesKey: string
  ): Promise<WatchStateRow[]> {
    const rows = await getDb().query<DbRow>(
      sql`SELECT * FROM user_watch_state
           WHERE uuid = ${uuid} AND series_key = ${seriesKey}`
    );
    return rows.map(toRow).filter((r) => r.episode != null);
  }

  static async prune(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const res = await getDb().exec(
      sql`DELETE FROM user_watch_state WHERE updated_at < ${cutoff}`
    );
    return res.rowCount ?? 0;
  }
}
