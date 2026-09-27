import Link from "next/link";
import { ArrowUpRight, TriangleAlert } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { buttonClassName } from "@/components/ui/button";
import {
  Greeting,
  HealthStrip,
  RecentActivity,
  RunChain,
  WorkflowHealth,
} from "@/components/dashboard/panels";
import { getDashboardSnapshot } from "@/lib/server/dashboard";
import { requireCurrentActor } from "@/lib/server/session";
import { getWorkspace } from "@/lib/server/workspaces";
import { Duration, TimeAgo } from "@/components/format/time";
import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const actor = await requireCurrentActor();
  const snapshot = getDashboardSnapshot(actor);
  const workspaceName = getWorkspace(actor.workspaceId)?.name ?? "Workspace";
  const { metrics, latest, attention, recent, health } = snapshot;

  return (
    <div className="h-full overflow-y-auto">
      <div className="kz-frame py-8 lg:py-12">
        {/* ---------------------------------------------------------- */}
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="kz-eyebrow mb-2.5 truncate">
              Workspace · {workspaceName}
            </p>
            <Greeting />
            <p className="mt-1.5 max-w-[52ch] text-sm leading-relaxed text-muted">
              {metrics.failures > 0 ? (
                <>
                  Your automations are running, with{" "}
                  <span className="font-medium text-warn">
                    {metrics.failures} run{metrics.failures === 1 ? "" : "s"}
                  </span>{" "}
                  that failed and {metrics.failures === 1 ? "needs" : "need"} a look.
                </>
              ) : (
                "Your automations are running normally."
              )}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/workflows"
              className={buttonClassName("secondary")}
            >
              View all workflows
            </Link>
            <Link
              href="/workflows?new=1"
              className={buttonClassName("primary")}
            >
              New workflow
            </Link>
          </div>
        </header>

        <div className="mt-8">
          <HealthStrip metrics={metrics} />
        </div>

        {/* ---------------------------------------------------------- */}
        <div className="mt-8 grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <Panel
            title="Latest run"
            description={
              latest ? (
                <>
                  {latest.workflowName} ·{" "}
                  <TimeAgo iso={latest.startedAt} className="text-subtle" /> ·{" "}
                  {latest.status === "running" ||
                  latest.status === "queued" ||
                  latest.status === "waiting" ? (
                    <span className="text-subtle">in progress</span>
                  ) : (
                    <Duration ms={latest.durationMs} className="text-subtle" />
                  )}
                </>
              ) : (
                "No runs yet"
              )
            }
            action={
              latest ? (
                <Link
                  href={`/executions/${latest.id}`}
                  className={buttonClassName("ghost", "sm")}
                >
                  Inspect
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              ) : (
                <Link
                  href="/workflows"
                  className={buttonClassName("ghost", "sm")}
                >
                  Open a workflow
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              )
            }
            bodyClassName="flex flex-1 flex-col"
            className="flex flex-col"
          >
            {latest ? (
              <>
                <RunChain execution={latest} className="flex-1" />
                <p className="mt-3 flex items-center gap-2 text-[12px] text-subtle">
                  <span
                    aria-hidden
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      statusMeta(latest.status).dot,
                    )}
                  />
                  {latest.status === "completed"
                    ? `All ${latest.steps.filter((s) => s.status === "completed").length} steps completed.`
                    : latest.status === "failed"
                      ? `Failed at ${
                          latest.steps.find((s) => s.status === "failed")?.nodeLabel ??
                          "an unnamed step"
                        }.`
                      : latest.status === "cancelled"
                        ? "Cancelled before finishing."
                        : "Running — steps stream in as they execute."}
                </p>
              </>
            ) : (
              <p className="text-[12.5px] leading-relaxed text-subtle">
                Open a workflow and run it — the run, its steps and their
                inputs and outputs show up here.
              </p>
            )}
          </Panel>

          <Panel
            title="Workflows"
            description={`${metrics.activeWorkflows} active · ${metrics.runsToday} runs today`}
            action={
              <Link
                href="/workflows"
                className={buttonClassName("quiet", "sm")}
              >
                Open
              </Link>
            }
            flush
          >
            <WorkflowHealth rows={health} />
          </Panel>
        </div>

        {/* ---------------------------------------------------------- */}
        {attention.length > 0 && (
          <Panel
            className="mt-8"
            title="Needs attention"
            description="Runs that stopped before finishing. Open one to see exactly which step failed and why."
            action={
              <Link
                href="/executions?status=failed"
                className={buttonClassName("ghost", "sm")}
              >
                All failures
              </Link>
            }
            flush
          >
            <ul>
              {attention.map((execution) => {
                const failed = execution.steps.find((step) => step.status === "failed");
                return (
                  <li key={execution.id}>
                    <Link
                      href={`/executions/${execution.id}`}
                      className="group flex items-start gap-3 border-b border-hairline py-3.5 transition-colors last:border-b-0 hover:bg-raised/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
                    >
                      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-medium text-fg">
                            {execution.workflowName}
                          </span>
                          <span className="kz-num text-[11px] text-subtle">
                            #{execution.id}
                          </span>
                          {execution.source === "seed" && (
                            <span className="kz-eyebrow rounded-sm border border-warn/40 bg-warn-soft px-1.5 py-[1px] text-[8.5px] text-warn">
                              Seed
                            </span>
                          )}
                        </span>
                        <span className="mt-1 block text-[12px] leading-snug text-muted">
                          {failed?.error?.message ?? "Run did not finish"}{" "}
                          <span className="text-subtle">
                            — at {failed?.nodeLabel ?? "an unknown step"}.
                          </span>
                        </span>
                        {execution.note && (
                          <span className="mt-1 block text-[12px] text-subtle">
                            {execution.note}
                          </span>
                        )}
                      </span>
                      <span className="hidden shrink-0 text-right text-[11px] text-subtle sm:block">
                        <TimeAgo iso={execution.startedAt} />
                        <span className="mt-1 block">
                          <Duration ms={execution.durationMs} />
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}

        <Panel
          className="mt-8"
          title="Recent activity"
          description="Every run across the workspace, newest first."
          action={
            <Link
              href="/executions"
              className={buttonClassName("ghost", "sm")}
            >
              All executions
            </Link>
          }
          flush
        >
          <RecentActivity rows={recent} />
        </Panel>

        <p className="mt-10 max-w-[64ch] text-[11px] leading-relaxed text-subtle">
          Runs execute on the server and stream back live. Rows marked “Seed”
          are development data, clearly flagged everywhere they appear.
        </p>
      </div>
    </div>
  );
}
