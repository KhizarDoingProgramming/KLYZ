"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOut, Settings, ShieldCheck, Users } from "lucide-react";
import { Menu } from "@/components/ui/menu";
import { useSession } from "./session-context";

function initialsOf(name: string, email: string): string {
  const source = name.trim() || email.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "");
  return letters.join("") || source.slice(0, 2).toUpperCase();
}

const canManageWorkspace = (role: string) => role === "owner" || role === "admin";

/**
 * The account affordance in the top bar: who you are, where the
 * management screens live, and how to sign out.
 *
 * Role-gated entries are hidden rather than disabled — a viewer never
 * sees an invite button they would be refused anyway. Sign out is a
 * server call so the session row is destroyed, not just the page.
 */
export function AccountMenu() {
  const router = useRouter();
  const { session, refresh } = useSession();
  const [busy, setBusy] = React.useState(false);

  const user = session?.user;
  const role = session?.role ?? "viewer";

  const signOut = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      await refresh();
      router.replace("/login");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!user) {
    return (
      <span
        aria-hidden
        className="h-7 w-7 animate-pulse rounded-full border border-line bg-raised"
      />
    );
  }

  const items = [
    ...(canManageWorkspace(role)
      ? [
          {
            id: "members",
            label: "Members",
            icon: <Users className="h-3.5 w-3.5" aria-hidden />,
            onSelect: () => router.push("/members"),
          },
          {
            id: "audit",
            label: "Audit log",
            icon: <ShieldCheck className="h-3.5 w-3.5" aria-hidden />,
            onSelect: () => router.push("/audit"),
          },
        ]
      : []),
    {
      id: "settings",
      label: "Settings",
      icon: <Settings className="h-3.5 w-3.5" aria-hidden />,
      onSelect: () => router.push("/settings"),
    },
    {
      id: "logout",
      label: busy ? "Signing out…" : "Sign out",
      icon: <LogOut className="h-3.5 w-3.5" aria-hidden />,
      danger: true,
      disabled: busy,
      onSelect: () => void signOut(),
    },
  ];

  return (
    <Menu
      label="Account"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          aria-label={`Account — ${user.name}`}
          className={cnAvatar}
        >
          {initialsOf(user.name, user.email)}
        </button>
      )}
      items={items}
    />
  );
}

const cnAvatar =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-raised " +
  "text-[11px] font-semibold text-muted transition-colors hover:border-strong hover:text-fg " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";
