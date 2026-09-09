import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { sql } from '../sql.js';

/** `error` is a run of permanent failures; `auth_expired` needs the user. */
export type SinkStatus = 'connected' | 'auth_expired' | 'error';

/** A row stays `pending` while it still has attempts left. */
export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface SinkRow {
  id: string;
  uuid: string;
  addonInstanceId: string;
  addonName: string | null;
  baseUrl: string;
  status: SinkStatus;
  consecutiveFailures: number;
  lastPushAt: number | null;
  lastError: string | null;
  lastErrorKind: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryRow {
  id: string;
  sinkId: string;
  idempotencyKey: string;
  event: string;
  itemKey: string;
  url: string;
  body: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
}

interface DbSink {
  id: string;
  uuid: string;
  addon_instance_id: string;
  addon_name: string | null;
  base_url: string;
  status: string;
  consecutive_failures: number | string;
  last_push_at: number | string | null;
  last_error: string | null;
  last_error_kind: string | null;
  created_at: number | string;
  updated_at: number | string;
  [k: string]: unknown;
}

interface DbDelivery {
  id: string;
  sink_id: string;
  idempotency_key: string;
  event: string;
  item_key: string;
  url: string;
  body: string;
  status: string;
  attempts: number | string;
  next_attempt_at: number | string;
  last_error: string | null;
  created_at: number | string;
  updated_at: number | string;
  delivered_at: number | string | null;
  [k: string]: unknown;
}

function optionalNumber(v: number | string | null): number | null {
  return v == null ? null : Number(v);
}

function toSink(r: DbSink): SinkRow {
  return {
    id: r.id,
    uuid: r.uuid,
    addonInstanceId: r.addon_instance_id,
    addonName: r.addon_name,
    baseUrl: r.base_url,
    status: r.status as SinkStatus,
    consecutiveFailures: Number(r.consecutive_failures),
    lastPushAt: optionalNumber(r.last_push_at),
    lastError: r.last_error,
    lastErrorKind: r.last_error_kind,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toDelivery(r: DbDelivery): DeliveryRow {
  return {
    id: r.id,
    sinkId: r.sink_id,
    idempotencyKey: r.idempotency_key,
    event: r.event,
    itemKey: r.item_key,
    url: r.url,
    body: r.body,
    status: r.status as DeliveryStatus,
    attempts: Number(r.attempts),
    nextAttemptAt: Number(r.next_attempt_at),
    lastError: r.last_error,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    deliveredAt: optionalNumber(r.delivered_at),
  };
}

export class PlaybackHandoffRepository {
  /** Leaves existing health alone. */
  static async ensureSink(
    uuid: string,
    input: { addonInstanceId: string; addonName?: string; baseUrl: string }
  ): Promise<SinkRow> {
    const now = Date.now();
    const name = input.addonName ?? null;
    await getDb().exec(
      sql`INSERT INTO watch_state_sinks
            (id, uuid, addon_instance_id, addon_name, base_url, status,
             consecutive_failures, created_at, updated_at)
          VALUES (${randomUUID()}, ${uuid}, ${input.addonInstanceId}, ${name},
                  ${input.baseUrl}, 'connected', 0, ${now}, ${now})
          ON CONFLICT(uuid, addon_instance_id) DO UPDATE SET
            addon_name = COALESCE(excluded.addon_name, watch_state_sinks.addon_name),
            base_url = excluded.base_url,
            updated_at = excluded.updated_at`
    );
    const row = await getDb().maybeOne<DbSink>(
      sql`SELECT * FROM watch_state_sinks
           WHERE uuid = ${uuid} AND addon_instance_id = ${input.addonInstanceId}`
    );
    if (!row) throw new Error('failed to persist playback sink');
    return toSink(row);
  }

  static async listSinks(uuid: string): Promise<SinkRow[]> {
    const rows = await getDb().query<DbSink>(
      sql`SELECT * FROM watch_state_sinks WHERE uuid = ${uuid}
           ORDER BY addon_name, addon_instance_id`
    );
    return rows.map(toSink);
  }

  static async setSinkStatus(
    id: string,
    status: SinkStatus,
    opts: { error?: string; errorKind?: string; failures?: number } = {}
  ): Promise<void> {
    const now = Date.now();
    const error = opts.error ?? null;
    const kind = opts.errorKind ?? null;
    const failures = opts.failures ?? null;
    await getDb().exec(
      sql`UPDATE watch_state_sinks SET
            status = ${status},
            last_error = ${error},
            last_error_kind = ${kind},
            consecutive_failures = COALESCE(${failures}, consecutive_failures),
            updated_at = ${now}
          WHERE id = ${id}`
    );
  }

  static async markSinkHealthy(id: string, at: number): Promise<void> {
    await getDb().exec(
      sql`UPDATE watch_state_sinks SET
            status = 'connected', consecutive_failures = 0,
            last_error = NULL, last_error_kind = NULL,
            last_push_at = ${at}, updated_at = ${at}
          WHERE id = ${id}`
    );
  }

  static async bumpSinkFailures(id: string): Promise<number> {
    const now = Date.now();
    await getDb().exec(
      sql`UPDATE watch_state_sinks
           SET consecutive_failures = consecutive_failures + 1, updated_at = ${now}
           WHERE id = ${id}`
    );
    const row = await getDb().maybeOne<DbSink>(
      sql`SELECT * FROM watch_state_sinks WHERE id = ${id}`
    );
    return row ? Number(row.consecutive_failures) : 0;
  }

  /** False when that key is already queued. */
  static async enqueue(input: {
    sinkId: string;
    idempotencyKey: string;
    event: string;
    itemKey: string;
    url: string;
    body: string;
  }): Promise<boolean> {
    const now = Date.now();
    const res = await getDb().exec(
      sql`INSERT INTO watch_state_deliveries
            (id, sink_id, idempotency_key, event, item_key, url, body, status,
             attempts, next_attempt_at, created_at, updated_at)
          VALUES (${randomUUID()}, ${input.sinkId}, ${input.idempotencyKey},
                  ${input.event}, ${input.itemKey}, ${input.url}, ${input.body},
                  'pending', 0, ${now}, ${now}, ${now})
          ON CONFLICT (sink_id, idempotency_key) DO NOTHING`
    );
    return res.rowCount > 0;
  }

  /** Due rows, oldest first; an unhealthy sink only once past `probeBefore`. */
  static async claimDue(
    now: number,
    limit: number,
    probeBefore: number
  ): Promise<DeliveryRow[]> {
    const rows = await getDb().query<DbDelivery>(
      sql`SELECT d.* FROM watch_state_deliveries d
            JOIN watch_state_sinks s ON s.id = d.sink_id
           WHERE d.status = 'pending'
             AND d.next_attempt_at <= ${now}
             AND (s.status = 'connected' OR s.updated_at < ${probeBefore})
           ORDER BY d.next_attempt_at ASC, d.created_at ASC
           LIMIT ${limit}`
    );
    return rows.map(toDelivery);
  }

  static async markDelivered(id: string, at: number): Promise<void> {
    await getDb().exec(
      sql`UPDATE watch_state_deliveries SET
            status = 'delivered', attempts = attempts + 1,
            delivered_at = ${at}, updated_at = ${at}, last_error = NULL
          WHERE id = ${id}`
    );
  }

  static async markRetry(
    id: string,
    nextAttemptAt: number,
    error: string
  ): Promise<void> {
    const now = Date.now();
    await getDb().exec(
      sql`UPDATE watch_state_deliveries SET
            attempts = attempts + 1, next_attempt_at = ${nextAttemptAt},
            last_error = ${error}, updated_at = ${now}
          WHERE id = ${id}`
    );
  }

  static async markFailed(id: string, error: string): Promise<void> {
    const now = Date.now();
    await getDb().exec(
      sql`UPDATE watch_state_deliveries SET
            status = 'failed', attempts = attempts + 1,
            last_error = ${error}, updated_at = ${now}
          WHERE id = ${id}`
    );
  }

  static async countPending(sinkId: string): Promise<number> {
    const row = await getDb().maybeOne<{ n: number | string }>(
      sql`SELECT COUNT(*) AS n FROM watch_state_deliveries
           WHERE sink_id = ${sinkId} AND status = 'pending'`
    );
    return row ? Number(row.n) : 0;
  }

  static async trimPending(sinkId: string, keep: number): Promise<number> {
    // A subquery LIMIT: the drivers spell an unbounded OFFSET differently.
    const res = await getDb().exec(
      sql`DELETE FROM watch_state_deliveries
           WHERE sink_id = ${sinkId} AND status = 'pending'
             AND created_at < (
               SELECT MIN(created_at) FROM (
                 SELECT created_at FROM watch_state_deliveries
                  WHERE sink_id = ${sinkId} AND status = 'pending'
                  ORDER BY created_at DESC
                  LIMIT ${keep}
               ) newest
             )`
    );
    return res.rowCount;
  }

  static async pruneFinished(olderThan: number): Promise<number> {
    const res = await getDb().exec(
      sql`DELETE FROM watch_state_deliveries
           WHERE status <> 'pending' AND updated_at < ${olderThan}`
    );
    return res.rowCount;
  }
}
