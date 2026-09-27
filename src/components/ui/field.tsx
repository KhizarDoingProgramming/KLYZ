"use client";

import * as React from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { KeyValueEntry } from "@/lib/workflow/types";

export type { KeyValueEntry };

/* ----------------------------------------------------------------- */
/* Field wrapper                                                      */
/* ----------------------------------------------------------------- */

export function Field({
  label,
  htmlFor,
  required,
  help,
  hint,
  error,
  className,
  children,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  required?: boolean;
  help?: string;
  hint?: React.ReactNode;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="text-[12px] font-medium leading-none text-muted"
          >
            {label}
            {required && (
              <span aria-hidden className="ml-1 text-signal-text">
                *
              </span>
            )}
          </label>
        ) : (
          /* No control to associate (e.g. a segmented group with its own
             aria-label) — a bare <label> would be an orphan. */
          <span className="text-[12px] font-medium leading-none text-muted">
            {label}
            {required && (
              <span aria-hidden className="ml-1 text-signal-text">
                *
              </span>
            )}
          </span>
        )}
        {hint}
      </div>
      {children}
      {error ? (
        <p className="text-[11px] leading-snug text-danger" role="alert">
          {error}
        </p>
      ) : help ? (
        <p className="text-[11px] leading-snug text-subtle">{help}</p>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Text inputs                                                        */
/* ----------------------------------------------------------------- */

const CONTROL =
  "w-full rounded-md border border-line bg-inset px-2.5 text-[13px] text-fg placeholder:text-subtle transition-colors duration-micro focus:border-signal/60 focus:outline-none focus:ring-2 focus:ring-signal/20 disabled:opacity-50";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }
>(function Input({ className, mono, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(CONTROL, "h-8", mono && "font-mono text-[12px]", className)}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }
>(function Textarea({ className, mono, rows = 4, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        CONTROL,
        "resize-y py-2 leading-relaxed",
        mono && "font-mono text-[12px]",
        className,
      )}
      {...props}
    />
  );
});

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        className={cn(
          CONTROL,
          "h-8 appearance-none pr-8 [&>option]:bg-panel",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle"
      />
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Switch                                                             */
/* ----------------------------------------------------------------- */

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors duration-micro",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
        checked ? "border-signal/50 bg-signal" : "border-line bg-inset",
        disabled && "opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-3 w-3 rounded-full transition-transform duration-micro ease-out",
          checked
            ? "translate-x-[17px] bg-on-signal"
            : "translate-x-[3px] bg-subtle",
        )}
      />
    </button>
  );
}

/* ----------------------------------------------------------------- */
/* Segmented control (compact selects: methods, modes)                */
/* ----------------------------------------------------------------- */

export function Segmented({
  value,
  options,
  onChange,
  ariaLabel,
  stretch = true,
  className,
}: {
  value: string;
  options: { value: string; label: string; meta?: React.ReactNode }[];
  onChange: (next: string) => void;
  ariaLabel: string;
  /** Fill the container (default) or hug the option labels. */
  stretch?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex flex-wrap rounded-md border border-line bg-inset p-0.5",
        stretch && "w-full",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-sm px-2.5 py-1 text-[12px] font-medium transition-colors duration-micro",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal",
              stretch && "flex-1",
              active
                ? "bg-raised text-fg shadow-sm"
                : "text-subtle hover:text-muted",
            )}
          >
            {option.label}
            {option.meta}
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Key / value editor                                                 */
/* ----------------------------------------------------------------- */


export function KeyValueEditor({
  entries,
  onChange,
  keyPlaceholder = "key",
  valuePlaceholder = "value",
  addLabel = "Add field",
}: {
  entries: KeyValueEntry[];
  onChange: (next: KeyValueEntry[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
}) {
  const update = (id: string, patch: Partial<KeyValueEntry>) =>
    onChange(entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

  return (
    <div className="flex flex-col gap-1.5">
      {entries.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_24px] gap-1.5 px-0.5 text-[10px] uppercase tracking-[0.1em] text-subtle">
          <span>Key</span>
          <span>Value</span>
          <span />
        </div>
      )}
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_24px] items-center gap-1.5"
        >
          <Input
            value={entry.key}
            placeholder={keyPlaceholder}
            mono
            aria-label="Key"
            onChange={(event) => update(entry.id, { key: event.target.value })}
          />
          <Input
            value={entry.value}
            placeholder={valuePlaceholder}
            aria-label="Value"
            onChange={(event) => update(entry.id, { value: event.target.value })}
          />
          <button
            type="button"
            aria-label="Remove field"
            onClick={() => onChange(entries.filter((item) => item.id !== entry.id))}
            className="flex h-7 w-6 items-center justify-center rounded-sm text-subtle transition-colors hover:bg-danger-soft hover:text-danger"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange([
            ...entries,
            { id: `kv_${Date.now().toString(36)}${entries.length}`, key: "", value: "" },
          ])
        }
        className="inline-flex w-fit items-center gap-1.5 rounded-sm px-1.5 py-1 text-[12px] text-subtle transition-colors hover:text-signal-text"
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </button>
    </div>
  );
}
