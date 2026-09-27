"use client";

import * as React from "react";
import { Check, Copy, Globe, Loader2, Send, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { snapshotWorkflow, useEditorStore } from "@/stores/editor";
import { useWorkflowsStore } from "@/stores/workflows";
import { validateWorkflow } from "@/lib/workflow/validation";
import {
  deleteWorkflowWebhook,
  getWorkflowWebhook,
  publishWorkflowWebhook,
  type WebhookEndpointView,
} from "@/lib/integrations/client";
import { cn } from "@/lib/utils";

/**
 * Endpoint card for the webhook trigger.
 *
 * The graph comes from the server's draft; this card only publishes the
 * endpoint settings (path, method, auth, secret). Saving happens first
 * so the endpoint and the workflow always describe the same thing.
 */
export function WebhookEndpointCard({
  workflowId,
  config,
}: {
  workflowId: string | null;
  config: Record<string, unknown>;
}) {
  const [endpoint, setEndpoint] = React.useState<WebhookEndpointView | null>(null);
  const [status, setStatus] = React.useState<"loading" | "idle" | "saving">("loading");
  const [message, setMessage] = React.useState<{ tone: "ok" | "error"; text: string } | null>(
    null,
  );
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    getWorkflowWebhook(workflowId)
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
    try {
      /* The endpoint runs the server's copy of this graph, so save the
         draft first — then publish the endpoint, never a definition. */
      const saved = await useWorkflowsStore.getState().sync(definition);
      if (saved.conflict) {
        throw new Error("This workflow changed in another tab. Reload and try again.");
      }
      useEditorStore.getState().markSaved();
      const webhook = await publishWorkflowWebhook(workflowId, {
        path: typeof config.path === "string" ? config.path : "",
        method: typeof config.method === "string" ? config.method : "POST",
        auth: typeof config.auth === "string" ? config.auth : "none",
        secret: typeof config.secret === "string" ? config.secret : "",
        enabled: true,
      });
      setEndpoint(webhook);
      setStatus("idle");
      setMessage({ tone: "ok", text: "Endpoint published." });
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
    try {
      await deleteWorkflowWebhook(workflowId);
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

  const copyUrl = async () => {
    if (!endpoint) return;
    try {
      await navigator.clipboard.writeText(endpoint.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable (permissions) — the URL stays selectable */
    }
  };

  if (!workflowId) return null;

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
                onClick={copyUrl}
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
                <dt className="kz-eyebrow text-[8.5px]">Method</dt>
                <dd className="kz-num mt-0.5 text-[11.5px] text-fg">{endpoint.method}</dd>
              </div>
              <div className="rounded-md border border-edge bg-panel px-2 py-1.5">
                <dt className="kz-eyebrow text-[8.5px]">Auth</dt>
                <dd className="mt-0.5 text-[11.5px] capitalize text-fg">
                  {endpoint.auth === "none"
                    ? "None"
                    : endpoint.auth === "header"
                      ? "Secret header"
                      : "HMAC"}
                </dd>
              </div>
              <div className="rounded-md border border-edge bg-panel px-2 py-1.5">
                <dt className="kz-eyebrow text-[8.5px]">Deliveries</dt>
                <dd className="kz-num mt-0.5 text-[11.5px] text-fg">{endpoint.deliveryCount}</dd>
              </div>
            </dl>

            <div className="flex items-center gap-2 text-[11.5px]">
              <span
                className={cn(
                  "kz-eyebrow flex items-center gap-1.5 text-[9px]",
                  endpoint.enabled ? "text-ok" : "text-warn",
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    endpoint.enabled ? "bg-ok" : "bg-warn",
                  )}
                />
                {endpoint.enabled ? "Accepting requests" : "Disabled"}
              </span>
              <span className="text-subtle">
                {endpoint.lastDeliveryAt
                  ? `Last delivery ${new Date(endpoint.lastDeliveryAt).toLocaleString()}${
                      endpoint.lastDeliveryStatus ? ` · ${endpoint.lastDeliveryStatus}` : ""
                    }`
                  : "No deliveries yet"}
              </span>
            </div>

            {endpoint.sample && (
              <details className="group">
                <summary className="kz-eyebrow cursor-pointer list-none text-[9px] text-subtle transition-colors hover:text-muted">
                  Last payload sample
                </summary>
                <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-edge bg-panel p-2 font-mono text-[10.5px] leading-relaxed text-muted">
                  {endpoint.sample}
                </pre>
              </details>
            )}
          </div>
        ) : (
          <p className="text-[12px] leading-relaxed text-subtle">
            This workflow has no public endpoint yet. Publish to receive requests at{" "}
            <span className="font-mono text-[11.5px] text-muted">/api/webhooks/…</span>.
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
            onClick={publish}
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
            <Button variant="danger" onClick={unpublish} disabled={status === "saving"}>
              <Unplug className="h-3.5 w-3.5" />
              Unpublish
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
