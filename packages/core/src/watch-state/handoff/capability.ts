import { PLAYBACK_RESOURCE } from '../../utils/constants.js';
import {
  PlaybackCapabilitySchema,
  type Manifest,
  type StrictManifestResource,
} from '../../db/schemas.js';

/** What v1 sends: `progress` may be declared, but a scrobble needs the stop. */
export const SENDABLE_EVENTS = ['start', 'stop', 'played', 'unplayed'] as const;

export type PlaybackEventKind = (typeof SENDABLE_EVENTS)[number];

export interface PlaybackCapabilityInfo {
  version: number;
  events: Set<PlaybackEventKind>;
  types: string[];
  idPrefixes?: string[];
}

function isSendable(value: string): value is PlaybackEventKind {
  return (SENDABLE_EVENTS as readonly string[]).includes(value);
}

/** No root key means every kind we send: declaring the resource is the opt-in. */
export function readPlaybackCapability(
  manifest: Manifest | null | undefined,
  resources: StrictManifestResource[] | undefined
): PlaybackCapabilityInfo | null {
  if (!manifest) return null;
  const entry = resources?.find((r) => r.name === PLAYBACK_RESOURCE);
  if (!entry) return null;

  const parsed = PlaybackCapabilitySchema.safeParse(
    (manifest as Record<string, unknown>)[PLAYBACK_RESOURCE]
  );
  const declared = parsed.success ? parsed.data.events : undefined;
  const events = new Set<PlaybackEventKind>(
    declared?.length ? declared.filter(isSendable) : SENDABLE_EVENTS
  );
  if (!events.size) return null;

  return {
    version: parsed.success ? (parsed.data.version ?? 1) : 1,
    events,
    types: entry.types ?? [],
    idPrefixes: entry.idPrefixes?.length ? entry.idPrefixes : undefined,
  };
}
