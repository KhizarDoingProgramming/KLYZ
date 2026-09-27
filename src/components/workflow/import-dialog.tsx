"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { AlertTriangle, CheckCircle2, FileJson, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listCredentials, type CredentialSummary } from "@/lib/integrations/client";
import {
  WorkflowApiError,
  importWorkflow,
  previewImport,
  type ImportOutcome,
} from "@/lib/workflows/api";
import { MOTION } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { ValidationIssue } from "@/lib/workflow/types";

/**
 * Import dialog — the only place a portable document enters the app.
 *
 * It always previews first. A preview is a `dryRun` server call: the
 * document is parsed, validated and checked for credentials, and
 * nothing is written. The user sees the steps, the connections the
 * workflow will need and anything the exporter's warnings flagged
 * before a single row exists.
 */

export const IMPORT_EVENT = "klyz:import-workflow";

export function openImportDialog(): void {
  window.dispatchEvent(new CustomEvent(IMPORT_EVENT));
}

type Stage = "choose" | "preview";

export function ImportDialog() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [stage, setStage] = React.useState<Stage>("choose");
  const [raw, setRaw] = React.useState("");
  const [outcome, setOutcome] = React.useState<ImportOutcome | null>(null);
  const [choices, setChoices] = React.useState<Record<string, string>>({});
  const [credentials, setCredentials] = React.useState<CredentialSummary[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [issues, setIssues] = React.useState<ValidationIssue[]>([]);
  const [busy, setBusy] = React.useState(false);

  const reset = React.useCallback(() => {
    setStage("choose");
    setRaw("");
    setOutcome(null);
    setChoices({});
    setError(null);
    setIssues([]);
    setBusy(false);
  }, []);

  React.useEffect(() => {
    const onOpen = () => {
      reset();
      setOpen(true);
      void listCredentials()
        .then(setCredentials)
        .catch(() => setCredentials([]));
    };
    window.addEventListener(IMPORT_EVENT, onOpen);
    return () => window.removeEventListener(IMPORT_EVENT, onOpen);
  }, [reset]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const fail = React.useCallback((cause: unknown) => {
    if (cause instanceof WorkflowApiError) {
      setError(cause.message);
      setIssues(
        cause.issues.length > 0 ? cause.issues : [{ id: "import_failed", severity: "error", message: cause.message }],
      );
    } else {
      setError(cause instanceof Error ? cause.message : "That file could not be read.");
      setIssues([]);
    }
  }, []);

  const runPreview = React.useCallback(
    async (document: unknown) => {
      setBusy(true);
      setError(null);
      setIssues([]);
      try {
        const result = await previewImport(document);
        setOutcome(result);
        setChoices({});
        setStage("preview");
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
    },
    [fail],
  );

  const readFile = React.useCallback(
    async (file: File) => {
      if (file.size > 1024 * 1024) {
        setError("That file is larger than 1 MB — a portable workflow is at most 256 KB.");
        return;
      }
      const text = await file.text();
      setRaw(text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setError("That file is not valid JSON.");
        return;
      }
      await runPreview(parsed);
    },
    [runPreview],
  );

  const confirm = React.useCallback(async () => {
    if (!outcome) return;
    setBusy(true);
    setError(null);
    try {
      const credentialsByField: Record<string, string> = {};
      for (const [key, value] of Object.entries(choices)) {
        if (value) credentialsByField[key] = value;
      }
      const created = await importWorkflow({
        definition: JSON.parse(raw),
        credentials: credentialsByField,
      });
      setOpen(false);
      reset();
      if (created.workflow) router.push(`/workflows/${created.workflow.id}`);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }, [choices, fail, outcome, raw, reset, router]);

  const unresolved = (outcome?.requirements ?? []).filter((entry) => !entry.resolved);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-70 flex items-center justify-center px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={MOTION.micro}
          >
            <button
              type="button"
              aria-label="Cancel import"
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="kz-scrim absolute inset-0"
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="Import a workflow"
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.99 }}
              transition={MOTION.standard}
              className="relative flex max-h-[86vh] w-full max-w-[620px] flex-col overflow-hidden rounded-xl border border-line bg-overlay shadow-lg"
            >
              <header className="flex items-center justify-between border-b border-edge px-5 py-3.5">
                <div>
                  <h2 className="text-h3 text-fg">Import a workflow</h2>
                  <p className="mt-0.5 text-[12px] text-subtle">
                    A portable <code className="font-mono">klyz.workflow</code> file. It is
                    checked before anything is created.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
                >
                  <X className="h-4 w-4" />
                </button>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {stage === "choose" ? (
                  <div className="space-y-4">
                    <label
                      className={cn(
                        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-raised/40 px-4 py-9 text-center",
                        "transition-colors hover:border-signal/60 focus-within:border-signal/60",
                      )}
                    >
                      <Upload className="h-5 w-5 text-subtle" />
                      <span className="text-[13px] text-fg">Choose a .klyz.json file</span>
                      <span className="text-[12px] text-subtle">
                        or paste the document below
                      </span>
                      <input
                        type="file"
                        accept="application/json,.json"
                        className="sr-only"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void readFile(file);
                        }}
                      />
                    </label>

                    <label className="block">
                      <span className="kz-eyebrow mb-1.5 block">Paste a document</span>
                      <textarea
                        value={raw}
                        onChange={(event) => setRaw(event.target.value)}
                        rows={6}
                        spellCheck={false}
                        placeholder={`{\n  "format": "klyz.workflow",\n  "version": 1,\n  …\n}`}
                        className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-[12px] leading-relaxed text-fg outline-none transition-colors placeholder:text-subtle focus:border-signal/60 focus:ring-2 focus:ring-signal/20"
                      />
                    </label>

                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => setOpen(false)}>
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        disabled={busy || !raw.trim()}
                        onClick={() => {
                          let parsed: unknown;
                          try {
                            parsed = JSON.parse(raw);
                          } catch {
                            setError("That is not valid JSON.");
                            return;
                          }
                          void runPreview(parsed);
                        }}
                      >
                        <FileJson className="h-4 w-4" />
                        {busy ? "Checking…" : "Check document"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <section>
                      <h3 className="kz-eyebrow mb-2">What will be created</h3>
                      <div className="rounded-md border border-line bg-raised/40 px-3.5 py-3">
                        <p className="kz-display text-[14px] font-semibold text-fg">
                          {outcome?.summary.name}
                        </p>
                        {outcome?.summary.description ? (
                          <p className="mt-1 text-[12.5px] text-subtle">
                            {outcome.summary.description}
                          </p>
                        ) : null}
                        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-3">
                          <Fact label="Steps" value={String(outcome?.summary.nodeCount ?? 0)} />
                          <Fact label="Connections" value={String(outcome?.summary.edgeCount ?? 0)} />
                          <Fact label="Trigger" value={outcome?.summary.triggerType.replace("trigger.", "") ?? "—"} />
                        </dl>
                        {outcome && outcome.summary.integrations.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {outcome.summary.integrations.map((id) => (
                              <span
                                key={id}
                                className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-muted"
                              >
                                {id}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </section>

                    {error ? (
                      <section className="rounded-md border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
                        <p className="flex items-center gap-2 text-[13px] font-medium text-danger">
                          <AlertTriangle className="h-4 w-4 shrink-0" />
                          This document cannot be imported
                        </p>
                        <ul className="mt-2 space-y-1.5">
                          {issues.map((issue) => (
                            <li key={`${issue.id}-${issue.nodeId ?? ""}`} className="text-[12.5px] leading-snug text-danger/90">
                              <span className="font-medium">{issue.message}</span>
                              {issue.hint ? (
                                <span className="block text-subtle">{issue.hint}</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}

                    {outcome && !error ? (
                      <section>
                        <h3 className="kz-eyebrow mb-2">Connections it needs</h3>
                        {unresolved.length === 0 ? (
                          <p className="flex items-center gap-2 rounded-md border border-line bg-raised/40 px-3.5 py-2.5 text-[12.5px] text-muted">
                            <CheckCircle2 className="h-4 w-4 text-ok" />
                            Nothing outstanding — every connection was matched.
                          </p>
                        ) : (
                          <ul className="space-y-2">
                            {unresolved.map((requirement) => {
                              const matches = credentials.filter((credential) =>
                                requirement.providers.includes(credential.kind),
                              );
                              return (
                                <li
                                  key={requirement.key}
                                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-raised/40 px-3.5 py-2.5"
                                >
                                  <span className="min-w-0">
                                    <span className="block text-[13px] text-fg">
                                      {requirement.nodeLabel}
                                    </span>
                                    <span className="block text-[11.5px] text-subtle">
                                      {requirement.fieldLabel}
                                      {requirement.name ? ` · was “${requirement.name}”` : ""}
                                    </span>
                                  </span>
                                  <select
                                    aria-label={`Connection for ${requirement.nodeLabel}`}
                                    value={choices[requirement.key] ?? ""}
                                    onChange={(event) =>
                                      setChoices((current) => ({
                                        ...current,
                                        [requirement.key]: event.target.value,
                                      }))
                                    }
                                    className="h-7 max-w-[220px] rounded-md border border-line bg-surface px-2 text-[12.5px] text-fg outline-none focus:border-signal/60 focus:ring-2 focus:ring-signal/20"
                                  >
                                    <option value="">Leave for the editor</option>
                                    {matches.map((credential) => (
                                      <option key={credential.id} value={credential.id}>
                                        {credential.name}
                                      </option>
                                    ))}
                                    {matches.length === 0 ? (
                                      <option value="" disabled>
                                        No matching connection yet
                                      </option>
                                    ) : null}
                                  </select>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </section>
                    ) : null}

                    {outcome && outcome.warnings.length > 0 && !error ? (
                      <section>
                        <h3 className="kz-eyebrow mb-2">
                          Worth knowing ({outcome.warnings.length})
                        </h3>
                        <ul className="space-y-1.5">
                          {outcome.warnings.slice(0, 8).map((warning) => (
                            <li
                              key={`${warning.id}-${warning.nodeId ?? ""}`}
                              className="text-[12.5px] leading-snug text-muted"
                            >
                              {warning.message}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                  </div>
                )}
              </div>

              {stage === "preview" ? (
                <footer className="flex items-center justify-between gap-3 border-t border-edge px-5 py-3.5">
                  <Button variant="ghost" onClick={() => setStage("choose")} disabled={busy}>
                    Choose another file
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => void confirm()}
                      disabled={busy || !!error || !outcome}
                    >
                      {busy ? "Importing…" : "Import as draft"}
                    </Button>
                  </div>
                </footer>
              ) : null}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="kz-eyebrow">{label}</dt>
      <dd className="mt-0.5 text-fg">{value}</dd>
    </div>
  );
}
