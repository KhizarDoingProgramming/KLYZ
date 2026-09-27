"use client";

import * as React from "react";
import Link from "next/link";
import { KeyRound, Loader2, Plus } from "lucide-react";
import { Select } from "@/components/ui/field";
import {
  CREDENTIAL_KIND_LABEL,
  listCredentials,
  type CredentialSummary,
} from "@/lib/integrations/client";
import type { CredentialKind } from "@/lib/workflow/types";
import { cn } from "@/lib/utils";

/**
 * Real credential picker.
 *
 * Loads stored credentials for this workspace (ids/names/kinds only —
 * secrets never leave the server) and writes the chosen credential id
 * into the node config. "Manage" links to the integrations page.
 */
export function CredentialPicker({
  id,
  kinds,
  value,
  onChange,
  className,
  label = "Credential",
}: {
  id?: string;
  kinds: CredentialKind[];
  value: string;
  onChange: (credentialId: string) => void;
  className?: string;
  label?: string;
}) {
  const [items, setItems] = React.useState<CredentialSummary[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    listCredentials()
      .then((credentials) => {
        if (!cancelled) setItems(credentials);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loading = items === null && !failed;
  const options = (items ?? []).filter(
    (credential) => kinds.length === 0 || kinds.includes(credential.kind),
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-stretch gap-1.5">
        <div className="min-w-0 flex-1">
          <Select
            id={id}
            aria-label={label}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className={cn("min-w-0", className)}
            disabled={loading}
          >
            <option value="">
              {loading
                ? "Loading credentials…"
                : failed
                  ? "Could not load credentials"
                  : options.length === 0
                    ? "No credentials yet"
                    : "Select a credential…"}
            </option>
            {options.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.name} · {CREDENTIAL_KIND_LABEL[credential.kind]}
              </option>
            ))}
          </Select>
        </div>
        <Link
          href="/integrations#credentials"
          aria-label="Manage credentials"
          title="Manage credentials"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-inset text-subtle transition-colors hover:border-strong hover:bg-raised hover:text-muted"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : options.length === 0 ? (
            <Plus className="h-3.5 w-3.5" />
          ) : (
            <KeyRound className="h-3.5 w-3.5" />
          )}
        </Link>
      </div>
      {!loading && !failed && options.length === 0 && (
        <p className="text-[11px] leading-snug text-subtle">
          No {kinds.map((kind) => CREDENTIAL_KIND_LABEL[kind]).join(" / ")}{" "}
          credential stored yet — create one on the{" "}
          <Link href="/integrations#credentials" className="text-signal-text underline underline-offset-2">
            Integrations page
          </Link>
          .
        </p>
      )}
      {failed && (
        <p className="text-[11px] leading-snug text-warn">
          Credentials could not be loaded. Check the connection and retry.
        </p>
      )}
    </div>
  );
}
