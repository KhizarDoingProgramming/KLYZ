"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown } from "lucide-react";
import { Menu } from "@/components/ui/menu";
import { useSession } from "./session-context";
import { cn } from "@/lib/utils";

/**
 * Which tenant this session is acting in.
 *
 * Switching is a server decision: the client posts the workspace id it
 * wants, the server confirms the membership and rewrites the session
 * row, and only then does the shell refresh. A workspace the account
 * does not belong to never appears in this list at all — the options
 * come from `workspace_members`, not from anything the browser stores.
 */
export function WorkspaceSwitcher() {
  const router = useRouter();
  const { session, refresh } = useSession();
  const [busy, setBusy] = React.useState(false);

  const workspaces = session?.workspaces ?? [];
  const active =
    workspaces.find((workspace) => workspace.id === session?.activeWorkspaceId) ??
    workspaces[0];

  const switchTo = async (workspaceId: string): Promise<void> => {
    if (busy || workspaceId === session?.activeWorkspaceId) return;
    setBusy(true);
    try {
      const response = await fetch("/api/workspaces/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (response.ok) {
        await refresh();
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return (
      <span
        aria-hidden
        className="hidden h-7 w-32 animate-pulse rounded-md border border-line bg-raised sm:block"
      />
    );
  }

  if (workspaces.length <= 1) {
    return (
      <span className="hidden max-w-[10rem] truncate font-mono text-[11px] uppercase tracking-[0.1em] text-subtle md:block">
        {active?.name ?? "Workspace"}
      </span>
    );
  }

  return (
    <Menu
      label="Switch workspace"
      align="start"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          disabled={busy}
          className={cn(
            "hidden h-7 max-w-[11rem] items-center gap-1.5 rounded-md border border-line bg-surface px-2.5",
            "text-[12.5px] text-muted transition-colors hover:border-strong hover:text-fg sm:inline-flex",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
            busy && "opacity-60",
          )}
        >
          <span className="truncate">{active?.name ?? "Workspace"}</span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-subtle" aria-hidden />
        </button>
      )}
      items={workspaces.map((workspace) => ({
        id: workspace.id,
        label: workspace.name,
        icon:
          workspace.id === session.activeWorkspaceId ? (
            <Check className="h-3.5 w-3.5" aria-hidden />
          ) : undefined,
        disabled: workspace.id === session.activeWorkspaceId,
        onSelect: () => void switchTo(workspace.id),
      }))}
    />
  );
}
