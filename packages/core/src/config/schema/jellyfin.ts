import { z } from 'zod';
import type { RuntimeConfigSection } from '../types.js';

/**
 * The Jellyfin-compatible API: every configuration presented as a Jellyfin
 * server under /jellyfin. Direct play only, nothing is transcoded.
 */
export const jellyfinSchema = {
  enabled: {
    schema: z.boolean(),
    default: false,
    label: 'Enable Jellyfin API',
    description:
      'Presents every configuration as a Jellyfin server at /jellyfin. Clients sign in with the configuration UUID or alias and its password, approve a Quick Connect code from the configuration page, or use the pre-authenticated /jellyfin/<uuid>/<encryptedPassword> address.',
    env: 'JELLYFIN_ENABLED',
    requiresRestart: false,
    secret: false,
  },
  version: {
    schema: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, 'Must be a dotted numeric version like 12.0.0'),
    default: '12.0.0',
    label: 'Reported server version',
    description:
      'Version returned by /System/Info. Clients parse it as numbers, so keep the dotted numeric form; lower it (for example 10.11.9) only if a client misbehaves with the current release.',
    env: 'JELLYFIN_VERSION',
    requiresRestart: false,
    secret: false,
  },
  imageDelivery: {
    schema: z.enum(['redirect', 'relay']),
    default: 'redirect',
    label: 'Image delivery',
    description:
      '**redirect** answers artwork requests with a 302 to the image URL so no image bytes pass through this server; **relay** fetches and pipes every image. Infuse always receives relay.',
    env: 'JELLYFIN_IMAGE_DELIVERY',
    requiresRestart: false,
    secret: false,
  },
  maxCatalogItems: {
    schema: z.number().int().min(0),
    default: 250,
    label: 'Max items per library',
    description:
      'How deep a Jellyfin client may page into one catalog. Library crawlers (Infuse sync, Kodi) walk every library to this cap, and each addon page of 20 items is one upstream request, so 250 costs at most ~13 requests per library and keeps a whole configuration inside the catalog cache. 0 disables the cap.',
    env: 'JELLYFIN_MAX_CATALOG_ITEMS',
    requiresRestart: false,
    secret: false,
    ui: { min: 0 },
  },
  maxVersions: {
    schema: z.number().int().min(1).max(50),
    default: 10,
    label: 'Max versions per item',
    description:
      'Upper bound on how many streams an item offers as versions. Configurations can pick a lower number.',
    env: 'JELLYFIN_MAX_VERSIONS',
    requiresRestart: false,
    secret: false,
    ui: { min: 1, max: 50 },
  },
  resolveOnOpen: {
    schema: z.enum(['always', 'never', 'user']),
    default: 'user',
    label: 'Resolve streams when an item is opened',
    description:
      'Stock clients build their version picker from the item page, which means fetching streams before playback starts. **always** does that for everyone, **never** only resolves on play (the picker shows a placeholder until then), **user** lets each configuration choose.',
    env: 'JELLYFIN_RESOLVE_ON_OPEN',
    requiresRestart: false,
    secret: false,
  },
  streamCacheTtl: {
    schema: z.number().int().min(0),
    default: 60,
    label: 'Reuse resolved streams for (seconds)',
    description:
      "How long an item's resolved streams are reused before the pipeline runs again. It keeps opening an item and then playing it to a single run, while staying short enough that debrid cached/uncached status is current. Saving a configuration resolves again as soon as the change is picked up, within 30 seconds, however long this is set to. 0 resolves on every request, which is the most current and the most expensive.",
    env: 'JELLYFIN_STREAM_CACHE_TTL',
    requiresRestart: false,
    secret: false,
    ui: { min: 0 },
  },
  watchStateRetentionDays: {
    schema: z.number().int().min(1),
    default: 365,
    label: 'Watch state retention (days)',
    description:
      'Watch progress, played flags and favourites untouched for longer than this are deleted by the daily prune task.',
    env: 'JELLYFIN_WATCH_STATE_RETENTION_DAYS',
    requiresRestart: false,
    secret: false,
    ui: { min: 1 },
  },
} as const satisfies RuntimeConfigSection;
