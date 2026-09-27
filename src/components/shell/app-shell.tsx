"use client";

import * as React from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { openCommandPalette } from "@/components/command/command-palette";
import { SessionProvider } from "@/components/account/session-context";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <SessionProvider>
      <div className="flex h-dvh w-full overflow-hidden bg-app text-fg">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-100 focus:rounded-md focus:border focus:border-line focus:bg-panel focus:px-3 focus:py-2 focus:text-[13px] focus:text-fg"
        >
          Skip to content
        </a>

        <Sidebar
          collapsed={collapsed}
          mobileOpen={mobileOpen}
          onToggleCollapse={() => setCollapsed((value) => !value)}
          onCloseMobile={() => setMobileOpen(false)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            onOpenNav={() => setMobileOpen(true)}
            onOpenPalette={openCommandPalette}
          />
          <main
            id="main-content"
            tabIndex={-1}
            className="relative min-h-0 flex-1 overflow-hidden outline-none"
          >
            {children}
          </main>
        </div>
      </div>
    </SessionProvider>
  );
}
