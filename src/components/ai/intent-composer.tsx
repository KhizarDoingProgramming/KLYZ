"use client";

import * as React from "react";
import { CornerDownLeft, Square } from "lucide-react";
import { Textarea } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The intent composer: where the automation gets described in plain
 * language. One field, Cmd/Ctrl+Enter to submit, honest state (working
 * shows elapsed seconds, not a fabricated percentage), and a real Stop
 * that aborts the in-flight request.
 */

export const INTENT_EXAMPLES = [
  "When a webhook fires, enrich the company with Clearbit and post the summary to #sales",
  "Every weekday at 9am, pull yesterday's Stripe charges over $500 into a Google Sheet",
  "When a Linear issue is created, triage it with AI and open a matching GitHub issue",
] as const;

export function IntentComposer({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  disabled,
  error,
  elapsedMs,
  helper,
  examples = INTENT_EXAMPLES,
  maxLength = 4_000,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
  /** Milliseconds since the request started — real elapsed time. */
  elapsedMs?: number;
  helper?: React.ReactNode;
  examples?: readonly string[];
  maxLength?: number;
}) {
  const over = value.length > maxLength;

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "border bg-surface transition-colors",
          over ? "border-danger" : error ? "border-warn" : "border-line focus-within:border-strong",
        )}
      >
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !busy) {
              event.preventDefault();
              onSubmit();
            }
          }}
          rows={3}
          aria-label="Describe the automation"
          placeholder="Describe the automation you want, step by step, in plain language…"
          className="min-h-[76px] resize-y border-0 bg-transparent text-[13.5px] leading-relaxed shadow-none focus-visible:ring-0 focus-visible:border-0"
        />
        <div className="flex items-center gap-3 border-t border-edge px-3 py-2">
          <span className="kz-eyebrow text-[9.5px] text-muted">
            {value.length} / {maxLength}
          </span>
          <span className="hidden text-[11px] text-muted sm:block">{helper}</span>
          <span className="ml-auto flex items-center gap-2">
            {busy ? (
              <>
                <span className="kz-eyebrow text-[9.5px] text-subtle">
                  building · {((elapsedMs ?? 0) / 1000).toFixed(1)}s
                </span>
                {onCancel && (
                  <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                    <Square className="h-3 w-3" />
                    Stop
                  </Button>
                )}
              </>
            ) : (
              <Button type="button" size="sm" onClick={onSubmit} disabled={disabled || over}>
                <CornerDownLeft className="h-3.5 w-3.5" />
                Build plan
              </Button>
            )}
          </span>
        </div>
      </div>

      {error && (
        <p className="text-[12px] leading-relaxed text-danger" role="alert">
          {error}
        </p>
      )}

      {examples.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="kz-eyebrow text-[9.5px] text-muted">Try</span>
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onChange(example)}
              disabled={busy}
              className="group flex items-start gap-2 py-0.5 text-left text-[12px] leading-relaxed text-subtle transition-colors hover:text-fg disabled:opacity-50"
            >
              <span className="font-mono text-[11px] text-muted transition-colors group-hover:text-fg">
                →
              </span>
              <span>{example}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
