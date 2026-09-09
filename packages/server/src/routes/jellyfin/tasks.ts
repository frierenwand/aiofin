import {
  config as appConfig,
  deliverPlaybackEvents,
  JellyfinRepository,
  PlaybackHandoffRepository,
  TaskManager,
  WatchStateRepository,
} from '@aiostreams/core';

const ID_MAP_MAX_AGE_MS = 180 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export function registerJellyfinTasks(): void {
  TaskManager.register({
    id: 'jellyfin-prune',
    label: 'Prune Jellyfin state',
    description:
      'Deletes hashed Jellyfin item ids not seen for 180 days and watch state untouched for longer than the configured retention. Browsing re-creates ids; watch state is gone for good.',
    category: 'jellyfin',
    kind: 'scheduled',
    intervalMs: DAY_MS,
    enabled: true,
    destructive: true,
    multiReplica: 'single',
    run: async () => {
      const ids = await JellyfinRepository.pruneIds(ID_MAP_MAX_AGE_MS);
      const retentionMs = appConfig.jellyfin.watchStateRetentionDays * DAY_MS;
      const rows = await WatchStateRepository.prune(retentionMs);
      const deliveries = await PlaybackHandoffRepository.pruneFinished(
        Date.now() - appConfig.watchState.deliveryRetentionDays * DAY_MS
      );
      return {
        ok: true,
        message: `pruned ${ids} id mappings, ${rows} watch-state rows and ${deliveries} playback deliveries`,
      };
    },
  });

  TaskManager.register({
    id: 'playback-handoff-delivery',
    label: 'Deliver playback events',
    description:
      'Sends queued playback events to addons that declare the playback resource. Events are queued before the client request that produced them returns, so delivery never delays playback.',
    category: 'jellyfin',
    kind: 'scheduled',
    intervalMs: appConfig.watchState.deliveryIntervalSeconds * 1000,
    enabled: true,
    destructive: false,
    multiReplica: 'single',
    run: async () => {
      if (!appConfig.watchState.handoffEnabled)
        return { ok: true, message: 'playback reporting disabled' };
      const { delivered, failed, retried } = await deliverPlaybackEvents();
      return {
        ok: true,
        message: `delivered ${delivered}, retrying ${retried}, gave up on ${failed}`,
      };
    },
  });
}
