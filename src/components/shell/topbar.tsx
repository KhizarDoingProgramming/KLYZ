"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu, Search } from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { AccountMenu } from "@/components/account/account-menu";
import { WorkspaceSwitcher } from "@/components/account/workspace-switcher";
import { Kbd } from "@/components/ui/kbd";
import { useWorkflowsStore } from "@/stores/workflows";
import { useExecutionStore } from "@/stores/execution";
import { getExecution } from "@/lib/execution/api";
import { cn, formatDuration } from "@/lib/utils";

function useBreadcrumbs() {
  const pathname = usePathname();
  const workflows = useWorkflowsStore((state) => state.workflows);
  const [runName, setRunName] = React.useState<{
    id: string;
    name: string;
  } | null>(null);

  /* Execution detail crumbs resolve over the API (runs are server data). */
  React.useEffect(() => {
    const segments = pathname.split("/").filter(Boolean);
    const executionId = segments[0] === "executions" ? segments[1] : undefined;
    if (!executionId) return;
    let cancelled = false;
    getExecution(executionId)
      .then((execution) => {
        if (!cancelled) setRunName({ id: executionId, name: execution.workflowName });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return React.useMemo(() => {
    const segments = pathname.split("/").filter(Boolean);
    const crumbs: { label: string; href: string }[] = [];
    let href = "";

    for (const segment of segments) {
      href += `/${segment}`;
      if (segment === "dashboard") crumbs.push({ label: "Dashboard", href });
      else if (segment === "workflows") crumbs.push({ label: "Workflows", href });
      else if (segment === "executions") crumbs.push({ label: "Executions", href });
      else if (segment === "integrations") crumbs.push({ label: "Integrations", href });
      else if (segment === "settings") crumbs.push({ label: "Settings", href });
      else if (href.startsWith("/workflows/")) {
        const workflow = workflows.find((item) => item.id === segment);
        crumbs.push({ label: workflow?.name ?? "Workflow", href });
      } else if (href.startsWith("/executions/")) {
        const label =
          runName && runName.id === segment ? runName.name : "Run";
        crumbs.push({ label, href });
      } else {
        crumbs.push({ label: segment, href });
      }
    }
    return crumbs;
  }, [pathname, workflows, runName]);
}

export function Topbar({
  onOpenNav,
  onOpenPalette,
}: {
  onOpenNav: () => void;
  onOpenPalette: () => void;
}) {
  const crumbs = useBreadcrumbs();
  const router = useRouter();
  const runStatus = useExecutionStore((state) => state.status);
  const runWorkflowId = useExecutionStore((state) => state.workflowId);
  const runElapsed = useExecutionStore((state) => state.elapsedMs);
  const isRunning = useExecutionStore((state) => state.isRunning);

  const run = {
    isRunning,
    workflowId: runWorkflowId,
    elapsedMs: runElapsed,
    status: runStatus,
  };

  const live = run.status !== "idle";

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-edge bg-app px-3 sm:px-4">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal lg:hidden"
      >
        <Menu className="h-4 w-4" />
      </button>

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex items-center gap-2">
          {crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            return (
              <li key={crumb.href} className="flex min-w-0 items-center gap-2">
                {index > 0 && (
                  <span
                    aria-hidden
                    className="shrink-0 font-mono text-[11px] text-disabled"
                  >
                    /
                  </span>
                )}
                {isLast ? (
                  <span
                    aria-current="page"
                    className="kz-display truncate text-[14px] font-semibold tracking-[-0.01em] text-fg"
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <Link
                    href={crumb.href}
                    className="truncate font-mono text-[10.5px] uppercase tracking-[0.1em] text-subtle transition-colors hover:text-fg"
                  >
                    {crumb.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {live && run.workflowId && (
        <button
          type="button"
          onClick={() => router.push(`/workflows/${run.workflowId}`)}
          className={cn(
            "hidden items-center gap-2 rounded-md border px-2.5 py-1 text-[12px] transition-colors sm:inline-flex",
            run.isRunning
              ? "border-signal/40 bg-live-soft text-signal-text"
              : run.status === "completed"
                ? "border-ok/40 bg-ok-soft text-ok"
                : run.status === "failed"
                  ? "border-danger/40 bg-danger-soft text-danger"
                  : "border-line bg-raised text-muted",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              run.isRunning ? "animate-pulse bg-signal" : "bg-current",
            )}
          />
          {run.isRunning
            ? run.status === "queued"
              ? "Queued"
              : run.status === "waiting"
                ? "Waiting"
                : "Running"
            : run.status === "completed"
              ? "Run finished"
              : run.status === "failed"
                ? "Run failed"
                : "Run cancelled"}
          <span className="kz-num text-subtle">{formatDuration(run.elapsedMs)}</span>
        </button>
      )}

      <button
        type="button"
        onClick={onOpenPalette}
        className={cn(
          "hidden h-8 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-[13px] text-subtle transition-colors hover:border-strong hover:text-fg",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
          "md:inline-flex",
        )}
      >
        <Search className="h-3.5 w-3.5" />
        Search
        <Kbd className="ml-4">⌘K</Kbd>
      </button>

      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Open command palette"
        className="flex h-8 w-8 items-center justify-center rounded-md text-subtle transition-colors hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal md:hidden"
      >
        <Search className="h-4 w-4" />
      </button>

      <span aria-hidden className="hidden h-5 w-px bg-edge sm:block" />

      <WorkspaceSwitcher />

      <ThemeToggle />

      <AccountMenu />
    </header>
  );
}
