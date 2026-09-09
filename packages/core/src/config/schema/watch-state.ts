import { z } from 'zod';
import type { RuntimeConfigSection } from '../types.js';

/**
 * Reporting playback to addons that declare the `playback` resource. Only the
 * Jellyfin API produces these events.
 */
export const watchStateSchema = {
  handoffEnabled: {
    schema: z.boolean(),
    default: false,
    label: 'Report playback to addons',
    description:
      'Sends playback events (started, stopped with a watched decision, marked played or unplayed) to configured addons that declare the `playback` resource, so a tracker addon can scrobble what was actually watched instead of guessing from a subtitle request. Only Jellyfin clients produce these events; playback in Stremio reports nothing.',
    env: 'WATCH_STATE_HANDOFF_ENABLED',
    requiresRestart: false,
    secret: false,
  },
  allowPrivateUrls: {
    schema: z.boolean(),
    default: false,
    label: 'Allow reporting to private addresses',
    description:
      'Allow playback events to be sent to an addon on a private or loopback address, such as `http://tracker:7000` on a Docker network. This lets anyone who can create a configuration make this server send requests to your internal network, so only enable it on a trusted, non-public instance.',
    env: 'WATCH_STATE_ALLOW_PRIVATE_URLS',
    requiresRestart: false,
    secret: false,
  },
  maxSinks: {
    schema: z.number().int().min(0),
    default: 3,
    label: 'Max addons reported to',
    description:
      'How many addons one configuration may report playback to. A fan-out cap, not a permission: every addon that declares the resource is eligible, this bounds how many requests one play can turn into. 0 disables reporting.',
    env: 'WATCH_STATE_MAX_SINKS',
    requiresRestart: false,
    secret: false,
    ui: { min: 0 },
  },
  deliveryIntervalSeconds: {
    schema: z.number().int().min(10),
    default: 60,
    label: 'Delivery interval (seconds)',
    description:
      'How often queued playback events are delivered. Events are queued before the request that produced them returns, so an addon being down or slow never delays playback; this is how long a scrobble waits in the normal case.',
    env: 'WATCH_STATE_DELIVERY_INTERVAL',
    requiresRestart: true,
    secret: false,
    ui: { min: 10 },
  },
  deliveryMaxAttempts: {
    schema: z.number().int().min(1).max(20),
    default: 5,
    label: 'Delivery attempts',
    description:
      'How many times a playback event is retried before it is given up on. Backoff runs 30 seconds, 2 minutes, 10 minutes, 1 hour, 6 hours, so the default covers an addon being down for most of a day.',
    env: 'WATCH_STATE_DELIVERY_MAX_ATTEMPTS',
    requiresRestart: false,
    secret: false,
    ui: { min: 1, max: 20 },
  },
  deliveryRetentionDays: {
    schema: z.number().int().min(1),
    default: 7,
    label: 'Delivery history retention (days)',
    description:
      'Delivered and given-up playback events are deleted by the daily prune task after this long. They are kept only so a failing addon can be diagnosed.',
    env: 'WATCH_STATE_DELIVERY_RETENTION_DAYS',
    requiresRestart: false,
    secret: false,
    ui: { min: 1 },
  },
} as const satisfies RuntimeConfigSection;
