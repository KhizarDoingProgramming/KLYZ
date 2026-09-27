import type { EngineError } from "@/lib/engine/types";
import { REMEDIATION, SLACK_ERRORS, integrationError } from "../errors";
import { ProviderError } from "../provider/errors";
import type { ProviderConnection } from "../provider/types";
import { conversationsInfo, findChannelByName, type SlackChannel } from "./api";
import { looksLikeChannelId, normaliseChannelRef } from "./config";

/**
 * Channel lookup for Slack nodes.
 *
 * Slack's own guidance is to stop requesting the same channel list on
 * every run, so successful lookups are held in a small module-level
 * TTL cache keyed by connection + reference. Failures are never cached:
 * inviting the app to a channel has to work on the very next attempt.
 */

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 100;

const cache = new Map<string, { value: SlackChannelRef; expiresAt: number }>();

function cacheKey(connection: ProviderConnection, ref: string): string {
  return `${connection.credentialId}:${ref.toLowerCase()}`;
}

function readCache(key: string): SlackChannelRef | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache(key: string, value: SlackChannelRef): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  /* Map iteration follows insertion order, so the head is the stalest. */
  for (const oldest of cache.keys()) {
    cache.delete(oldest);
    if (cache.size <= CACHE_MAX_ENTRIES) break;
  }
}

/** Empties the lookup cache — used between tests and on disconnect. */
export function clearChannelCache(): void {
  cache.clear();
}

export interface SlackChannelRef {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export interface SlackChannelDetails extends SlackChannelRef {
  topic: string;
  purpose: string;
  memberCount: number;
  archived: boolean;
  createdAt: string;
}

/**
 * Resolves an id or `#name` to a channel **without** throwing on a
 * miss — a lookup miss is data for the Find channel node, which lets a
 * Condition branch on `found`.
 */
export async function findChannel(
  connection: ProviderConnection,
  ref: string,
  signal?: AbortSignal,
): Promise<SlackChannelRef | null> {
  const normalised = normaliseChannelRef(ref);
  if (!normalised) return null;

  const key = cacheKey(connection, normalised);
  const cached = readCache(key);
  if (cached) return cached;

  let channel: SlackChannel | null;
  if (looksLikeChannelId(normalised)) {
    try {
      channel = await conversationsInfo(connection, normalised, { signal });
    } catch (error) {
      /* A channel the app was not invited to reads exactly like one
         that does not exist — both are a miss, not a failure. */
      if (error instanceof ProviderError && error.providerMessage === "channel_not_found") {
        return null;
      }
      throw error;
    }
  } else {
    channel = await findChannelByName(connection, normalised, { signal });
  }

  const value = channel ? toRef(channel) : null;
  if (!value) return null;
  writeCache(key, value);
  return value;
}

/** Resolves a channel, raising `SLACK_CHANNEL_INVALID` when it is unknown. */
export async function resolveChannel(
  connection: ProviderConnection,
  ref: string,
  signal?: AbortSignal,
): Promise<SlackChannelRef> {
  const normalised = normaliseChannelRef(ref);
  if (!normalised) throw channelInvalid(ref, "This Slack step has no channel.");

  const found = await findChannel(connection, normalised, signal);
  if (!found) {
    throw channelInvalid(
      normalised,
      looksLikeChannelId(normalised)
        ? `Slack has no channel with id "${normalised}".`
        : `No Slack channel named "${normalised}" is visible to this app.`,
    );
  }
  return found;
}

/** Full detail for one channel, resolved by id or by name. */
export async function channelInfo(
  connection: ProviderConnection,
  ref: string,
  signal?: AbortSignal,
): Promise<SlackChannelDetails> {
  const normalised = normaliseChannelRef(ref);
  if (!normalised) throw channelInvalid(ref, "This Slack step has no channel.");

  const id = looksLikeChannelId(normalised)
    ? normalised
    : (await resolveChannel(connection, normalised, signal)).id;

  let channel: SlackChannel;
  try {
    channel = await conversationsInfo(connection, id, { signal });
  } catch (error) {
    if (error instanceof ProviderError && error.providerMessage === "channel_not_found") {
      throw channelInvalid(normalised, `Slack has no channel with id "${id}".`);
    }
    throw error;
  }

  const base = toRef(channel) ?? { id, name: "", isPrivate: false, isMember: false };
  return {
    ...base,
    topic: channel.topic?.value ?? "",
    purpose: channel.purpose?.value ?? "",
    memberCount: channel.num_members ?? 0,
    archived: channel.is_archived === true,
    createdAt: isoFromEpoch(channel.created),
  };
}

function toRef(channel: SlackChannel): SlackChannelRef | null {
  if (!channel?.id) return null;
  return {
    id: channel.id,
    name: channel.name ?? "",
    isPrivate: channel.is_private === true || channel.is_group === true,
    isMember: channel.is_member === true,
  };
}

function isoFromEpoch(created: number | undefined): string {
  if (typeof created !== "number" || !Number.isFinite(created) || created <= 0) return "";
  return new Date(created * 1000).toISOString();
}

function channelInvalid(ref: string, message: string): EngineError {
  return integrationError(SLACK_ERRORS.channelInvalid, message, {
    detail: `channel=${ref}`,
    hint: "Invite the app to the channel, or paste its id (C…).",
    remediation: REMEDIATION.inspect,
  });
}
