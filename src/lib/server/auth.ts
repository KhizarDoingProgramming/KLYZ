import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { nodeEnv } from "@/lib/config/env";
import { exec, now, queryAll, queryOne, run as sqlRun } from "./db";
import { HttpError } from "./http";

/**
 * Accounts and sessions — the single source of "who is calling".
 *
 * Design rules:
 *  - The browser only ever holds an opaque random token in an
 *    HttpOnly cookie; the database stores its SHA-256, so a stolen
 *    database row cannot be replayed as a session.
 *  - Identity is never taken from a request header, a body field or a
 *    queue payload — `resolveActor` reads this cookie and nothing else.
 *  - Passwords are stored as salted scrypt digests (node:crypto, no
 *    dependency). A login attempt always runs a derivation, so a missing
 *    account and a wrong password cost the same.
 *  - Logging in always mints a *new* session and discards the presented
 *    one, so a pre-fixation token never survives authentication.
 */

export const SESSION_COOKIE = "klyz_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A session is re-extended at most this often, so reads stay cheap. */
const SESSION_TOUCH_MS = 5 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 1_024;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  system: number;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  active_workspace_id: string | null;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip: string | null;
  user_agent: string | null;
}

export interface UserView {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Passwords                                                           */
/* ------------------------------------------------------------------ */

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(
      400,
      "WEAK_PASSWORD",
      `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(
      400,
      "WEAK_PASSWORD",
      `Passwords must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
}

export function hashPassword(password: string): string {
  assertPasswordPolicy(password);
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${digest.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) {
    /* Still spend the work so "no such account" and "wrong password"
       are indistinguishable by timing. */
    scryptSync(password, randomBytes(16), KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 128 * 1024 * 1024,
    });
    return false;
  }
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const salt = Buffer.from(saltRaw ?? "", "base64");
  const expected = Buffer.from(hashRaw ?? "", "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.length, {
      N: Number(nRaw) || SCRYPT_N,
      r: Number(rRaw) || SCRYPT_R,
      p: Number(pRaw) || SCRYPT_P,
      maxmem: 128 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

export function findUserByEmail(email: string): UserRow | undefined {
  return queryOne<UserRow>(
    "SELECT * FROM users WHERE email = ? COLLATE NOCASE",
    normaliseEmail(email),
  );
}

export function findUserById(id: string): UserRow | undefined {
  return queryOne<UserRow>("SELECT * FROM users WHERE id = ?", id);
}

export function userCount(): number {
  return queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM users")?.total ?? 0;
}

/** Users that can actually sign in (the seeded identity cannot). */
export function loginableUserCount(): number {
  return (
    queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM users WHERE password_hash IS NOT NULL",
    )?.total ?? 0
  );
}

export interface CreateUserInput {
  email: string;
  name: string;
  password?: string;
  system?: boolean;
}

export function createUser(input: CreateUserInput): UserRow {
  const email = normaliseEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new HttpError(400, "BAD_EMAIL", "Enter a valid email address.");
  }
  if (findUserByEmail(email)) {
    throw new HttpError(409, "EMAIL_TAKEN", "That email already has an account.");
  }
  const name = input.name.trim() || email.split("@")[0] || "Member";
  if (name.length > 120) {
    throw new HttpError(400, "BAD_NAME", "Names must be at most 120 characters.");
  }
  const id = `usr_${randomBytes(9).toString("base64url")}`;
  const timestamp = now();
  if (!input.system && !input.password) {
    throw new HttpError(400, "PASSWORD_REQUIRED", "A password is required for this account.");
  }
  sqlRun(
    `INSERT INTO users (id, email, name, password_hash, system, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    email,
    name,
    input.password ? hashPassword(input.password) : null,
    input.system ? 1 : 0,
    timestamp,
    timestamp,
  );
  return findUserById(id)!;
}

export function toUserView(row: UserRow): UserView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Password verification for a login attempt (never throws). */
export function verifyLogin(email: string, password: string): UserRow | null {
  const user = findUserByEmail(email);
  if (!user || user.system === 1 || !user.password_hash) {
    verifyPassword(password, null);
    return null;
  }
  return verifyPassword(password, user.password_hash) ? user : null;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface CreatedSession {
  token: string;
  session: SessionRow;
}

export interface SessionOptions {
  ip?: string | null;
  userAgent?: string | null;
  activeWorkspaceId?: string | null;
}

export function createSession(userId: string, options: SessionOptions = {}): CreatedSession {
  const token = randomBytes(32).toString("base64url");
  const id = `ses_${randomBytes(9).toString("base64url")}`;
  const timestamp = now();
  sqlRun(
    `INSERT INTO sessions
       (id, user_id, token_hash, active_workspace_id, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    hashToken(token),
    options.activeWorkspaceId ?? null,
    timestamp,
    timestamp + SESSION_TTL_MS,
    timestamp,
    options.ip ?? null,
    (options.userAgent ?? "").slice(0, 300) || null,
  );
  return { token, session: findSessionById(id)! };
}

export function findSessionById(id: string): SessionRow | undefined {
  return queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", id);
}

/**
 * Resolve a raw cookie value to a live session.
 *
 * Expired rows are deleted on sight so a stolen, aged cookie cannot be
 * replayed, and the sliding expiry is refreshed at most every few
 * minutes so a read-heavy page does not write on every request.
 */
export function readSession(token: string | null): SessionRow | null {
  if (!token) return null;
  const row = queryOne<SessionRow>(
    "SELECT * FROM sessions WHERE token_hash = ?",
    hashToken(token),
  );
  if (!row) return null;
  const timestamp = now();
  if (row.expires_at <= timestamp) {
    sqlRun("DELETE FROM sessions WHERE id = ?", row.id);
    return null;
  }
  if (timestamp - row.last_seen_at > SESSION_TOUCH_MS) {
    sqlRun(
      "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?",
      timestamp,
      timestamp + SESSION_TTL_MS,
      row.id,
    );
    row.last_seen_at = timestamp;
    row.expires_at = timestamp + SESSION_TTL_MS;
  }
  return row;
}

export function revokeSession(sessionId: string): void {
  sqlRun("DELETE FROM sessions WHERE id = ?", sessionId);
}

export function revokeUserSessions(userId: string): number {
  const before = sessionsForUser(userId).length;
  sqlRun("DELETE FROM sessions WHERE user_id = ?", userId);
  return before;
}

export function sessionsForUser(userId: string): SessionRow[] {
  return queryAll<SessionRow>(
    "SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC",
    userId,
    now(),
  );
}

export function setActiveWorkspace(sessionId: string, workspaceId: string | null): void {
  sqlRun(
    "UPDATE sessions SET active_workspace_id = ?, last_seen_at = ? WHERE id = ?",
    workspaceId,
    now(),
    sessionId,
  );
}

export function purgeExpiredSessions(): number {
  return exec("DELETE FROM sessions WHERE expires_at <= ?", now());
}

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function sessionTokenFromCookieHeader(header: string | null): string | null {
  const value = parseCookies(header)[SESSION_COOKIE];
  return value && value.trim() ? value.trim() : null;
}

export function sessionTokenFrom(request: Request): string | null {
  return sessionTokenFromCookieHeader(request.headers.get("cookie"));
}

/**
 * The same extraction for React Server Components.
 *
 * `cookies()` hands back an already-decoded *value*, not the raw
 * header, so it is re-wrapped into the header shape before parsing —
 * one code path decides what a valid session cookie looks like, for
 * both the API and the pages.
 */
export function sessionTokenFromStoredValue(value: string | null): string | null {
  return sessionTokenFromCookieHeader(value ? `${SESSION_COOKIE}=${value}` : null);
}

function cookieBase(): string {
  const secure = nodeEnv() === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

/** Set-Cookie value that installs a fresh session token. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieBase()}`;
}

/** Set-Cookie value that removes the session cookie. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
    nodeEnv() === "production" ? "; Secure" : ""
  }`;
}

/* ------------------------------------------------------------------ */
/* Request forgery defence                                             */
/* ------------------------------------------------------------------ */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Origin check for cookie-authenticated state changes.
 *
 * The session cookie is `SameSite=Lax`, so a cross-site form POST never
 * carries it in the first place — this is the second lock. When a browser
 * *does* send `Origin`/`Referer` it must agree with the host we are
 * serving; a mismatch is a cross-site attempt and is refused.
 *
 * Requests without either header (server-to-server, tests, older
 * clients) are allowed: they cannot be a browser navigation, and the
 * cookie itself is SameSite-protected.
 */
export function assertSameOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const declared = origin ?? referer;
  if (!declared || declared === "null") return;
  let host: string;
  try {
    host = new URL(request.url).host;
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "The request URL could not be read.");
  }
  let declaredHost: string;
  try {
    declaredHost = new URL(declared).host;
  } catch {
    throw new HttpError(403, "CSRF_ORIGIN", "The request origin is not valid.");
  }
  if (declaredHost.toLowerCase() !== host.toLowerCase()) {
    throw new HttpError(
      403,
      "CSRF_ORIGIN",
      "This request came from another site and was refused.",
    );
  }
}

/** Client address for rate limiting and audit records. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return request.headers.get("x-real-ip")?.trim().slice(0, 64) || null;
}

/** Truncated User-Agent for session and audit records. */
export function clientUserAgent(request: Request): string | null {
  const value = request.headers.get("user-agent");
  return value ? value.slice(0, 300) : null;
}
