import { now, queryAll, queryOne, run as sqlRun } from "@/lib/server/db";
import { encryptSecret } from "@/lib/server/credentials";
import { randomBytes } from "node:crypto";
import { gmailRequest, type GmailWatchResponse } from "./api";
import type { ProviderConnection } from "../provider/types";
import { googlePubSubTopic } from "../provider/config";

/**
 * Gmail watch + read cursor.
 *
 * Two pieces of real state, both per credential so reconnecting an
 * account starts a clean cursor rather than inheriting another
 * mailbox's position:
 *
 *  - **cursor** — the `internalDate` of the newest message the trigger
 *    has already processed. The next run only sees messages after it.
 *  - **watch** — the `users.watch` subscription that makes Gmail push a
 *    Pub/Sub notification when mail arrives, plus its expiry (Gmail
 *    watches lapse after roughly seven days).
 *
 * Without `GOOGLE_PUBSUB_TOPIC` the watch is simply absent: the trigger
 * still works by reading the mailbox when a run starts. Nothing reports
 * "watching" unless Google actually accepted a subscription.
 */

export interface WatchRow {
  id: string;
  provider: string;
  workspace_id: string;
  credential_id: string;
  topic: string | null;
  history_id: string | null;
  cursor: string | null;
  status: string;
  last_error: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface WatchView {
  credentialId: string;
  /** `idle` when no Pub/Sub watch exists, `watching` when one is live. */
  status: string;
  topic: string | null;
  historyId: string | null;
  expiresAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

function findRow(credentialId: string, workspaceId: string): WatchRow | undefined {
  return queryOne<WatchRow>(
    "SELECT * FROM provider_watches WHERE provider = 'gmail' AND credential_id = ? AND workspace_id = ?",
    credentialId,
    workspaceId,
  );
}

export function getWatch(workspaceId: string, credentialId: string): WatchView | null {
  const row = findRow(credentialId, workspaceId);
  if (!row) return null;
  return toView(row);
}

function toView(row: WatchRow): WatchView {
  return {
    credentialId: row.credential_id,
    status: row.status,
    topic: row.topic,
    historyId: row.history_id,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    lastError: row.last_error,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Cursor                                                              */
/* ------------------------------------------------------------------ */

/** Epoch-ms cursor of the newest message already processed, or null. */
export function readCursor(workspaceId: string, credentialId: string): number | null {
  const row = findRow(credentialId, workspaceId);
  if (!row?.cursor) return null;
  const value = Number(row.cursor);
  return Number.isFinite(value) ? value : null;
}

export function writeCursor(workspaceId: string, credentialId: string, cursorMs: number): void {
  upsert(credentialId, workspaceId, { cursor: String(cursorMs) });
}

/* ------------------------------------------------------------------ */
/* Watch                                                               */
/* ------------------------------------------------------------------ */

interface Patch {
  topic?: string | null;
  historyId?: string | null;
  cursor?: string | null;
  status?: string;
  lastError?: string | null;
  expiresAt?: number | null;
}

function upsert(credentialId: string, workspaceId: string, patch: Patch): WatchRow {
  const timestamp = now();
  const existing = findRow(credentialId, workspaceId);
  if (existing) {
    sqlRun(
      `UPDATE provider_watches
          SET topic = ?, history_id = ?, cursor = ?, status = ?, last_error = ?,
              expires_at = ?, updated_at = ?
        WHERE id = ?`,
      patch.topic !== undefined ? patch.topic : existing.topic,
      patch.historyId !== undefined ? patch.historyId : existing.history_id,
      patch.cursor !== undefined ? patch.cursor : existing.cursor,
      patch.status ?? existing.status,
      patch.lastError !== undefined ? patch.lastError : existing.last_error,
      patch.expiresAt !== undefined ? patch.expiresAt : existing.expires_at,
      timestamp,
      existing.id,
    );
    return findRow(credentialId, workspaceId)!;
  }
  const id = `watch_${randomBytes(8).toString("hex")}`;
  sqlRun(
    `INSERT INTO provider_watches
       (id, provider, workspace_id, credential_id, topic, history_id, cursor, status,
        last_error, expires_at, created_at, updated_at)
     VALUES (?, 'gmail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    workspaceId,
    credentialId,
    patch.topic ?? null,
    patch.historyId ?? null,
    patch.cursor ?? null,
    patch.status ?? "idle",
    patch.lastError ?? null,
    patch.expiresAt ?? null,
    timestamp,
    timestamp,
  );
  return findRow(credentialId, workspaceId)!;
}

/**
 * (Re)subscribe the mailbox to Pub/Sub push notifications.
 *
 * Returns the resulting watch view. When no topic is configured the
 * row is marked `idle` with an explanatory error — the UI shows that
 * instead of claiming a subscription that does not exist.
 */
export async function ensureWatch(
  connection: ProviderConnection,
): Promise<WatchView> {
  const topic = googlePubSubTopic();
  if (!topic) {
    const row = upsert(connection.credentialId, connection.workspaceId, {
      status: "idle",
      lastError: "GOOGLE_PUBSUB_TOPIC is not set — push notifications are off.",
      expiresAt: null,
    });
    return toView(row);
  }

  try {
    const response = await gmailRequest<GmailWatchResponse>(
      connection,
      "users.watch",
      "/watch",
      {
        method: "POST",
        body: { topic, labelFilterMode: "ALL" },
      },
    );
    const expiresAt = Date.now() + 6 * 24 * 60 * 60_000;
    const row = upsert(connection.credentialId, connection.workspaceId, {
      topic,
      historyId: response.historyId ?? null,
      status: "watching",
      lastError: null,
      expiresAt,
    });
    return toView(row);
  } catch (error) {
    const row = upsert(connection.credentialId, connection.workspaceId, {
      topic,
      status: "error",
      lastError: error instanceof Error ? error.message.slice(0, 300) : "Watch failed.",
    });
    return toView(row);
  }
}

/** Stops pushing (the mailbox itself is untouched). */
export async function stopWatch(connection: ProviderConnection): Promise<void> {
  try {
    await gmailRequest(connection, "users.stop", "/stop", { method: "POST" });
  } catch {
    /* Google may already have expired the watch — the row is the truth. */
  }
  upsert(connection.credentialId, connection.workspaceId, {
    status: "idle",
    expiresAt: null,
    lastError: null,
  });
}

/** True when the live watch is inside the renewal window. */
export function watchNeedsRenewal(view: WatchView | null, marginMs = 12 * 60 * 60_000): boolean {
  if (!view || view.status !== "watching") return false;
  if (!view.expiresAt) return true;
  return Date.parse(view.expiresAt) - marginMs <= Date.now();
}

/** Every watch row, used by the maintenance pass. */
export function listStaleWatches(workspaceId: string): WatchRow[] {
  return queryAll<WatchRow>(
    `SELECT * FROM provider_watches
      WHERE provider = 'gmail' AND status = 'watching' AND expires_at <= ?`,
    now() + 12 * 60 * 60_000,
  ).filter((row) => row.workspace_id === workspaceId);
}

/** Encrypts nothing — present so callers can record a webhook secret later. */
export function encryptProviderSecret(secret: string): string {
  return encryptSecret(secret);
}
