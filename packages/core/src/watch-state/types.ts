import type {
  WatchIdentity,
  WatchKind,
  WatchSnapshot,
  WatchStateRow,
} from '../db/repositories/watch-state.js';

export type { WatchIdentity, WatchKind, WatchSnapshot, WatchStateRow };

export interface ContentRef {
  /** Stremio type used for meta and stream requests (`movie`, `series`, `anime`, ...). */
  type: string;
  /** The meta id (`tt0903747`, `kitsu:123`, `ctmdb.531241`). */
  baseId: string;
  season?: number | null;
  episode?: number | null;
  /** The exact stream id for episodes and boxset children. */
  videoId?: string | null;
}

export function itemKeyFor(ref: ContentRef): string {
  if (ref.episode != null) {
    return `${ref.type}|${ref.baseId}|${ref.season ?? 1}|${ref.episode}`;
  }
  return `${ref.type}|${ref.baseId}`;
}

export function seriesKeyFor(ref: ContentRef): string | null {
  return ref.episode != null ? `${ref.type}|${ref.baseId}` : null;
}

export function identityFor(ref: ContentRef): WatchIdentity {
  return {
    itemKey: itemKeyFor(ref),
    mediaType: ref.type,
    baseId: ref.baseId,
    season: ref.episode != null ? (ref.season ?? 1) : null,
    episode: ref.episode ?? null,
    videoId: ref.videoId ?? null,
    seriesKey: seriesKeyFor(ref),
  };
}

export interface WatchProgressEvent {
  type: 'start' | 'progress' | 'stop';
  identity: WatchIdentity;
  positionMs?: number;
  durationMs?: number;
  snapshot?: WatchSnapshot;
}

export interface WatchFlagEvent {
  type: 'played' | 'unplayed' | 'favorite' | 'unfavorite';
  identity: WatchIdentity;
  snapshot?: WatchSnapshot;
}

export type WatchEvent = WatchProgressEvent | WatchFlagEvent;

export type WatchChangeListener = (uuid: string, rows: WatchStateRow[]) => void;

export interface WatchStateProvider {
  getMany(
    uuid: string,
    itemKeys: string[]
  ): Promise<Map<string, WatchStateRow>>;
  listResume(
    uuid: string,
    limit: number,
    kinds?: WatchKind[]
  ): Promise<WatchStateRow[]>;
  listRecentSeries(uuid: string, limit: number): Promise<WatchStateRow[]>;
  listFavorites(uuid: string, kinds?: WatchKind[]): Promise<WatchStateRow[]>;
  listPlayed(uuid: string, kinds?: WatchKind[]): Promise<WatchStateRow[]>;
  listForSeries(uuid: string, seriesKey: string): Promise<WatchStateRow[]>;
  record(uuid: string, event: WatchEvent): Promise<WatchStateRow | null>;
  onChange(listener: WatchChangeListener): () => void;
  flush(): Promise<void>;
}
