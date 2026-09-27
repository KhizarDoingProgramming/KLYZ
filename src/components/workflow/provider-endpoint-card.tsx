"use client";

import * as React from "react";
import { Check, Copy, Globe, Loader2, Send, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { snapshotWorkflow, useEditorStore } from "@/stores/editor";
import { useWorkflowsStore } from "@/stores/workflows";
import { validateWorkflow } from "@/lib/workflow/validation";
import {
  deleteProviderWebhook,
  getProviderWebhook,
  publishProviderWebhook,
  type ProviderWarning,
  type ProviderWebhookView,
} from "@/lib/integrations/client";
import { cn } from "@/lib/utils";

/**
 * Endpoint card for provider-owned triggers (GitHub hook, Gmail push).
 *
 * Same job as the generic webhook card, different contract: the URL is
 * unguessable and workspace-scoped, deliveries are idempotent on the
 * provider's delivery id, and publishing may come back with a warning
 * when GitHub refuses to register the repository hook (typically because
 * `admin:repo_hook` was not granted). The row is still stored in that
 * case, so the URL and one-time secret stay usable for a manual setup.
 */
export function ProviderEndpointCard({
  workflowId,
  nodeType,
}: {
  workflowId: string | null;
  nodeType: "trigger.github" | "trigger.gmail" | "trigger.slack";
}) {
  const [endpoint, setEndpoint] = React.useState<ProviderWebhookView | null>(null);
  const [warning, setWarning] = React.useState<ProviderWarning | null>(null);
  const [status, setStatus] = React.useState<"loading" | "idle" | "saving">("loading");
  const [message, setMessage] = React.useState<{ tone: "ok" | "error"; text: string } | null>(
    null,
  );
  const [copied, setCopied] = React.useState(false);
  const [secretCopied, setSecretCopied] = React.useState(false);

  React.useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    getProviderWebhook(workflowId)
      .then((webhook) => {
        if (cancelled) return;
        setEndpoint(webhook);
        setStatus("idle");
      })
      .catch(() => {
        if (!cancelled) setStatus("idle");
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  const publish = async () => {
    if (!workflowId || status === "saving") return;
    const definition = snapshotWorkflow(useEditorStore.getState());
    const errors = validateWorkflow(definition).filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
      setMessage({
        tone: "error",
        text: `Fix ${errors.length} validation ${errors.length === 1 ? "issue" : "issues"} before publishing.`,
      });
      return;
    }
    setStatus("saving");
    setMessage(null);
    setWarning(null);
    try {
      /* Save first: the endpoint registers against the server's own
         copy of this workflow, not against what this tab happens to
         hold. */
      const saved = await useWorkflowsStore.getState().sync(definition);
      if (saved.conflict) {
        throw new Error("This workflow changed in another tab. Reload and try again.");
      }
      useEditorStore.getState().markSaved();
      const result = await publishProviderWebhook(workflowId);
      setEndpoint(result.webhook);
      setWarning(result.warning);
      setStatus("idle");
      setMessage({
        tone: result.warning ? "error" : "ok",
        text: result.warning
          ? "Endpoint saved — the provider registration needs attention below."
          : nodeType === "trigger.github"
            ? "Repository hook registered."
            : "Endpoint published.",
      });
    } catch (error) {
      setStatus("idle");
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Publishing failed.",
      });
    }
  };

  const unpublish = async () => {
    if (!workflowId || status === "saving") return;
    setStatus("saving");
    setMessage(null);
    setWarning(null);
    try {
      await deleteProviderWebhook(workflowId);
      setEndpoint(null);
      setStatus("idle");
      setMessage({ tone: "ok", text: "Endpoint unpublished." });
    } catch (error) {
      setStatus("idle");
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not unpublish.",
      });
    }
  };

  const copy = async (text: string, which: "url" | "secret") => {
    try {
      await navigator.clipboard.writeText(text);
      if (which === "url") {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      } else {
        setSecretCopied(true);
        setTimeout(() => setSecretCopied(false), 1600);
      }
    } catch {
      /* clipboard unavailable — the value stays selectable */
    }
  };

  if (!workflowId) return null;

  const manualHint =
    nodeType === "trigger.gmail"
      ? "Point a Cloud Pub/Sub subscription with push enabled at this URL. Notifications are verified with Google's OIDC keys before any run starts."
      : nodeType === "trigger.slack"
        ? "Subscribe this URL to message events in your Slack app (Event Subscriptions → Subscribe to bot events). Every delivery is checked against the app's signing secret before a run starts."
        : "KLYZ registers the repository hook for you. If GitHub refuses, add a webhook by hand with the content type application/json and the secret below.";

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="kz-eyebrow text-[9.5px]">Endpoint</h2>
        <span className="h-px flex-1 bg-hairline" />
      </div>

      <div className="rounded-lg border border-edge bg-raised p-3.5">
        {status === "loading" ? (
          <p className="flex items-center gap-2 text-[12px] text-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking this workflow&apos;s endpoint…
          </p>
        ) : endpoint ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-stretch gap-1.5">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-edge bg-panel px-2.5">
                <Globe className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span className="min-w-0 flex-1 truncate py-2 font-mono text-[11.5px] text-fg">
                  {endpoint.url}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void copy(endpoint.url, "url")}
                aria-label="Copy endpoint URL"
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors",
                  copied
                    ? "border-ok/50 bg-ok/10 text-ok"
                    : "border-line bg-inset text-subtle hover:border-strong hover:text-muted",
                )}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>

            <dl className="grid grid-cols-3 gap-2.5 text-center">
              <div className="rounded-md border border-edge bg-panel px-2 py-1.5">
                <dt className="kz-eyebrow text-[8.5px]">Provider</dt>
                <dd className="mt-0.5 text-[11.5px] capitalize text-fg">{endpoint.provider}</dd>
              </div>
              <div className="rounded-md border border-edge bg-panel px-2 py-1.5">
                <dt className="kz-eyebrow text-[8.5px]">Mode</dt>
                <dd className="mt-0.5 text-[11.5px] capitalize text-fg">
                  {endpoint.mode === "managed" ? "Registered" : "Manual"}
                </dd>
              </div>
              <div className="rounded-md border border-edge bg-panel px-2 py-1.5">
                <dt className="kz-eyebrow text-[8.5px]">Deliveries</dt>
                <dd className="kz-num mt-0.5 text-[11.5px] text-fg">{endpoint.deliveryCount}</dd>
              </div>
            </dl>

            <div className="flex flex-col gap-1.5 text-[11.5px]">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "kz-eyebrow flex items-center gap-1.5 text-[9px]",
                    endpoint.status === "error" ? "text-danger" : "text-ok",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      endpoint.status === "error" ? "bg-danger" : "bg-ok",
                    )}
                  />
                  {endpoint.status === "error" ? "Needs attention" : endpoint.status}
                </span>
                <span className="min-w-0 truncate text-subtle">
                  {endpoint.target}
                  {endpoint.events.length > 0 ? ` · ${endpoint.events.join(", ")}` : ""}
                </span>
              </div>
              <p className="text-subtle">
                {endpoint.lastDeliveryAt
                  ? `Last delivery ${new Date(endpoint.lastDeliveryAt).toLocaleString()}${
                      endpoint.lastDeliveryStatus ? ` · ${endpoint.lastDeliveryStatus}` : ""
                    }`
                  : "No deliveries yet"}
              </p>
            </div>

            {endpoint.secret && (
              <div className="rounded-md border border-warn/40 bg-warn/10 p-2.5">
                <p className="kz-eyebrow text-[9px] text-warn">Secret — shown once</p>
                <div className="mt-1.5 flex items-stretch gap-1.5">
                  <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-fg">
                    {endpoint.secret}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy(endpoint.secret ?? "", "secret")}
                    aria-label="Copy secret"
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors",
                      secretCopied
                        ? "border-ok/50 bg-ok/10 text-ok"
                        : "border-line bg-inset text-subtle hover:border-strong hover:text-muted",
                    )}
                  >
                    {secretCopied ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            )}

            {endpoint.lastError && (
              <p className="text-[11.5px] leading-snug text-danger">{endpoint.lastError}</p>
            )}

            {warning && (
              <div className="rounded-md border border-warn/40 bg-warn/10 p-2.5">
                <p className="text-[11.5px] leading-snug text-warn">{warning.message}</p>
                <p className="mt-1 text-[11.5px] leading-snug text-muted">{warning.hint}</p>
              </div>
            )}

            <p className="text-[11.5px] leading-snug text-subtle">{manualHint}</p>
          </div>
        ) : (
          <p className="text-[12px] leading-relaxed text-subtle">
            This workflow has no provider endpoint yet. Publish to receive{" "}
            {nodeType === "trigger.github"
              ? "repository events"
              : nodeType === "trigger.slack"
                ? "Slack messages"
                : "push notifications"} at{" "}
            <span className="font-mono text-[11.5px] text-muted">/api/providers/…</span>.
          </p>
        )}

        {message && (
          <p
            className={cn(
              "mt-3 text-[11.5px] leading-snug",
              message.tone === "ok" ? "text-ok" : "text-danger",
            )}
          >
            {message.text}
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Button
            variant={endpoint ? "secondary" : "primary"}
            onClick={() => void publish()}
            disabled={status === "saving"}
            className="flex-1"
          >
            {status === "saving" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            {endpoint ? "Republish endpoint" : "Publish endpoint"}
          </Button>
          {endpoint && (
            <Button
              variant="danger"
              onClick={() => void unpublish()}
              disabled={status === "saving"}
            >
              <Unplug className="h-3.5 w-3.5" />
              Unpublish
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
