"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsUpDown, Plus } from "lucide-react";
import { KlyzLogo } from "@/components/brand";
import { ShellGlyph } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useWorkflowsStore } from "@/stores/workflows";
import { useExecutionStore } from "@/stores/execution";
import { NAV_SECTIONS, isNavActive, type NavItem } from "@/lib/shell/nav";

function NavButton({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const content = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-8 items-center gap-2.5 rounded-sm px-2.5 transition-colors duration-micro",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
        collapsed && "justify-center px-0",
        active
          ? "text-fg"
          : "text-muted hover:bg-raised/50 hover:text-fg",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-signal transition-opacity duration-micro",
          active ? "opacity-100" : "opacity-0",
        )}
      />
      <ShellGlyph
        name={item.icon}
        className={cn(
          "h-4 w-4 shrink-0 transition-colors",
          active ? "text-signal-text" : "text-subtle group-hover:text-muted",
        )}
      />
      {!collapsed && (
        <span className="truncate font-mono text-[10.5px] uppercase tracking-[0.1em]">
          {item.label}
        </span>
      )}
      {!collapsed && item.shortcut && (
        <span className="ml-auto font-mono text-[10px] text-subtle">
          {item.shortcut}
        </span>
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip label={item.label} side="right">
        {content}
      </Tooltip>
    );
  }
  return content;
}

export function Sidebar({
  collapsed,
  mobileOpen,
  onToggleCollapse,
  onCloseMobile,
}: {
  collapsed: boolean;
  mobileOpen: boolean;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
}) {
  const pathname = usePathname();

  const body = (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "flex h-14 shrink-0 items-center px-3",
          collapsed && "justify-center px-0",
        )}
      >
        <Link
          href="/"
          aria-label="KLYZ home"
          className="flex items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        >
          <KlyzLogo compact={collapsed} />
        </Link>
      </div>

      <nav
        aria-label="Primary"
        className="flex flex-1 flex-col gap-6 overflow-y-auto px-2.5 py-4"
      >
        {NAV_SECTIONS.map((section, index) => (
          <div key={section.label ?? index} className="flex flex-col gap-1">
            {section.label && !collapsed && (
              <div className="kz-eyebrow px-2.5 pb-1.5">{section.label}</div>
            )}
            {section.label && collapsed && (
              <div aria-hidden className="mx-2 mb-1.5 h-px bg-edge" />
            )}
            {section.items.map((item) => (
              <NavButton
                key={item.href}
                item={item}
                collapsed={collapsed}
                active={isNavActive(item, pathname)}
                onNavigate={onCloseMobile}
              />
            ))}
          </div>
        ))}

        {!collapsed && (
          <Link
            href="/workflows?new=1"
            className="mt-auto flex h-8 items-center gap-2 rounded-sm px-2.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-subtle transition-colors hover:text-signal-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            <Plus className="h-3.5 w-3.5" />
            New workflow
          </Link>
        )}
      </nav>

      <div
        className={cn(
          "shrink-0 border-t border-edge p-2.5",
          collapsed && "px-1.5",
        )}
      >
        {!collapsed && <SystemPulse />}
        {!collapsed && (
          <div className="mb-2 flex items-center justify-between px-2.5 font-mono text-[9px] uppercase tracking-[0.1em] text-subtle/70">
            <span>By Mustafa</span>
            <Link href="/terms" className="hover:text-fg transition-colors">About</Link>
          </div>
        )}
        <button
          type="button"
          onClick={onToggleCollapse}
          className={cn(
            "mt-1 flex h-7 w-full items-center gap-2.5 rounded-sm px-2.5 font-mono text-[10px] uppercase tracking-[0.1em] text-subtle transition-colors hover:text-fg",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
            collapsed && "justify-center px-0",
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <ChevronsUpDown className={cn("h-3.5 w-3.5", collapsed && "rotate-90")} />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* desktop rail */}
      <aside
        className={cn(
          "hidden shrink-0 border-r border-edge bg-app transition-[width] duration-standard ease-out lg:block",
          collapsed ? "w-14" : "w-[232px]",
        )}
      >
        {body}
      </aside>

      {/* mobile drawer */}
      <div
        className={cn(
          "fixed inset-0 z-50 lg:hidden",
          mobileOpen ? "block" : "hidden",
        )}
      >
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onCloseMobile}
          className="kz-scrim absolute inset-0"
        />
        <aside className="absolute inset-y-0 left-0 w-[264px] border-r border-edge bg-app shadow-lg">
          {body}
        </aside>
      </div>
    </>
  );
}

function SystemPulse() {
  const init = useWorkflowsStore((state) => state.init);
  const workflows = useWorkflowsStore((state) => state.workflows);
  const runStatus = useExecutionStore((state) => state.status);

  React.useEffect(() => {
    init();
  }, [init]);

  const active = workflows.filter((workflow) => workflow.status === "active").length;
  const running = runStatus === "running";
  const failed = runStatus === "failed";

  const headline = running
    ? "Run in flight"
    : failed
      ? "Run needs attention"
      : "Systems nominal";

  return (
    <Link
      href="/executions"
      className="mb-2 flex items-start gap-2.5 rounded-sm px-2.5 py-2 transition-colors hover:bg-raised/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
    >
      <span className="relative mt-[3px] flex h-1.5 w-1.5 shrink-0">
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            failed ? "bg-danger" : "bg-signal",
          )}
        />
        <span
          className={cn(
            "relative inline-flex h-1.5 w-1.5 rounded-full",
            failed ? "bg-danger" : "bg-signal",
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block font-mono text-[10px] uppercase leading-tight tracking-[0.1em] text-muted">
          {headline}
        </span>
        <span className="mt-1 block text-[11px] leading-tight text-subtle">
          {active} workflow{active === 1 ? "" : "s"} active ·{" "}
          {running ? "1 run in flight" : "no runs in flight"}
        </span>
      </span>
    </Link>
  );
}
