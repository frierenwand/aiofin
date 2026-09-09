import { config as appConfig } from '../config/index.js';
import type { MetaPreview, UserData } from '../db/schemas.js';
import type { AIOStreams } from '../main/index.js';
import { Cache } from '../utils/cache.js';
import { createLogger } from '../logging/logger.js';
import { userScopeKey } from '../utils/user-scope.js';
import { viewId } from './ids.js';
import type { Catalog, CollectionType } from './dto.js';

const logger = createLogger('jellyfin');

export function catalogKey(c: Pick<Catalog, 'type' | 'id'>): string {
  return `${c.type}|${c.id}`;
}

function extra(c: Catalog, name: string) {
  return (c.extra ?? []).find((e) => e.name === name);
}

export function supportsExtra(c: Catalog, name: string): boolean {
  return !!extra(c, name);
}

/** Genre a required-genre catalog is browsed with when the client picks none. */
export function requiredGenreDefault(c: Catalog): string | undefined {
  const e = extra(c, 'genre');
  if (!e?.isRequired) return undefined;
  return (e.options ?? []).find(
    (o): o is string => typeof o === 'string' && o.length > 0
  );
}

export function genreOptions(c: Catalog): string[] {
  return (extra(c, 'genre')?.options ?? []).filter(
    (o): o is string => typeof o === 'string' && o.length > 0
  );
}

/** Catalogs a client can open as a library: not search-only, no unsatisfiable required extra. */
export function isBrowsable(c: Catalog): boolean {
  for (const e of c.extra ?? []) {
    if (!e.isRequired) continue;
    if (e.name === 'genre' && requiredGenreDefault(c)) continue;
    return false;
  }
  return true;
}

export function isSearchable(c: Catalog): boolean {
  return supportsExtra(c, 'search');
}

/** Libraries are the user's catalogs, in their order. */
export function exposedCatalogs(engine: AIOStreams): Catalog[] {
  return ((engine.getCatalogs() ?? []) as Catalog[]).filter(isBrowsable);
}

export interface CatalogPageOptions {
  startIndex: number;
  limit: number;
  genre?: string;
  search?: string;
  /** Walk to the end (or the cap) so the total is exact. */
  exactTotal?: boolean;
  /**
   * Narrows one raw page to the entries the caller will return.
   */
  select?: (page: MetaPreview[]) => MetaPreview[] | Promise<MetaPreview[]>;
  /**
   * Scope for resuming the walk instead of restarting it
   */
  cursorKey?: string;
}

/** A page boundary the walk passed through. */
interface WalkMark {
  index: number;
  skip: number;
  read: number;
}

/**
 * Where a walk has already been, so a later page resumes from the nearest
 * boundary at or below its StartIndex rather than counting the catalog again.
 */
interface WalkTrail {
  /** Deduped entry keys in order; `keys.slice(0, mark.read)` is that mark's dedupe set. */
  keys: string[];
  marks: WalkMark[];
  done: boolean;
}

const walkTrailCache = Cache.getInstance<string, WalkTrail>(
  'jellyfin-catalog-trail',
  5000
);
/* Matches the catalog cache default, so a trail never outlives its pages. */
const WALK_TRAIL_TTL = 300;

function markFor(trail: WalkTrail, startIndex: number): WalkMark | undefined {
  let best: WalkMark | undefined;
  for (const mark of trail.marks)
    if (mark.index <= startIndex && (!best || mark.index > best.index))
      best = mark;
  return best;
}

async function saveTrail(key: string, trail: WalkTrail): Promise<void> {
  const existing = await walkTrailCache.get(key).catch(() => undefined);
  const merged: WalkTrail = existing
    ? {
        keys:
          existing.keys.length > trail.keys.length ? existing.keys : trail.keys,
        marks: [...existing.marks, ...trail.marks],
        done: existing.done || trail.done,
      }
    : trail;
  const byIndex = new Map(merged.marks.map((m) => [m.index, m]));
  merged.marks = [...byIndex.values()].sort((a, b) => a.index - b.index);
  await walkTrailCache.set(key, merged, WALK_TRAIL_TTL).catch(() => undefined);
}

export interface CatalogPage {
  items: MetaPreview[];
  total: number;
  hasMore: boolean;
}

function buildExtras(
  c: Catalog,
  opts: { genre?: string; search?: string; skip?: number }
): string | undefined {
  const parts: string[] = [];
  if (opts.search) parts.push(`search=${opts.search.replace(/[&=]/g, ' ')}`);
  const genre =
    opts.genre ?? (opts.search ? undefined : requiredGenreDefault(c));
  if (genre) parts.push(`genre=${genre.replace(/[&=]/g, ' ')}`);
  if (opts.skip) parts.push(`skip=${opts.skip}`);
  return parts.length ? parts.join('&') : undefined;
}

/**
 * Maps StartIndex/Limit onto Stremio skip pages. Returns `limit` items unless
 * the catalog ends first. `maxCatalogItems` bounds the raw entries read, not the
 * entries that survive `select`.
 */
export async function getCatalogPage(
  engine: AIOStreams,
  catalog: Catalog,
  opts: CatalogPageOptions
): Promise<CatalogPage> {
  if (opts.search && !isSearchable(catalog))
    return { items: [], total: 0, hasMore: false };
  if (opts.genre && !supportsExtra(catalog, 'genre'))
    return { items: [], total: 0, hasMore: false };

  const cap = appConfig.jellyfin.maxCatalogItems || Infinity;
  const canSkip = supportsExtra(catalog, 'skip');
  const wantEnd = opts.startIndex + opts.limit;
  const out: MetaPreview[] = [];
  const seen = new Set<string>();
  let read = 0;
  let offset = 0;
  let skip = 0;
  let stalled = 0;
  let exhausted = false;
  let capped = false;
  let guard = 0;

  const cursorKey =
    opts.cursorKey && canSkip
      ? `${opts.cursorKey}|${catalogKey(catalog)}|${opts.genre ?? ''}|${opts.search ?? ''}`
      : undefined;
  /* Ordered mirror of `seen`, so a boundary can name its own dedupe prefix. */
  const seenKeys: string[] = [];
  const marks: WalkMark[] = [];
  if (cursorKey && opts.startIndex > 0) {
    const trail = await walkTrailCache.get(cursorKey).catch(() => undefined);
    const mark = trail && markFor(trail, opts.startIndex);
    if (trail && mark) {
      offset = mark.index;
      skip = mark.skip;
      read = mark.read;
      for (const key of trail.keys.slice(0, mark.read)) {
        seen.add(key);
        seenKeys.push(key);
      }
    }
  }
  while (!exhausted && guard++ < 60) {
    if (!opts.exactTotal && offset >= wantEnd) break;
    if (read >= cap) {
      capped = true;
      break;
    }
    // Taken before the page is consumed: a mark is only usable by a request
    // whose StartIndex it does not overshoot, so it has to sit on a boundary.
    if (cursorKey) marks.push({ index: offset, skip, read });
    const extras = buildExtras(catalog, {
      genre: opts.genre,
      search: opts.search,
      skip,
    });
    const res = await engine.getCatalog(catalog.type, catalog.id, extras);
    const data = res.data ?? [];
    if (res.errors?.length) {
      logger.debug(
        { catalog: catalogKey(catalog), errors: res.errors.length },
        'catalog page returned errors'
      );
    }
    if (!data.length) {
      exhausted = true;
      break;
    }
    const fresh: MetaPreview[] = [];
    for (const item of data) {
      if (!item?.id) continue;
      const key = `${item.type}|${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seenKeys.push(key);
      fresh.push(item);
    }
    read += fresh.length;
    for (const item of opts.select ? await opts.select(fresh) : fresh) {
      if (offset >= opts.startIndex && offset < wantEnd) out.push(item);
      offset++;
    }
    skip += data.length;
    // Consecutive pages of nothing but repeats mean skip stopped advancing.
    stalled = fresh.length ? 0 : stalled + 1;
    if (!canSkip || stalled >= 3) exhausted = true;
  }

  const done = exhausted || capped;
  const total = done ? offset : offset + opts.limit;
  if (cursorKey && marks.length)
    await saveTrail(cursorKey, { keys: seenKeys, marks, done });
  return { items: out, total, hasMore: !done };
}

const viewTypeCache = Cache.getInstance<string, string[]>(
  'jellyfin-views',
  20_000
);
const VIEW_TYPE_TTL = 300;

async function entryTypesOf(
  engine: AIOStreams,
  userData: UserData,
  catalog: Catalog
): Promise<string[]> {
  const key = `${userScopeKey(userData)}|${catalogKey(catalog)}`;
  const cached = await viewTypeCache.get(key).catch(() => undefined);
  if (cached) return cached;
  let types: string[] = [];
  try {
    const page = await getCatalogPage(engine, catalog, {
      startIndex: 0,
      limit: 20,
    });
    types = [...new Set(page.items.map((m) => m.type).filter(Boolean))];
  } catch (error) {
    logger.debug(
      {
        catalog: catalogKey(catalog),
        err: error instanceof Error ? error.message : String(error),
      },
      'could not sniff catalog entry types'
    );
  }
  void viewTypeCache.set(key, types, VIEW_TYPE_TTL).catch(() => undefined);
  return types;
}

export type ViewKind = CollectionType | 'mixed' | 'hidden';

export function collectionTypeFor(
  catalog: Catalog,
  entryTypes: string[]
): ViewKind {
  const set = new Set(entryTypes);
  const playable = [...set].filter((t) => t !== 'tv' && t !== 'channel');
  if (set.size && !playable.length) return 'hidden';
  const boxsets = /collection/i.test(
    `${catalog.type} ${catalog.id} ${catalog.name}`
  );
  if (playable.length) {
    if (playable.every((t) => t === 'movie'))
      return boxsets ? 'boxsets' : 'movies';
    if (playable.every((t) => t === 'series' || t === 'anime'))
      return 'tvshows';
    return 'mixed';
  }
  if (boxsets) return 'boxsets';
  switch (catalog.type) {
    case 'movie':
      return 'movies';
    case 'series':
    case 'anime':
      return 'tvshows';
    case 'tv':
    case 'channel':
      return 'hidden';
    default:
      return 'mixed';
  }
}

/** The view's `CollectionType`, absent when the catalog is not one kind. */
export function viewCollectionType(
  catalog: Catalog,
  entryTypes: string[]
): CollectionType | undefined {
  const kind = collectionTypeFor(catalog, entryTypes);
  return kind === 'mixed' || kind === 'hidden' ? undefined : kind;
}

export interface ViewEntry {
  id: string;
  catalog: Catalog;
  collectionType?: CollectionType;
}

export async function listViews(
  engine: AIOStreams,
  userData: UserData
): Promise<ViewEntry[]> {
  const catalogs = exposedCatalogs(engine);
  const out: (ViewEntry | null)[] = new Array(catalogs.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < catalogs.length) {
      const i = cursor++;
      const catalog = catalogs[i];
      const types = await entryTypesOf(engine, userData, catalog);
      const kind = collectionTypeFor(catalog, types);
      if (kind === 'hidden') continue;
      out[i] = {
        id: viewId(catalog.type, catalog.id),
        catalog,
        collectionType: kind === 'mixed' ? undefined : kind,
      };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, catalogs.length) }, worker)
  );
  return out.filter((v): v is ViewEntry => !!v);
}

export function findCatalog(
  engine: AIOStreams,
  type: string,
  id: string
): Catalog | undefined {
  return ((engine.getCatalogs() ?? []) as Catalog[]).find(
    (c) => c.type === type && c.id === id
  );
}

export type ContentKind = 'movie' | 'series';

/** The kind an entry becomes as an item: every non-movie type builds a Series. */
export function entryKind(preview: Pick<MetaPreview, 'type'>): ContentKind {
  return preview.type === 'movie' ? 'movie' : 'series';
}

/** Entry types already sniffed for this catalog's view; never a fresh fetch. */
async function cachedEntryTypes(
  userData: UserData,
  catalog: Catalog
): Promise<string[] | undefined> {
  return viewTypeCache
    .get(`${userScopeKey(userData)}|${catalogKey(catalog)}`)
    .catch(() => undefined);
}

/** The kinds a catalog is known to yield, from the entry types sniffed for its view. */
export async function knownCatalogKinds(
  userData: UserData,
  catalog: Catalog
): Promise<ContentKind[] | undefined> {
  const types = await cachedEntryTypes(userData, catalog);
  if (!types?.length) return undefined;
  return [...new Set(types.map((t) => entryKind({ type: t })))];
}

export async function searchCatalogs(
  engine: AIOStreams,
  term: string,
  limit: number,
  kinds?: ContentKind[],
  userData?: UserData
): Promise<MetaPreview[]> {
  const wanted = kinds ? new Set(kinds) : null;
  if (wanted && !wanted.size) return [];
  const searchable = ((engine.getCatalogs() ?? []) as Catalog[]).filter(
    isSearchable
  );
  const evidence =
    wanted && userData
      ? await Promise.all(searchable.map((c) => cachedEntryTypes(userData, c)))
      : [];
  const catalogs = !wanted
    ? searchable
    : searchable.filter((c, i) => {
        const types = evidence[i];
        return (
          !types?.length ||
          types.some((t) => wanted.has(entryKind({ type: t })))
        );
      });
  if (!catalogs.length) return [];
  const results = await Promise.allSettled(
    catalogs.map((c) =>
      getCatalogPage(engine, c, { startIndex: 0, limit, search: term })
    )
  );
  const lists = results.map((r) =>
    r.status === 'fulfilled'
      ? r.value.items.filter((i) => !wanted || wanted.has(entryKind(i)))
      : []
  );
  const seen = new Set<string>();
  const out: MetaPreview[] = [];
  for (let rank = 0; out.length < limit; rank++) {
    let drained = true;
    for (const list of lists) {
      if (rank >= list.length) continue;
      drained = false;
      const item = list[rank];
      const key = `${item.type}|${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= limit) break;
    }
    if (drained) break;
  }
  return out;
}
