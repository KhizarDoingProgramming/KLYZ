import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, sessionTokenFromStoredValue } from "./auth";
import {
  actorFromToken,
  requireAuthenticatedActor,
  WORKSPACE_HEADER,
  type AuthenticatedActor,
} from "./identity";

/**
 * Actor resolution for React Server Components.
 *
 * Server pages cannot build a `Request`, so the session cookie is read
 * from `next/headers` and handed to the same `actorFromToken` the API
 * uses — one identity implementation, two entry points. Anything that
 * needs a workspace must come through `requireCurrentActor`, which
 * bounces an anonymous visitor to `/login` instead of rendering another
 * tenant's numbers.
 */

export async function currentActor(): Promise<AuthenticatedActor | null> {
  const store = await cookies();
  const token = sessionTokenFromStoredValue(store.get(SESSION_COOKIE)?.value ?? null);
  const requestHeaders = await headers();
  return actorFromToken(token, requestHeaders.get(WORKSPACE_HEADER));
}

/** Authenticated actor or a redirect to the sign-in page. */
export async function requireCurrentActor(): Promise<AuthenticatedActor> {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  return actor;
}

/**
 * Exact mirror of `requireAuthenticatedActor` for code that already has
 * an incoming `Request` (route handlers reading cookies twice).
 */
export { requireAuthenticatedActor };
