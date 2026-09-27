"use client";

import Link from "next/link";

import * as React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { buttonClassName } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select, Segmented, Switch } from "@/components/ui/field";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { useSession } from "@/components/account/session-context";
import { useWorkflowsStore } from "@/stores/workflows";
import { useClientValue, type Theme } from "@/lib/react";

function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

function applyTheme(next: Theme): void {
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("klyz.theme", next);
  } catch {
    /* storage unavailable — session-only theme is fine */
  }
}

const RETRY_OPTIONS = [
  { value: "0", label: "0" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
];

const TIMEOUT_OPTIONS = [
  { value: "5000", label: "5 seconds" },
  { value: "10000", label: "10 seconds" },
  { value: "30000", label: "30 seconds" },
  { value: "60000", label: "60 seconds" },
];

const CONCURRENCY_OPTIONS = [
  { value: "1", label: "1 run at a time" },
  { value: "4", label: "4 runs at a time" },
  { value: "10", label: "10 runs at a time" },
  { value: "25", label: "25 runs at a time" },
];

export default function SettingsPage() {
  const clientTheme = useClientValue<Theme>("dark", readTheme);
  const [themeOverride, setThemeOverride] = React.useState<Theme | null>(null);
  const theme = themeOverride ?? clientTheme;

  const clearLocalCache = useWorkflowsStore((state) => state.clearLocalCache);
  const cachedCount = useWorkflowsStore((state) => state.cachedCount);

  const { session, refresh } = useSession();
  const activeWorkspace =
    session?.workspaces.find((item) => item.id === session.activeWorkspaceId) ??
    session?.workspaces[0];
  const canManage = session?.role === "owner" || session?.role === "admin";
  /* The draft starts empty and only diverges once someone types, so the
     live server name is shown as soon as the session lands — no effect,
     no flash of a placeholder. */
  const [workspaceDraft, setWorkspaceDraft] = React.useState<string | null>(null);
  const workspace = workspaceDraft ?? activeWorkspace?.name ?? "";
  const [workspaceSaved, setWorkspaceSaved] = React.useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = React.useState<string | null>(null);
  const [retries, setRetries] = React.useState("2");
  const [timeout, setTimeoutMs] = React.useState("10000");
  const [concurrency, setConcurrency] = React.useState("4");
  const [stopOnError, setStopOnError] = React.useState(true);
  const [redact, setRedact] = React.useState(true);
  const [confirmReset, setConfirmReset] = React.useState(false);

  React.useEffect(() => {
    if (!confirmReset) return;
    const timer = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmReset]);


  const saveWorkspace = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setWorkspaceSaved(null);
    setWorkspaceError(null);
    try {
      const response = await fetch("/api/workspaces/current", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: workspace }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { workspace?: { name: string }; error?: { message?: string } }
        | null;
      if (!response.ok || !payload?.workspace) {
        setWorkspaceError(payload?.error?.message ?? "The name could not be saved.");
        return;
      }
      setWorkspaceDraft(payload.workspace.name);
      setWorkspaceSaved("Saved.");
      await refresh();
    } catch {
      setWorkspaceError("The server could not be reached.");
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[840px] px-5 py-8 sm:px-8 sm:py-10">
        <header>
          <p className="kz-eyebrow mb-2.5">Preferences</p>
          <h1 className="text-page text-fg">Settings</h1>
          <p className="mt-1.5 max-w-[58ch] text-sm leading-relaxed text-muted">
            Workspace identity, appearance and execution defaults. Preferences
            are stored in this browser; the workspace name is saved server-side.
          </p>
        </header>

        <div className="mt-8 flex flex-col gap-5">
          {/* workspace ------------------------------------------------ */}
          <Panel
            title="Workspace"
            description="Your tenant: members, credentials, runs and endpoints all belong to it."
            action={
              session ? <Badge tone="signal">{session.role}</Badge> : undefined
            }
          >
            <form
              onSubmit={(event) => void saveWorkspace(event)}
              className="flex flex-col gap-4 sm:flex-row sm:items-start"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-signal/30 bg-signal-soft text-[15px] font-semibold text-signal-text">
                {(workspace || "?").slice(0, 2).toUpperCase()}
              </div>
              <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2">
                <Field
                  label="Workspace name"
                  htmlFor="ws-name"
                  help={canManage ? undefined : "Only admins and owners can rename it."}
                  error={workspaceError ?? undefined}
                >
                  <Input
                    id="ws-name"
                    value={workspace}
                    disabled={!canManage}
                    onChange={(event) => {
                      setWorkspaceDraft(event.target.value);
                      setWorkspaceSaved(null);
                    }}
                  />
                </Field>
                <Field
                  label="Workspace id"
                  htmlFor="ws-id"
                  help="Fixed — used by API calls and audit rows."
                >
                  <Input id="ws-id" mono readOnly value={activeWorkspace?.id ?? "—"} />
                </Field>
              </div>
              <div className="flex items-center gap-3 sm:pt-6">
                <Button
                  type="submit"
                  variant="secondary"
                  className="h-8"
                  disabled={!canManage || !workspace.trim()}
                >
                  Save
                </Button>
                {workspaceSaved && (
                  <span className="text-[12.5px] text-ok">{workspaceSaved}</span>
                )}
              </div>
            </form>
            <div className="mt-4 flex flex-wrap gap-3 border-t border-hairline pt-4 text-[12.5px]">
              <Link href="/members" className="text-muted underline decoration-line underline-offset-4 hover:text-fg">
                Members
              </Link>
              <Link href="/audit" className="text-muted underline decoration-line underline-offset-4 hover:text-fg">
                Audit log
              </Link>
            </div>
          </Panel>

          {/* appearance ----------------------------------------------- */}
          <Panel
            title="Appearance"
            description="Dark is the KLYZ default; light is designed for daylight."
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <div className="min-w-0 max-w-[380px] flex-1">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium leading-none text-muted">
                    Theme
                  </span>
                  <Segmented
                    ariaLabel="Colour theme"
                    value={theme}
                    onChange={(next) => {
                      const value = next as Theme;
                      applyTheme(value);
                      setThemeOverride(value);
                    }}
                    options={[
                      { value: "dark", label: "Dark" },
                      { value: "light", label: "Light" },
                    ]}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-subtle">Quick toggle</span>
                <ThemeToggle />
              </div>
            </div>
          </Panel>

          {/* execution ------------------------------------------------ */}
          <Panel
            title="Execution defaults"
            description="Applied to every new workflow unless it overrides them."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Step timeout" htmlFor="set-timeout">
                <Select
                  id="set-timeout"
                  value={timeout}
                  onChange={(event) => setTimeoutMs(event.target.value)}
                >
                  {TIMEOUT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Retry failed steps">
                <Segmented
                  ariaLabel="Retry count"
                  value={retries}
                  onChange={setRetries}
                  options={RETRY_OPTIONS}
                />
              </Field>

              <Field label="Concurrency" htmlFor="set-concurrency">
                <Select
                  id="set-concurrency"
                  value={concurrency}
                  onChange={(event) => setConcurrency(event.target.value)}
                >
                  {CONCURRENCY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <div className="flex flex-col justify-end gap-3 pb-1">
                <label className="flex items-start gap-2.5">
                  <span className="pt-0.5">
                    <Switch
                      checked={stopOnError}
                      onCheckedChange={setStopOnError}
                      label="Stop the run on the first error"
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12.5px] text-fg">
                      Stop on first error
                    </span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-subtle">
                      Otherwise parallel branches keep going.
                    </span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5">
                  <span className="pt-0.5">
                    <Switch
                      checked={redact}
                      onCheckedChange={setRedact}
                      label="Redact secrets from logs"
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12.5px] text-fg">
                      Redact secrets
                    </span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-subtle">
                      Passwords and tokens never reach execution logs.
                    </span>
                  </span>
                </label>
              </div>
            </div>
          </Panel>

          {/* data ----------------------------------------------------- */}
          <Panel
            title="Local recovery cache"
            description={`${cachedCount} workflow${cachedCount === 1 ? "" : "s"} cached in this browser.`}
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                <p className="text-[12.5px] leading-relaxed text-subtle">
                  Your workflows live on the server. This browser keeps a copy so
                  the workspace still opens offline. Clearing it only drops that
                  copy and reloads from the server.
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  if (!confirmReset) {
                    setConfirmReset(true);
                    return;
                  }
                  clearLocalCache();
                  setConfirmReset(false);
                }}
                className={buttonClassName(
                  confirmReset ? "danger" : "secondary",
                  "md",
                  "shrink-0 font-medium",
                )}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {confirmReset ? "Click again to confirm" : "Clear recovery cache"}
              </button>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
