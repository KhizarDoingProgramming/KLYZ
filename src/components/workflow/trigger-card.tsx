"use client";

import * as React from "react";
import { Clock, Loader2, TriangleAlert } from "lucide-react";
import { Switch } from "@/components/ui/field";
import {
  getWorkflowTrigger,
  setWorkflowTrigger,
  type TriggerView,
} from "@/lib/integrations/client";
import { cn } from "@/lib/utils";

/**
 * Trigger card — the arming state of one workflow's trigger.
 *
 * Read-only about the *expression*: a schedule is authored on the node
 * (Interval / Cron / Timezone in Configuration) and adopted by the
 * server when the workflow is published, so this card reports what is
 * actually going to run — next occurrence, upcoming occurrences, and
 * what happened last time — computed by the server with the same cron
 * parser the worker uses. What the card promises and what the worker
 * does cannot disagree, because only one of them does the arithmetic.
 *
 * The one thing it owns is the enable switch, which is independent of
 * the definition: you can leave a schedule published and switch it off.
 * Provider triggers (GitHub/Gmail/Slack) have their own endpoint card
 * and never render this one.
 */
export function TriggerCard({ workflowId }: { workflowId: string | null }) {
  const [trigger, setTrigger] = React.useState<TriggerView | null>(null);
  const [status, setStatus] = React.useState<"loading" | "idle" | "saving">("loading");
  const [message, setMessage] = React.useState<{ tone: "ok" | "error"; text: string } | null>(
    null,
  );

  React.useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    getWorkflowTrigger(workflowId)
      .then((next) => {
        if (cancelled) return;
        setTrigger(next);
        setStatus("idle");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus("idle");
        setMessage({
          tone: "error",
          text: error instanceof Error ? error.message : "The trigger could not be read.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  const setEnabled = async (enabled: boolean): Promise<void> => {
    if (!workflowId || status === "saving") return;
    setStatus("saving");
    setMessage(null);
    try {
      setTrigger(await setWorkflowTrigger(workflowId, { enabled }));
      setStatus("idle");
      setMessage({ tone: "ok", text: enabled ? "Trigger armed." : "Trigger switched off." });
    } catch (error) {
      setStatus("idle");
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "The trigger could not be saved.",
      });
    }
  };

  if (!workflowId) return null;

  if (status === "loading" && !trigger) {
    return (
      <section>
        <SectionHeading />
        <p className="flex items-center gap-2 rounded-lg border border-edge bg-raised px-3.5 py-3 text-[12px] text-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading this workflow&apos;s trigger…
        </p>
      </section>
    );
  }
  if (!trigger || !trigger.managed) return null;

  return (
    <section>
      <SectionHeading armed={trigger.armed} blockedBy={trigger.blockedBy} />

      <div className="flex flex-col gap-3 rounded-lg border border-edge bg-raised p-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[12.5px] font-medium text-fg">
              {trigger.type === "schedule"
                ? "Scheduled runs"
                : trigger.type === "webhook"
                  ? "Webhook deliveries"
                  : "Manual runs"}
            </p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-subtle">
              {trigger.enabled
                ? "This trigger can start the workflow."
                : "Switched off — nothing starts the workflow."}
            </p>
          </div>
          <Switch
            checked={trigger.enabled}
            label="Enable trigger"
            disabled={status === "saving"}
            onCheckedChange={(next) => void setEnabled(next)}
          />
        </div>

        {trigger.schedule && <NextRun schedule={trigger.schedule} />}

        {trigger.blockedBy && (
          <p className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/10 px-2.5 py-2 text-[11.5px] leading-snug text-warn">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{trigger.blockedBy}</span>
          </p>
        )}

        {message && (
          <p className={cn("text-[11.5px]", message.tone === "ok" ? "text-ok" : "text-danger")}>
            {message.text}
          </p>
        )}

        {trigger.recent.length > 0 && <RecentFires trigger={trigger} />}
      </div>
    </section>
  );
}

function SectionHeading({
  armed,
  blockedBy,
}: {
  armed?: boolean;
  blockedBy?: string | null;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="kz-eyebrow text-[9.5px]">Trigger</h2>
      <span className="h-px flex-1 bg-hairline" />
      {armed !== undefined && (
        <span
          className={cn(
            "kz-eyebrow inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[9px]",
            armed ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn",
          )}
        >
          <span
            aria-hidden
            className={cn("h-1.5 w-1.5 rounded-full", armed ? "bg-ok" : "bg-warn")}
          />
          {armed ? "Armed" : blockedBy ? "Blocked" : "Off"}
        </span>
      )}
    </div>
  );
}

function NextRun({ schedule }: { schedule: NonNullable<TriggerView["schedule"]> }) {
  if (!schedule.nextRunAt || schedule.preview.length === 0) {
    return (
      <div className="rounded-md border border-edge bg-panel px-2.5 py-2">
        <p className="kz-eyebrow text-[9px]">Published schedule</p>
        <p className="mt-1 text-[11.5px] text-subtle">No upcoming runs.</p>
        <p className="mt-1 text-[11px] text-subtle">
          {schedule.cron} · {schedule.timezone}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-edge bg-panel px-2.5 py-2">
      <p className="kz-eyebrow text-[9px]">Next run</p>
      <p className="mt-1 flex items-center gap-1.5 font-mono text-[12px] text-fg">
        <Clock className="h-3.5 w-3.5 shrink-0 text-subtle" />
        {formatIn(schedule.nextRunAt, schedule.timezone)}
      </p>
      {schedule.preview.length > 1 && (
        <p className="mt-1 text-[11px] leading-snug text-subtle">
          then{" "}
          {schedule.preview
            .slice(1)
            .map((iso) => formatIn(iso, schedule.timezone))
            .join(", ")}
        </p>
      )}
      <p className="mt-1 text-[11px] text-subtle">
        {schedule.cron} · {schedule.timezone}
      </p>
    </div>
  );
}

function RecentFires({ trigger }: { trigger: TriggerView }) {
  return (
    <div>
      <p className="kz-eyebrow mb-1.5 text-[9px]">Recent firings</p>
      <ul className="flex flex-col gap-1">
        {trigger.recent.map((fire) => (
          <li
            key={`${fire.at}-${fire.executionId ?? fire.status}`}
            className="flex items-center gap-2 rounded-md border border-edge bg-panel px-2.5 py-1.5 text-[11.5px]"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-muted">
              {formatIn(fire.at, trigger.schedule?.timezone ?? "UTC")}
            </span>
            <StatusChip status={fire.status} />
            {fire.executionId && (
              <a
                className="shrink-0 truncate font-mono text-[11px] text-signal-text hover:underline"
                href={`/executions/${fire.executionId}`}
              >
                {fire.executionId}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "queued"
      ? "bg-ok/15 text-ok"
      : status === "failed"
        ? "bg-danger/15 text-danger"
        : "bg-warn/15 text-warn";
  return (
    <span className={cn("kz-eyebrow shrink-0 rounded-sm px-1.5 py-0.5 text-[9px]", tone)}>
      {status}
    </span>
  );
}

function formatIn(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}
