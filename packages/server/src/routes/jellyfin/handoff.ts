import {
  Cache,
  config as appConfig,
  createLogger,
  dispatchPlayback,
  itemKeyFor,
  providerIdsFor,
  type ContentRef,
  type JellyfinItem,
  type PlaybackEventKind,
  type ResolvedPlaybackSink,
  type WatchStateRow,
} from '@aiostreams/core';
import type { JellyfinRequestContext } from './context.js';
import { itemFromDescriptor } from './items.js';

const logger = createLogger('jellyfin');

/** Derived from the resolved config, so it is keyed by the memo scope. */
const sinkCache = Cache.getInstance<string, ResolvedPlaybackSink[]>(
  'jellyfin-playback-sinks',
  500
);
const SINK_TTL_SECONDS = 300;

async function sinksFor(
  ctx: JellyfinRequestContext
): Promise<ResolvedPlaybackSink[]> {
  const key = ctx.scope();
  const cached = await sinkCache.get(key).catch(() => undefined);
  if (cached) return cached;
  const engine = await ctx.engine();
  const sinks = engine.getPlaybackSinks();
  await sinkCache.set(key, sinks, SINK_TTL_SECONDS).catch(() => undefined);
  return sinks;
}

/**
 * A tracker keys on the show. An episode item carries no `ProviderIds`, so the
 * series item supplies them; its meta is cached by the episode build.
 */
async function idsFor(
  ctx: JellyfinRequestContext,
  ref: ContentRef,
  item?: JellyfinItem | null
): Promise<Record<string, string>> {
  const own = (item?.ProviderIds as Record<string, string> | undefined) ?? {};
  if (ref.episode == null) {
    return Object.keys(own).length
      ? own
      : providerIdsFor({ id: ref.baseId, type: ref.type });
  }
  const series = await itemFromDescriptor(ctx, {
    k: 'series',
    t: ref.type,
    i: ref.baseId,
  }).catch(() => null);
  const parent =
    (series?.ProviderIds as Record<string, string> | undefined) ?? {};
  const merged = { ...parent, ...own };
  return Object.keys(merged).length
    ? merged
    : providerIdsFor({ id: ref.baseId, type: ref.type });
}

/** Never throws: a scrobble must not fail a client's playstate call. */
export async function reportPlayback(
  ctx: JellyfinRequestContext,
  kind: PlaybackEventKind,
  ref: ContentRef,
  opts: {
    row?: WatchStateRow | null;
    item?: JellyfinItem | null;
    positionMs?: number;
    durationMs?: number;
  } = {}
): Promise<void> {
  if (!appConfig.watchState.handoffEnabled) return;
  try {
    const sinks = await sinksFor(ctx);
    if (!sinks.length) return;
    const providerIds = await idsFor(ctx, ref, opts.item);
    await dispatchPlayback(ctx.uuid, sinks, {
      kind,
      type: ref.type,
      videoId: ref.videoId || ref.baseId,
      baseId: ref.baseId,
      itemKey: itemKeyFor(ref),
      season: ref.season,
      episode: ref.episode,
      // The row clears the position once it decides the item was played.
      positionMs: opts.positionMs ?? opts.row?.positionMs,
      durationMs: opts.durationMs || opts.row?.durationMs,
      played: opts.row ? opts.row.played : undefined,
      providerIds,
    });
  } catch (error) {
    logger.debug(
      {
        event: kind,
        err: error instanceof Error ? error.message : String(error),
      },
      'failed to report playback to addons'
    );
  }
}
