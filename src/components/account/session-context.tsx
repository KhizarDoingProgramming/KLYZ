"use client";

import * as React from "react";

/** The `/api/auth/session` response, mirrored for the client. */
export interface SessionData {
  user: { id: string; email: string; name: string };
  workspaces: { id: string; name: string; slug: string; role: string }[];
  activeWorkspaceId: string;
  role: string;
}

interface SessionState {
  session: SessionData | null;
  loading: boolean;
  refresh: () => void;
}

const SessionContext = React.createContext<SessionState>({
  session: null,
  loading: true,
  refresh: () => {},
});

/**
 * One session read for the whole shell.
 *
 * The cookie is HttpOnly, so the client never holds a token — it asks
 * the server who it is, and every account affordance (workspace
 * switcher, sign out, role-gated links) renders from that answer.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<SessionData | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json() as Promise<SessionData & { authenticated: boolean }>)
      .then((payload) => setSession(payload.authenticated ? payload : null))
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = React.useMemo(
    () => ({ session, loading, refresh }),
    [session, loading, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  return React.useContext(SessionContext);
}
