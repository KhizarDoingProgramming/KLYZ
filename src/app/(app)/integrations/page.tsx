"use client";

import * as React from "react";
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Plug,
  Trash2,
  Unplug,
} from "lucide-react";
import { Glyph } from "@/components/icons";
import { Field, Input, Select } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import {
  CREATEABLE_CREDENTIAL_KINDS,
  CREDENTIAL_KIND_LABEL,
  createCredential,
  deleteCredential,
  disconnectProvider,
  listCredentials,
  listProviders,
  setProviderWatch,
  startProviderConnect,
  stopProviderWatch,
  testCredential,
  type CredentialSummary,
  type CredentialTestResult,
  type ProviderSummary,
} from "@/lib/integrations/client";
import {
  BUILT_IN_INTEGRATIONS,
  builtInNodeCount,
} from "@/lib/integrations/catalog";
import type { CredentialKind } from "@/lib/workflow/types";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Copy shown next to each provider                                    */
/* ------------------------------------------------------------------ */

const PROVIDER_BLURB: Record<string, { blurb: string; icon: string }> = {
  github: {
    icon: "github",
    blurb:
      "Start a workflow on issue, pull-request, push or release events, then create issues and comment back — all through one repository connection.",
  },
  gmail: {
    icon: "mail",
    blurb:
      "Start a workflow when mail arrives, then send, reply, label or read the message. Delivery runs through Gmail push notifications on your own Pub/Sub topic.",
  },
  google_sheets: {
    icon: "sheet",
    blurb:
      "Append, read and update spreadsheet rows from a workflow — with the sheet's own headers and the row number it wrote, not a blind cell range.",
  },
  notion: {
    icon: "notion",
    blurb:
      "Create, update and search pages in the databases the integration is shared with. Property types are read from the schema, so values are written correctly.",
  },
  slack: {
    icon: "slack",
    blurb:
      "Start a workflow when a message lands in a channel, then post messages, reply in threads and look channels up — verified against your app's signing secret.",
  },
};

type Notice = { tone: "ok" | "error"; text: string };

/* ------------------------------------------------------------------ */
/* OAuth round-trip banner                                             */
/* ------------------------------------------------------------------ */

const PROVIDER_LABEL: Record<string, string> = {
  github: "GitHub",
  gmail: "Gmail",
  google_sheets: "Google Sheets",
  notion: "Notion",
  slack: "Slack",
};

function noticeFromParams(params: URLSearchParams): Notice | null {
  const connected = params.get("connected");
  if (connected) {
    const label = PROVIDER_LABEL[connected] ?? connected;
    const account = params.get("account");
    return {
      tone: "ok",
      text: account ? `${label} connected as ${account}.` : `${label} connected.`,
    };
  }
  const error = params.get("error");
  if (error) {
    return {
      tone: "error",
      text: params.get("message") || `${error.replace(/_/g, " ").toLowerCase()}.`,
    };
  }
  return null;
}

/**
 * The OAuth callback answers with a 302 back to this page carrying
 * `?connected=…` or `?error=…`. The URL is stripped immediately so a
 * refresh cannot replay a message about a connection that has since been
 * removed; the parsed notice itself is handed over in a microtask,
 * outside the synchronous effect body.
 */
function useCallbackNotice(): Notice | null {
  const [notice, setNotice] = React.useState<Notice | null>(null);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const parsed = noticeFromParams(params);
    if (parsed && params.toString() !== "") {
      const clean = new URL(window.location.href);
      clean.search = "";
      window.history.replaceState({}, "", clean);
    }
    if (!parsed) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setNotice(parsed);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return notice;
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

function StatusPill({ provider }: { provider: ProviderSummary }) {
  const active =
    provider.connections.find((connection) => connection.status === "connected") ??
    provider.connections[0] ??
    null;

  if (!provider.configured) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-warn">
        <AlertTriangle className="h-3.5 w-3.5" />
        Not configured
      </span>
    );
  }
  if (!active) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-subtle">
        <span className="h-1.5 w-1.5 rounded-full bg-subtle/60" aria-hidden />
        Not connected
      </span>
    );
  }
  if (active.status !== "connected") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-danger">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-hidden />
        {active.status === "disconnected" ? "Disconnected" : active.status}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ok">
      <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
      Connected{active.account ? ` as ${active.account}` : ""}
    </span>
  );
}

function WatchRow({
  provider,
  onNotice,
  onChanged,
}: {
  provider: ProviderSummary;
  onNotice: (notice: Notice) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const watch = provider.watch;
  const connected = provider.connections.some((c) => c.status === "connected");
  const watching = watch?.status === "watching";

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = watching
        ? await stopProviderWatch(provider.id)
        : await setProviderWatch(provider.id);
      onChanged();
      onNotice({
        tone: result.watch?.status === "watching" ? "ok" : "error",
        text:
          result.watch?.status === "watching"
            ? `Watching ${result.topic ?? "the mailbox"} — push notifications are live.`
            : result.watch?.lastError ??
              (result.topic
                ? "Push subscription stopped. Runs now start only when you run them."
                : "No GOOGLE_PUBSUB_TOPIC is set, so there is nothing to subscribe to."),
      });
    } catch (error) {
      onNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not update the watch.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline pt-3">
      <span
        className={cn(
          "kz-eyebrow flex items-center gap-1.5 text-[9px]",
          watching ? "text-ok" : watch?.lastError ? "text-danger" : "text-subtle",
        )}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            watching ? "bg-ok" : watch?.lastError ? "bg-danger" : "bg-subtle/60",
          )}
          aria-hidden
        />
        {watching
          ? "Push live"
          : watch?.lastError
            ? "Push failed"
            : watch
              ? "No push subscription"
              : "Push not started"}
      </span>

      <span className="min-w-0 flex-1 text-[11.5px] text-subtle">
        {watching
          ? `${watch?.topic ?? "Subscription"}${
              watch?.expiresAt ? ` · renews before ${new Date(watch.expiresAt).toLocaleDateString()}` : ""
            }`
          : watch?.lastError
            ? watch.lastError
            : "Without a push subscription, a run starts when you trigger it by hand."}
      </span>

      <Button
        variant="quiet"
        size="sm"
        onClick={() => void toggle()}
        disabled={busy || (!connected && !watching)}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {watching ? "Stop" : "Start push"}
      </Button>
    </div>
  );
}

function ProviderRow({
  provider,
  onNotice,
  onChanged,
}: {
  provider: ProviderSummary;
  onNotice: (notice: Notice) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState<"connect" | "disconnect" | null>(null);
  const meta = PROVIDER_BLURB[provider.id] ?? { icon: provider.id, blurb: "" };
  const active =
    provider.connections.find((connection) => connection.status === "connected") ??
    provider.connections[0] ??
    null;
  const connected = active?.status === "connected";

  const connect = async () => {
    if (busy) return;
    setBusy("connect");
    try {
      const result = await startProviderConnect(provider.id);
      window.location.href = result.url;
      return;
    } catch (error) {
      onNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not start the handshake.",
      });
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!active || busy) return;
    const ok = window.confirm(
      `Disconnect ${active.account ?? active.name}? Workflows using it will fail until you reconnect.`,
    );
    if (!ok) return;
    setBusy("disconnect");
    try {
      await disconnectProvider(provider.id, active.id);
      onNotice({ tone: "ok", text: `${provider.label} disconnected.` });
      onChanged();
    } catch (error) {
      onNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not disconnect.",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="border-b border-hairline py-5">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border transition-colors",
            connected
              ? "border-signal/30 bg-signal-soft text-signal-text"
              : provider.configured
                ? "border-edge bg-raised text-muted"
                : "border-edge bg-inset text-subtle",
          )}
        >
          <Glyph name={meta.icon} className="h-4.5 w-4.5" />
        </span>

        <div className="min-w-0 flex-1 basis-[300px]">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="kz-display truncate text-[15px] font-semibold tracking-[-0.01em] text-fg">
              {provider.label}
            </h3>
            <StatusPill provider={provider} />
          </div>
          <p className="mt-1 max-w-[74ch] text-[12.5px] leading-relaxed text-subtle">
            {meta.blurb}
          </p>

          {!provider.configured && (
            <ul className="mt-2 flex flex-col gap-1">
              {provider.issues.map((issue) => (
                <li key={issue} className="font-mono text-[11px] text-warn">
                  {issue}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {provider.scopes.map((scope) => (
              <span
                key={scope.scope}
                title={scope.label}
                className={cn(
                  "rounded-sm border px-1.5 py-[1px] font-mono text-[9.5px]",
                  scope.granted
                    ? "border-ok/40 bg-ok/10 text-ok"
                    : "border-edge bg-inset text-subtle",
                )}
              >
                {scope.scope}
              </span>
            ))}
          </div>

          {provider.id === "gmail" && provider.configured && (
            <WatchRow provider={provider} onNotice={onNotice} onChanged={onChanged} />
          )}

          <details className="group mt-2.5">
            <summary className="kz-eyebrow cursor-pointer list-none text-[9px] text-subtle transition-colors hover:text-muted">
              Redirect URI
            </summary>
            <p className="mt-1 break-all font-mono text-[11px] text-muted">
              {provider.callbackUrl}
            </p>
          </details>
        </div>

        <div className="flex w-full items-center gap-2 sm:w-auto sm:min-w-[210px] sm:justify-end">
          {connected ? (
            <Button variant="danger" size="sm" onClick={() => void disconnect()} disabled={!!busy}>
              {busy === "disconnect" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Unplug className="h-3.5 w-3.5" />
              )}
              Disconnect
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void connect()}
              disabled={!provider.configured || busy === "connect"}
              title={provider.configured ? undefined : provider.issues.join(" ")}
            >
              {busy === "connect" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plug className="h-3.5 w-3.5" />
              )}
              {active ? `Reconnect ${provider.label}` : `Connect ${provider.label}`}
            </Button>
          )}
        </div>
      </div>

      {active?.lastError && (
        <p className="mt-2 max-w-[80ch] text-[11.5px] leading-snug text-warn">
          {active.lastError}
        </p>
      )}
    </li>
  );
}

function ProvidersSection({ notice }: { notice: Notice | null }) {
  const [items, setItems] = React.useState<ProviderSummary[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [local, setLocal] = React.useState<Notice | null>(null);

  const load = React.useCallback(() => {
    listProviders()
      .then((providers) => {
        setItems(providers);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const shown = local ?? notice;
  const connectedCount = (items ?? []).filter((provider) =>
    provider.connections.some((connection) => connection.status === "connected"),
  ).length;

  return (
    <section id="providers" className="scroll-mt-24">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-h2 text-fg">Providers</h2>
          <p className="mt-1 max-w-[62ch] text-sm leading-relaxed text-muted">
            OAuth accounts KLYZ can act as. Connecting hands us an access token
            that is encrypted, scoped to this workspace and redacted from every
            execution log.
          </p>
        </div>
        <p className="kz-eyebrow text-[9.5px]">
          {items
            ? `${connectedCount} of ${items.length} connected`
            : failed
              ? "unavailable"
              : "loading"}
        </p>
      </div>

      {shown && (
        <p
          role="status"
          className={cn(
            "mb-4 rounded-md border px-3 py-2 text-[12.5px] leading-snug",
            shown.tone === "ok"
              ? "border-ok/40 bg-ok/10 text-ok"
              : "border-danger/40 bg-danger-soft text-danger",
          )}
        >
          {shown.text}
        </p>
      )}

      {failed ? (
        <p className="py-6 text-center text-[12.5px] text-warn">
          Provider status could not be loaded. Check the connection and refresh.
        </p>
      ) : items === null ? (
        <p className="flex items-center justify-center gap-2 py-6 text-[12.5px] text-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading provider status…
        </p>
      ) : (
        <ul className="border-t border-hairline">
          {items.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              onNotice={setLocal}
              onChanged={load}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Built-ins                                                           */
/* ------------------------------------------------------------------ */

function BuiltInsSection() {
  return (
    <section className="mt-10 border-t border-line pt-8">
      <div className="mb-5">
        <h2 className="text-h2 text-fg">Built in</h2>
        <p className="mt-1 max-w-[62ch] text-sm leading-relaxed text-muted">
          Node families that need no account at all. They run inside the worker
          or against a credential you store yourself.
        </p>
      </div>

      <ul className="border-t border-hairline">
        {BUILT_IN_INTEGRATIONS.map((entry) => {
          const count = builtInNodeCount(entry);
          return (
            <li
              key={entry.id}
              className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-hairline py-4"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-edge bg-raised text-muted">
                <Glyph name={entry.icon} className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1 basis-[300px]">
                <h3 className="kz-display text-[15px] font-semibold tracking-[-0.01em] text-fg">
                  {entry.name}
                </h3>
                <p className="mt-1 max-w-[74ch] text-[12.5px] leading-relaxed text-subtle">
                  {entry.blurb}
                </p>
              </div>
              <p className="kz-eyebrow shrink-0 text-[9.5px]">
                {count} {count === 1 ? "step" : "steps"}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Stored credentials                                                  */
/* ------------------------------------------------------------------ */

interface FieldSpec {
  key: string;
  label: string;
  type?: "password" | "number" | "url";
  placeholder?: string;
  help?: string;
}

/** Which fields each supported credential kind collects. */
const CREDENTIAL_FIELDS: Record<string, FieldSpec[]> = {
  postgres: [
    {
      key: "connectionString",
      label: "Connection string",
      type: "url",
      placeholder: "postgresql://user:pass@host:5432/db",
      help: "Overrides the individual fields below when set.",
    },
    { key: "host", label: "Host", placeholder: "db.example.com" },
    { key: "port", label: "Port", type: "number", placeholder: "5432" },
    { key: "database", label: "Database", placeholder: "klyz" },
    { key: "user", label: "User", placeholder: "klyz" },
    { key: "password", label: "Password", type: "password" },
    { key: "ssl", label: "SSL (true / false)", placeholder: "false" },
  ],
  http_basic: [
    { key: "username", label: "Username" },
    { key: "password", label: "Password", type: "password" },
    {
      key: "url",
      label: "Test URL",
      type: "url",
      placeholder: "https://api.example.com/health",
      help: "Optional — used only by “Test connection”.",
    },
  ],
  http_bearer: [
    { key: "token", label: "Token", type: "password" },
    {
      key: "url",
      label: "Test URL",
      type: "url",
      placeholder: "https://api.example.com/health",
      help: "Optional — used only by “Test connection”.",
    },
  ],
  http_header: [
    { key: "headerName", label: "Header name", placeholder: "X-Api-Key" },
    { key: "value", label: "Header value", type: "password" },
    {
      key: "url",
      label: "Test URL",
      type: "url",
      placeholder: "https://api.example.com/health",
      help: "Optional — used only by “Test connection”.",
    },
  ],
};

const KIND_ICON: Record<string, string> = {
  postgres: "database",
  http_basic: "globe",
  http_bearer: "globe",
  http_header: "globe",
};

function CredentialsSection() {
  const [items, setItems] = React.useState<CredentialSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<CredentialKind>("postgres");
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, CredentialTestResult>>({});

  const load = React.useCallback(() => {
    listCredentials()
      .then((credentials) => setItems(credentials))
      .catch(() => setLoadFailed(true));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const specs = CREDENTIAL_FIELDS[kind] ?? [];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setFormError(null);
    const fields: Record<string, string> = {};
    for (const spec of specs) {
      const value = (values[spec.key] ?? "").trim();
      if (value !== "") fields[spec.key] = value;
    }
    if (Object.keys(fields).length === 0) {
      setFormError("Fill in at least one field.");
      return;
    }
    setSaving(true);
    try {
      const credential = await createCredential({ name: name.trim(), kind, fields });
      setItems((current) => [...(current ?? []), credential].sort((a, b) =>
        a.name.localeCompare(b.name),
      ));
      setName("");
      setValues({});
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save the credential.");
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (id: string) => {
    setTesting(id);
    try {
      const result = await testCredential(id);
      setResults((current) => ({ ...current, [id]: result }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [id]: {
          ok: false,
          latencyMs: 0,
          detail: error instanceof Error ? error.message : "Test failed.",
        },
      }));
    } finally {
      setTesting(null);
    }
  };

  const remove = async (credential: CredentialSummary) => {
    const ok = window.confirm(`Delete the credential “${credential.name}”?`);
    if (!ok) return;
    try {
      await deleteCredential(credential.id);
      setItems((current) => (current ?? []).filter((item) => item.id !== credential.id));
    } catch {
      /* keep the list as-is; the next load reflects reality */
    }
  };

  return (
    <section id="credentials" className="mt-10 scroll-mt-24 border-t border-line pt-8">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-h2 text-fg">Stored credentials</h2>
          <p className="mt-1 max-w-[62ch] text-sm leading-relaxed text-muted">
            Encrypted at rest, scoped to this workspace, and never returned to the
            browser — nodes receive them only at run time. Use them from the HTTP
            request and PostgreSQL steps. OAuth connections are created above,
            not here.
          </p>
        </div>
        <p className="kz-eyebrow text-[9.5px]">
          {items ? `${items.length} stored` : loadFailed ? "unavailable" : "loading"}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-0">
        {/* list ---------------------------------------------------- */}
        <div className="lg:pr-9">
          <h3 className="kz-eyebrow mb-3">Credentials</h3>
          {loadFailed ? (
            <p className="py-4 text-center text-[12.5px] text-warn">
              Credentials could not be loaded. Check the connection and refresh.
            </p>
          ) : items === null ? (
            <p className="flex items-center justify-center gap-2 py-4 text-[12.5px] text-subtle">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </p>
          ) : items.length === 0 ? (
            <p className="py-5 text-[12.5px] leading-relaxed text-subtle">
              No credentials yet. Add one on the right — it will appear in the
              “Stored credential” field of matching steps.
            </p>
          ) : (
            <ul className="flex flex-col border-t border-hairline">
              {items.map((credential) => {
                const result = results[credential.id];
                return (
                  <li
                    key={credential.id}
                    className="flex flex-col gap-2 border-b border-hairline py-3"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-edge bg-raised text-muted">
                        <Glyph name={KIND_ICON[credential.kind] ?? "globe"} className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="kz-display truncate text-[13.5px] font-semibold tracking-[-0.01em] text-fg">
                          {credential.name}
                        </p>
                        <p className="kz-eyebrow mt-0.5 text-[9px]">
                          {CREDENTIAL_KIND_LABEL[credential.kind]}
                        </p>
                      </div>
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() => void runTest(credential.id)}
                        disabled={testing === credential.id}
                      >
                        {testing === credential.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          "Test"
                        )}
                      </Button>
                      <button
                        type="button"
                        aria-label={`Delete ${credential.name}`}
                        onClick={() => void remove(credential)}
                        className="flex h-7 w-7 items-center justify-center rounded-sm border border-edge text-subtle transition-colors hover:border-danger/50 hover:bg-danger-soft hover:text-danger"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {result && (
                      <p
                        className={cn(
                          "border-t border-hairline pt-2 text-[11.5px] leading-snug",
                          result.ok ? "text-ok" : "text-danger",
                        )}
                      >
                        {result.ok ? "Connected" : "Failed"}
                        {result.latencyMs > 0 && (
                          <span className="kz-num text-subtle"> · {result.latencyMs} ms</span>
                        )}
                        {" — "}
                        {result.detail}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* create -------------------------------------------------- */}
        <form
          onSubmit={(event) => void submit(event)}
          className="lg:border-l lg:border-line lg:pl-9"
        >
          <h3 className="kz-eyebrow mb-3">Add a credential</h3>
          <div className="flex flex-col gap-3.5">
            <Field label="Name" htmlFor="cred-name" required>
              <Input
                id="cred-name"
                value={name}
                placeholder="Production database"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Type" htmlFor="cred-kind">
              <Select
                id="cred-kind"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as CredentialKind);
                  setValues({});
                }}
              >
                {CREATEABLE_CREDENTIAL_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {CREDENTIAL_KIND_LABEL[option]}
                  </option>
                ))}
              </Select>
            </Field>

            {specs.map((spec) => (
              <Field
                key={spec.key}
                label={spec.label}
                htmlFor={`cred_${spec.key}`}
                help={spec.help}
              >
                <Input
                  id={`cred_${spec.key}`}
                  type={
                    spec.type === "password"
                      ? "password"
                      : spec.type === "number"
                        ? "number"
                        : spec.type === "url"
                          ? "url"
                          : "text"
                  }
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={spec.placeholder}
                  value={values[spec.key] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [spec.key]: event.target.value }))
                  }
                />
              </Field>
            ))}

            {formError && (
              <p className="text-[11.5px] leading-snug text-danger" role="alert">
                {formError}
              </p>
            )}

            <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <KeyRound className="h-3.5 w-3.5" />
              )}
              Save credential
            </Button>
            <p className="text-[11px] leading-snug text-subtle">
              Values are encrypted with AES-256-GCM before storage. In production set{" "}
              <code className="font-mono text-[10.5px] text-muted">KLYZ_CREDENTIAL_KEY</code>.
            </p>
          </div>
        </form>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function IntegrationsPage() {
  const notice = useCallbackNotice();

  return (
    <div className="h-full overflow-y-auto">
      <div className="kz-frame py-8 lg:py-12">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="kz-eyebrow mb-2.5">Connectors</p>
            <h1 className="text-page text-fg">Integrations</h1>
            <p className="mt-1.5 max-w-[58ch] text-sm leading-relaxed text-muted">
              Everything KLYZ can talk to. Provider connections are OAuth-handshaked
              and encrypted; built-in steps never leave the worker.
            </p>
          </div>
        </header>

        <div className="mt-8">
          <ProvidersSection notice={notice} />
        </div>

        <BuiltInsSection />
        <CredentialsSection />
      </div>
    </div>
  );
}
