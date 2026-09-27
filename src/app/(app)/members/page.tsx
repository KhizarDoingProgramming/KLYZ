"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Trash2, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { TimeAgo } from "@/components/format/time";
import { useSession } from "@/components/account/session-context";

interface Member {
  userId: string;
  email: string;
  name: string;
  role: string;
  system: boolean;
  createdAt: string;
}

const ROLES = [
  { value: "viewer", label: "Viewer — can read runs" },
  { value: "member", label: "Member — can build and run" },
  { value: "admin", label: "Admin — members, webhooks, keys" },
  { value: "owner", label: "Owner — full control" },
];

/**
 * Workspace members.
 *
 * Reads are open to every member (knowing who is here is not a
 * secret); every mutation is an API call that re-checks the role on
 * the server — including the rule that nobody can be granted a role
 * above their own, and that the last owner cannot be removed.
 */
export default function MembersPage() {
  const router = useRouter();
  const { session, refresh } = useSession();
  const [members, setMembers] = React.useState<Member[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState("member");
  const [busy, setBusy] = React.useState(false);

  const canManage =
    session?.role === "owner" || session?.role === "admin";
  const selfId = session?.user.id;

  const load = React.useCallback(() => {
    fetch("/api/workspaces/members", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ members?: Member[]; error?: { message?: string } }>)
      .then((payload) => {
        setMembers(payload.members ?? []);
        if (!payload.members) {
          setError(payload.error?.message ?? "Members could not be loaded.");
        }
      })
      .catch(() => setError("Members could not be loaded."));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const act = (run: () => Promise<Response>): Promise<void> => {
    setBusy(true);
    setError(null);
    return run()
      .then((response) =>
        response
          .json()
          .catch(() => null)
          .then((payload: { error?: { message?: string } } | null) => {
            if (!response.ok) {
              setError(payload?.error?.message ?? "That change was refused.");
            }
          }),
      )
      .then(() => {
        load();
        refresh();
        router.refresh();
      })
      .catch(() => setError("The server could not be reached."))
      .finally(() => setBusy(false));
  };

  const invite = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!email.trim()) return;
    void act(() =>
      fetch("/api/workspaces/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      }),
    ).then(() => setEmail(""));
  };

  return (
    <div className="kz-frame overflow-y-auto py-8 lg:py-12">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-edge pb-6">
        <div>
          <p className="kz-eyebrow mb-3">Workspace</p>
          <h1 className="kz-display text-display-sm font-semibold tracking-[-0.02em] text-fg">
            Members
          </h1>
          <p className="mt-2 max-w-[60ch] text-[13.5px] leading-relaxed text-muted">
            Roles decide what an account can do inside this workspace. The server
            enforces every change — a role can never exceed the role of the
            person granting it.
          </p>
        </div>
        <span className="kz-num text-[11px] text-subtle">
          {members ? `${members.length} accounts` : "…"}
        </span>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-5 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-[12.5px] text-danger"
        >
          {error}
        </p>
      )}

      <Panel
        className="mt-6"
        title="People"
        description="Anyone with a membership in this workspace."
        flush
      >
        {members === null ? (
          <div className="flex items-center justify-center gap-2 px-6 py-12 text-[13px] text-subtle">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading members
          </div>
        ) : members.length === 0 ? (
          <EmptyState
            title="No members yet"
            description="Add an existing account by email to give it a role here."
          />
        ) : (
          <ul>
            {members.map((member) => {
              const isSelf = member.userId === selfId;
              return (
                <li
                  key={member.userId}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-hairline px-4 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_190px_auto]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="kz-display truncate text-[14px] font-medium text-fg">
                        {member.name}
                      </span>
                      {isSelf && (
                        <span className="kz-num text-[10px] uppercase tracking-[0.12em] text-subtle">
                          you
                        </span>
                      )}
                      {member.system && (
                        <Badge tone="neutral">system</Badge>
                      )}
                    </div>
                    <p className="truncate text-[12.5px] text-subtle">
                      {member.email} · joined <TimeAgo iso={member.createdAt} />
                    </p>
                  </div>

                  <div className="hidden sm:block">
                    {canManage && !member.system ? (
                      <Select
                        aria-label={`Role for ${member.name}`}
                        value={member.role}
                        disabled={busy}
                        onChange={(event) =>
                          void act(() =>
                            fetch(`/api/workspaces/members/${member.userId}`, {
                              method: "PATCH",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ role: event.target.value }),
                            }),
                          )
                        }
                      >
                        {ROLES.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.value}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge tone="signal">{member.role}</Badge>
                    )}
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <span className="sm:hidden">
                      <Badge tone="signal">{member.role}</Badge>
                    </span>
                    {canManage && !member.system && !isSelf && (
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Remove ${member.name}`}
                        onClick={() =>
                          void act(() =>
                            fetch(`/api/workspaces/members/${member.userId}`, {
                              method: "DELETE",
                            }),
                          )
                        }
                        className="flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {canManage && (
        <Panel
          className="mt-6"
          title="Add a member"
          description="The account must already exist — KLYZ invites by email, not by creating logins."
        >
          <form
            onSubmit={(event) => void invite(event)}
            className="flex flex-wrap items-end gap-3"
          >
            <Field label="Email" htmlFor="kz-invite-email" className="min-w-[220px] flex-1">
              <Input
                id="kz-invite-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@example.com"
              />
            </Field>
            <Field label="Role" htmlFor="kz-invite-role">
              <Select
                id="kz-invite-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                {ROLES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.value}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !email.trim()}
              className="h-8"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <UserPlus className="h-4 w-4" aria-hidden />
              )}
              Add
            </Button>
          </form>
          <p className="mt-3 text-[12.5px] text-subtle">
            Looking for sessions, the audit trail or the workspace name?{" "}
            <Link href="/settings" className="text-fg underline decoration-line underline-offset-4 hover:decoration-strong">
              Open settings
            </Link>
            .
          </p>
        </Panel>
      )}
    </div>
  );
}
