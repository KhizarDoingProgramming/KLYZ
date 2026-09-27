"use client";

import * as React from "react";
import {
  Field,
  Input,
  KeyValueEditor,
  Select,
  Switch,
  Textarea,
  type KeyValueEntry,
} from "@/components/ui/field";
import { DataPicker, ExpressionPreview } from "./data-picker";
import { CredentialPicker } from "./credential-picker";
import { useEditorStore } from "@/stores/editor";
import { isSecretField } from "@/lib/execution/io";
import { isVisible } from "@/lib/workflow/show-when";
import type { NodeDefinition } from "@/lib/workflow/types";
import { cn } from "@/lib/utils";

function toEntries(value: unknown): KeyValueEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const record = entry as { key?: unknown; value?: unknown };
    return {
      id: `kv_${index}_${String(record.key ?? "")}`,
      key: String(record.key ?? ""),
      value: String(record.value ?? ""),
    };
  });
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function ConfigPanel({
  nodeId,
  definition,
  config,
  issues,
}: {
  nodeId: string;
  definition: NodeDefinition;
  config: Record<string, unknown>;
  issues: string[];
}) {
  const updateConfig = useEditorStore((state) => state.updateConfig);

  const visible = definition.fields.filter((field) => isVisible(field, config));

  return (
    <div className="flex flex-col gap-4">
      {visible.map((field) => {
        const value = config[field.key];
        const id = `${nodeId}:${field.key}`;
        const missing = field.required && isEmpty(value);
        const issue =
          (missing ? `${field.label} is required.` : undefined) ??
          issues.find((item) =>
            item.toLowerCase().includes(field.label.toLowerCase()),
          );
        const secret = isSecretField(field.key);

        const setValue = (next: unknown) => updateConfig(nodeId, field.key, next);

        const label = (
          <span className="flex items-center gap-2">
            {field.label}
            {field.bindable && (
              <span className="kz-eyebrow rounded border border-edge px-1 py-[1px] text-[8.5px]">
                Reference
              </span>
            )}
          </span>
        );

        let control: React.ReactNode = null;

        switch (field.kind) {
          case "textarea":
          case "code":
            control = (
              <div className="flex items-start gap-1.5">
                <Textarea
                  id={id}
                  mono={field.kind === "code"}
                  rows={field.rows ?? (field.kind === "code" ? 6 : 4)}
                  value={typeof value === "string" ? value : ""}
                  placeholder={field.placeholder}
                  spellCheck={field.kind !== "code"}
                  onChange={(event) => setValue(event.target.value)}
                  className={cn("min-w-0 flex-1", issue && "border-danger/70")}
                />
                {field.bindable && (
                  <DataPicker
                    excludeNodeId={nodeId}
                    onSelect={(expression) => {
                      const current = typeof value === "string" ? value : "";
                      const separator = current && !current.endsWith("\n") ? "\n" : "";
                      setValue(`${current}${separator}${expression}`);
                    }}
                    label={`Insert a reference into ${field.label}`}
                  />
                )}
              </div>
            );
            break;

          case "credential":
            control = (
              <CredentialPicker
                id={id}
                kinds={definition.credentials ?? []}
                value={typeof value === "string" ? value : ""}
                onChange={setValue}
                className={cn(issue && "border-danger/70")}
                label={field.label}
              />
            );
            break;

          case "number":
            control = (
              <Input
                id={id}
                type="number"
                value={value === undefined || value === null ? "" : String(value)}
                placeholder={field.placeholder}
                onChange={(event) =>
                  setValue(
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value),
                  )
                }
                className={cn(issue && "border-danger/70")}
              />
            );
            break;

          case "select":
            control = (
              <Select
                id={id}
                value={value === undefined ? "" : String(value)}
                onChange={(event) => setValue(event.target.value)}
                className={cn(issue && "border-danger/70")}
              >
                <option value="" disabled>
                  {field.placeholder ?? "Choose…"}
                </option>
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            );
            break;

          case "toggle":
            control = (
              <div className="flex h-8 items-center">
                <Switch
                  checked={Boolean(value)}
                  onCheckedChange={setValue}
                  label={field.label}
                />
                <span className="ml-2.5 text-[12px] text-subtle">
                  {value ? "On" : "Off"}
                </span>
              </div>
            );
            break;

          case "keyvalue":
            control = (
              <KeyValueEditor
                entries={toEntries(value)}
                onChange={(entries) =>
                  setValue(
                    entries
                      .filter((entry) => entry.key.trim() !== "")
                      .map((entry) => ({ key: entry.key, value: entry.value })),
                  )
                }
              />
            );
            break;

          case "expression":
          case "text":
          default:
            control = (
              <div className="flex items-stretch gap-1.5">
                <Input
                  id={id}
                  mono={field.mono || field.kind === "expression"}
                  type={secret ? "password" : "text"}
                  autoComplete="off"
                  value={typeof value === "string" ? value : ""}
                  placeholder={field.placeholder}
                  onChange={(event) => setValue(event.target.value)}
                  className={cn("min-w-0 flex-1", issue && "border-danger/70")}
                />
                {field.bindable && (
                  <DataPicker
                    excludeNodeId={nodeId}
                    onSelect={(expression) => {
                      const current = typeof value === "string" ? value : "";
                      const separator = current && !current.endsWith(" ") ? " " : "";
                      setValue(`${current}${separator}${expression}`);
                    }}
                    label={`Insert a reference into ${field.label}`}
                  />
                )}
              </div>
            );
            break;
        }

        return (
          <Field
            key={field.key}
            label={label}
            htmlFor={id}
            required={field.required}
            error={issue}
            help={issue ? undefined : field.help}
          >
            {control}
            {field.kind === "expression" && typeof value === "string" && (
              <ExpressionPreview value={value} />
            )}
          </Field>
        );
      })}
    </div>
  );
}
