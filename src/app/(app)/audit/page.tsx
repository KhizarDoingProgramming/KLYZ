"use client";

import * as React from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { TimeAgo } from "@/components/format/time";

interface AuditEvent {
  id: string;
  action: string;
  actorId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

/** Group a raw action into a section label. */
function familyOf(action: string): string {
  return action.split(".")[0] ?? "other";
}

/**
 * The workspace audit trail.
 *
 * Rows come from `/api/audit`, which only ever returns events written
 * for the acting workspace. Metadata was redacted on the way in, so
 * this view can never surface a token, password or credential value —
 * and the filter box runs server-side against the same scoped query.
 */
export default function AuditPage() {
  const [events, setEvents] = React.useState<AuditEvent[] | null>(null);
  const [action, setAction] = React.useState("");
  const [needle, setNeedle] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  /* No synchronous state writes: the first paint of this page is the
     `events === null` skeleton, and every mutation lands in a promise
     callback after the response arrives. */
  const load = React.useCallback((filter: string) => {
    const query = new URLSearchParams({ limit: "200" });
    if (filter) query.set("action", filter);
    fetch(`/api/audit?${query.toString()}`, { cache: "no-store" })
      .then((response) => response.json() as Promise<{ events?: AuditEvent[]; error?: { message?: string } }>)
      .then((payload) => {
        setEvents(payload.events ?? []);
        setError(
          payload.events ? null : payload.error?.message ?? "The audit trail could not be loaded.",
        );
      })
      .catch(() => setError("The audit trail could not be loaded."))
      .finally(() => setRefreshing(false));
  }, []);

  const reload = React.useCallback(
    (filter: string) => {
      setRefreshing(true);
      load(filter);
    },
    [load],
  );

  React.useEffect(() => {
    load("");
  }, [load]);

  const visible = React.useMemo(() => {
    const rows = events ?? [];
    const term = needle.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) =>
      `${row.action} ${row.resourceType ?? ""} ${row.resourceId ?? ""}`
        .toLowerCase()
        .includes(term),
    );
  }, [events, needle]);

  const families = React.useMemo(() => {
    const set = new Set((events ?? []).map((event) => event.action));
    return [...set].sort();
  }, [events]);

  return (
    <div className="kz-frame overflow-y-auto py-8 lg:py-12">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-edge pb-6">
        <div>
          <p className="kz-eyebrow mb-3">Security</p>
          <h1 className="kz-display text-display-sm font-semibold tracking-[-0.02em] text-fg">
            Audit log
          </h1>
          <p className="mt-2 max-w-[62ch] text-[13.5px] leading-relaxed text-muted">
            Who signed in, who changed a role, which credential or webhook was
            touched. Entries are written by the server, scoped to this workspace,
            and redacted before they are stored.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          className="h-8"
          disabled={refreshing}
          onClick={() => reload(action)}
        >
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
          Refresh
        </Button>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-5 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-[12.5px] text-danger"
        >
          {error}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-end gap-3">
        <Field label="Action" htmlFor="kz-audit-action" className="min-w-[240px] flex-1">
          <Select
            id="kz-audit-action"
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
              reload(event.target.value);
            }}
          >
            <option value="">All actions</option>
            {families.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Contains" htmlFor="kz-audit-contains" className="min-w-[200px] flex-1">
          <Input
            id="kz-audit-contains"
            placeholder="resource id or action"
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
          />
        </Field>
      </div>

      <Panel className="mt-6" title="Events" flush>
        {events === null || (refreshing && events.length === 0) ? (
          <div className="flex items-center justify-center gap-2 px-6 py-12 text-[13px] text-subtle">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading events
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            title="Nothing recorded yet"
            description="Sign-ins, role changes and credential operations will appear here as they happen."
          />
        ) : (
          <ul>
            {visible.map((event) => (
              <li
                key={event.id}
                className="grid gap-2 border-b border-hairline px-4 py-3 last:border-b-0 sm:grid-cols-[170px_minmax(0,1fr)_auto]"
              >
                <div className="flex items-center gap-2">
                  <Badge tone={familyOf(event.action) === "auth" ? "signal" : "neutral"}>
                    {familyOf(event.action)}
                  </Badge>
                  <span className="kz-num text-[11px] text-subtle">
                    {event.createdAt.replace("T", " ").replace("Z", "")}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="kz-num truncate text-[12.5px] text-fg">{event.action}</p>
                  <p className="truncate text-[12px] text-subtle">
                    {event.resourceType ? `${event.resourceType} · ` : ""}
                    {event.resourceId ?? "—"}
                    {event.metadata ? ` · ${JSON.stringify(event.metadata)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-[11.5px] text-subtle sm:justify-end">
                  <span className="kz-num">{event.actorId ?? "anonymous"}</span>
                  {event.ip && <span className="kz-num hidden sm:inline">{event.ip}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="mt-4 text-[12.5px] text-subtle">
        Showing {visible.length} of {events?.length ?? 0} loaded events (up to 200 per
        workspace).{" "}
        <TimeAgo iso={visible[0]?.createdAt ?? null} prefix="latest " />
      </p>
    </div>
  );
}
