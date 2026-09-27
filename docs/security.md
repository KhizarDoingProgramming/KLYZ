# Security architecture

How KLYZ decides *who you are*, *what you may do*, and *what never
leaves the server. Written for the next agent to read before touching
an API route.

---

## 1. Identity comes from a session, never from a header

| | |
|---|---|
| Credential | Opaque 32-byte token, `klyz_session`, `HttpOnly; SameSite=Lax; Path=/` (`; Secure` in production) |
| Storage | Only the **SHA-256** of the token is in `sessions.token_hash`; the raw value exists solely in the cookie |
| Lifetime | 30 days, sliding — refreshed at most once every 5 minutes so a read-heavy page does not write |
| Expiry | Expired rows are deleted on read; the sweeper clears the rest |

Entry points:

- **API routes** → `requireAuthenticatedActor(request)` in `src/lib/server/identity.ts`.
- **Server components** → `requireCurrentActor()` in `src/lib/server/session.ts`,
  which reads `cookies()`/`headers()` and calls the *same* `actorFromToken`.
  One implementation, two entry points.

`x-klyz-user` is gone. `x-klyz-workspace` survives only as a
**selection hint**: it is accepted exclusively when `workspace_members`
proves the signed-in account belongs there. Nothing in the body, query
string or path is ever treated as identity.

Login (`/api/auth/login`):

1. Rate limit per IP **and** per email (`KLYZ_LOGIN_RATE_LIMIT`).
2. One password check whose result is identical for "no such user" and
   "wrong password".
3. The session presented with the request is **revoked** (session
   fixation), then a new one is issued.

Passwords: `scrypt` (`node:crypto`), format `scrypt$N$r$p$salt$hash`.
The system seed account (`u_default`) has no password and cannot log in.

## 2. CSRF

Three independent defences, none of which depends on the others:

- `SameSite=Lax` — a cross-site form POST never carries the cookie.
- `assertSameOrigin()` — rejects any state-changing request whose
  `Origin`/`Referer` host differs from the request host. Requests with
  no `Origin` (curl, server-to-server, tests) are allowed, which is why
  a missing header is not a bypass: a browser always sends it for
  cross-site writes.
- No verb-noun confusion: every mutating route is `POST`/`PATCH`/`PUT`/
  `DELETE`, never a `GET` with side effects.

## 3. Authorization

Roles: `viewer < member < admin < owner` (`ROLE_ORDER`).

Permissions live in one place — `src/lib/server/authz.ts` — and routes
ask for a permission; nothing decides on its own that a role is
"probably fine".

| Role | Adds |
|---|---|
| `viewer` | read workflows, executions, integrations, members |
| `member` | + write/publish workflows, run and cancel executions, read/use credentials, read webhooks, queue stats, AI |
| `admin` | + delete workflows, manage credentials/integrations/webhooks/members, rename workspace, read audit |
| `owner` | + `workspace:manage`, `ownership:transfer` |

Workspace invariants (all enforced in `src/lib/server/workspaces.ts`):

- A role can never be granted **above the granter's own** role.
- Only an owner can grant `owner` or transfer ownership.
- The **last owner** cannot be demoted or removed.
- Membership is always checked against `workspace_members`, never
  against a stored list.

## 4. IDOR and cross-tenant reads

Every resource read goes through an ownership helper:

- `assertExecutionAccess` / `getOwnedRow` — `WHERE id = ? AND workspace_id = ?`
- `assertCredentialAccess`
- `assertWebhookAccess`
- `assertWorkflowAccess`, `assertWorkflowUsable`

A row belonging to another tenant answers **404**, exactly like an id
that never existed, so ids cannot be enumerated across workspaces.
Malformed ids are rejected earlier by `assertResourceId`.

The worker re-checks tenant integrity before it runs anything: the
`workflow_versions` row must match the execution's own `workflow_id`
**and** `workspace_id` (`src/lib/server/execution-runner.ts`).

## 5. Public surfaces

`/api/webhooks/...` and `/api/providers/<p>/hooks/<key>` are
authenticated by secret/HMAC rather than by a session, so they get
their own controls:

- payload capped at **1 MiB** (`413`) before any parse,
- per-IP rate limit (`KLYZ_WEBHOOK_RATE_LIMIT`, 600/min) plus a
  per-workspace ceiling (600/min) so one endpoint cannot be flooded
  from many addresses,
- signature/secret verified **before** anything is queued — a rejected
  delivery never creates an execution,
- the trigger's own enable switch, checked with the same 404 a missing
  endpoint returns (§8), and the workflow pinned to its published
  version.

## 6. Secrets

- Credential fields and webhook secrets are AES-256-GCM encrypted at
  rest (`KLYZ_CREDENTIAL_KEY`); the API returns metadata only — never a
  value, never a `secret`, only `secretSet`.
- `src/lib/server/redact.ts` runs over debugger output, log messages
  **and audit metadata**, so an audit row can never become a second
  copy of a secret.
- The AI key is attached to the outbound request only; it is never
  returned, logged or sent to the browser.

## 7. Workflow definitions are server-owned

The browser never decides what runs.

- **Draft.** `workflows.draft` holds the whole graph as JSON; the
  denormalised columns beside it (`name`, `trigger_type`,
  `node_count`, `published_version`) are what the list reads.
  `workflows.draft_revision` is compared against the revision the
  editor last saw, so a stale write answers **409
  REVISION_CONFLICT** carrying the current workflow — two tabs cannot
  silently clobber each other.
- **Published version.** `POST /api/workflows/[id]/publish` runs the
  shared `validateWorkflow`, then hashes the *normalised* graph
  (`stripWebhookSecrets` + `stripRuntimeState`, so a webhook secret or
  a transient `data.status` can never enter history) and inserts one
  `workflow_versions` row. The table is **append-only**: no statement
  in `src/` issues `UPDATE workflow_versions`, and a source scan in
  `workflow-service.test.ts` enforces that. Publishing an identical
  graph reuses the existing row, so history is not padded out. Needs
  `workflow:publish` (member+).
- **Pointer.** `workflows.published_version_id` is the only answer to
  "what is live". `published_version` is a denormalised copy for the
  list; when it is missing (a row written by an older build) the
  latest version row is the fallback.
- **Run pinning.** `POST /api/workflows/[id]/execute` accepts only
  `{ input, options }` — a `definition` in the body is ignored. The
  server resolves the draft, validates it, publishes it if the draft
  has moved on (again with the caller's permission) and records
  `executions.workflow_version_id`. An execution therefore always
  points at an immutable row, and the worker re-checks that row's
  `workflow_id` **and** `workspace_id` before it runs anything.
- **Delete is an archive.** `DELETE` sets `archived_at` and the
  workflow answers 404 on every workflow route. Nothing is ever taken
  away from a `workflow_version_id` that a past execution still
  references.
- **No credential values in a graph.** `assertNoCredentialValues`
  rejects any config key that reads like a secret (`token`, `apiKey`,
  `password`, `clientSecret`, …) holding a non-masked, non-`{{ref}}`
  value with **422 CREDENTIAL_VALUE_IN_DEFINITION** — on draft save,
  on publish *and* on run, so a row written before the check existed
  still cannot execute. The single exception is `trigger.webhook`'s
  `config.secret`, which is AES-GCM encrypted like every other
  credential. The only way to carry a secret into a step is a
  credential id.
- **The client copy is a cache.** The browser keeps a recovery copy
  in localStorage and re-imports it if the API is unreachable, but on
  boot it pulls `GET /api/workflows` first: anything the server has
  never seen is uploaded as a *new draft*, and anything the server has
  moved past is overwritten locally. The cache can never make a
  workflow "published" — only the server can set
  `published_version_id`.

## 8. Triggers are gated server-side

A workflow can be started three ways — a person pressing Run, an
inbound webhook, a schedule — and each is decided on the server:

- **`workflow_triggers`** holds one row per workflow KLYZ itself can
  fire: the enable switch, and for a schedule the cron expression,
  timezone and cursor. The editor's switch is a suggestion; the row is
  the answer.
- **A missing row is armed.** Workflows written before this table
  existed (and provider triggers, which keep their own endpoint card)
  behave exactly as they did. Absence can never become an accidental
  lock-out — only an explicit `enabled = 0` stops a run.
- **Manual runs keep their implicit publish** (§7), and are refused
  with `422 TRIGGER_DISABLED` when the switch is off.
- **Automatic triggers never publish.** A webhook delivery or a
  scheduled occurrence runs the workflow's *published* version, pinned
  by id. If nothing is published the webhook answers `404
  WEBHOOK_NOT_FOUND` and the scheduler records the occurrence as
  `skipped` — a trigger acting on nobody's behalf cannot invent a
  version.
- **One execution per occurrence.** `trigger_fires` is keyed on
  `(trigger_id, occurrence_key)`; two workers racing on the same tick
  both try to insert, exactly one wins, and only that one creates an
  execution. The cursor is advanced after the fire, so a crash re-offers
  the same key and the claim blocks it.
- **No backlog.** The cursor moves past *now*, never to the missed
  slots, so a worker that was down for a day resumes instead of
  replaying.
- **The receiver answers 404 for a disabled trigger** — the same 404 a
  missing endpoint gives, so switching a trigger off never confirms the
  URL exists.
- **The endpoint's own switch and the trigger's switch are ANDed.**
  Either one off stops deliveries; no secret, payload or header is
  logged, and audit metadata carries ids and the expression only.

The scheduler runs in the worker (`src/lib/server/scheduler.ts`),
inside the same process that consumes the queue — one loop, one queue,
one switch (`KLYZ_SCHEDULER_ENABLED=false`).

## 9. Audit

`src/lib/server/audit.ts` records `who / what / which resource` for
logins, role changes, credential and webhook operations, workspace
changes and executions. Rows are workspace-scoped at read time
(`listAuditFor`), so `/api/audit` can only ever show the acting
workspace's history. `audit:read` is admin-or-owner.

## 10. Rate limits

`src/lib/server/rate-limit.ts` — in-process fixed windows keyed by
`(scope, subject)`:

| Scope | Key | Limit |
|---|---|---|
| `login:email` / `login:ip` | email / IP | `KLYZ_LOGIN_RATE_LIMIT`, ×3 per IP |
| `register:ip` | IP | `KLYZ_REGISTER_RATE_LIMIT` per hour |
| `webhook:inbound` | IP | `KLYZ_WEBHOOK_RATE_LIMIT` (600/min) on both public receivers |
| `webhook:workspace` | workspace | 600/min on the sessionless receiver |
| `trigger:mutate` | workspace | 60/min (`PUT /api/workflows/[id]/trigger`) |
| `workflow:import` | workspace | 20/min (`POST /api/workflows/import`) |
| `template:write` | workspace | 30/min (create / update / delete / save-as-template) |
| `workflow:from_template` | workspace | 30/min (`POST /api/templates/[id]/create-workflow`) |
| `execution:start`, `credential:*`, `webhook:publish`, `members:mutate`, `workspace:*`, `oauth:start` | workspace | per-route, documented inline |

Deliberately per-process: KLYZ runs one API process and one worker.
The keys are already scoped so swapping in Redis touches only that
file.

## 11. Response headers

`next.config.ts` applies to every path: `X-Content-Type-Options`,
`X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`,
`Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, a CSP
with `frame-ancestors 'none'` / `object-src 'none'` / `base-uri
'self'` / `form-action 'self'`, and HSTS in production.

## 12. Error disclosure

`errorResponse` returns `HttpError` messages as written (they are the
message the user is meant to read). Anything else is an unexpected
failure: production returns a fixed sentence and logs the real error
server-side; development and tests keep the detail.

## 13. Portable workflow definitions, duplication and templates

Export, import, duplication and the template library are three
projections of one rule: **a definition may leave the workspace only as
data, and may enter it only through the validator.**

### The portable format (`klyz.workflow` v1)

`src/lib/workflow/portable.ts` owns the format; it is pure, has no
database handle and is the only place that knows the schema.

- **Projection, not a copy.** Export strips runtime state and webhook
  secrets with the same two functions the publish path hashes with, so
  an export and a published version agree about what the graph is. The
  result carries no workspace, session, user, execution, version,
  credential or timestamp — nothing that would leak tenancy or make two
  exports of one graph disagree. Node ids are normalised to
  type-derived ids (`http_1`, `condition_1`, …) and connections are
  renumbered to match; expressions are untouched because they name
  `data.ref`, which travels with the node.
- **Credentials never travel as values.** A credential field is
  replaced by `{provider, name}` and the id is deleted from the config.
  Webhook `secret` is always dropped. Defence in depth: after the
  structured pass, every remaining config value is run through
  `looksLikeSecret` and removed with a `warning_secret_removed` — so an
  export is the last gate before bytes leave the process, not the
  first.
- **Import is untrusted input.** `parsePortableWorkflow` caps the byte
  size (256 KB), step and connection counts, string lengths and nesting
  depth, rejects `__proto__`, and refuses a document whose config it
  had to truncate rather than silently accepting a mangled graph.
  Node capabilities are checked before anything is built, so a step
  this build does not have is a refusal, not a crash.
- **Nothing is published.** Import creates a *draft* through the normal
  authoring path — `parseDefinition` and `assertNoCredentialValues` run
  again on the way in, because defence in depth is cheaper than a bad
  publish — and `disarmScheduleTrigger` sets `enabled = 0` on any
  schedule so a file cannot start a production run by arriving.
- **Blocking vs. warning.** Structural problems (`capability_*`,
  `graph_cycle`, `no_trigger`, `edge_missing_*`, `edge_self_*`,
  `orphan_*`, `dup_ref_*`, `ref_*`, `expression_*`, `credential_value_*`,
  `import_*`) are **422**. Everything a person can finish in the
  editor — above all an unresolved connection — is a *requirement*
  plus a warning, and the draft is created anyway.
- **Explicit credential choices are validated.** `credentials` is keyed
  `<nodeId>.<field>`; each id must exist in *this* workspace and its
  kind must fit the field. Automatic mapping only ever matches on an
  exact `kind` + `name` with exactly one candidate; otherwise the field
  is left empty and reported. The importer never creates, guesses or
  copies a credential.
- **Body cap.** `POST /api/workflows/import` checks `Content-Length`
  *and* the bytes actually read against 512 KB before parsing, then
  applies `workflow:import` (20/min per workspace).

### Duplication

`duplicateWorkflowFor` copies the draft and nothing else: no published
version, no executions, no audit history. Two identity surfaces are
reset because they are *runtime*, not graph — the new workflow gets a
fresh id, every webhook node's `path` is rewritten through
`uniqueWebhookPath` and its `secret` is cleared, and `schedule` trigger
rows are disarmed so a copy cannot fire alongside its original.
Uniqueness is checked against published endpoints *and* the paths other
drafts are already claiming, so two copies cannot sit on the same path
and surface the clash as a failed publish.
Credential *references* are preserved (same workspace, ids not values);
the row itself is never duplicated.

### Templates

`templates` rows store the same portable document an export produces —
one schema, one validator, one migration path. Built-ins carry
`workspace_id = '*'`, a marker no workspace can hold, and are read-only
(`422 TEMPLATE_SYSTEM`). Writes are rate-limited
(`template:write`, 30/min per workspace) and capped at
`PORTABLE_LIMITS.maxTemplatesPerWorkspace` (200). Reads and writes map
onto the existing `workflow:read` / `workflow:write` permissions —
there is no second authorization model. Creating a workflow from a
template goes through the identical import path, including the schedule
disarm and the `workflow.created_from_template` audit row.

### Audit

`workflow.exported`, `workflow.imported`,
`workflow.created_from_template`, `workflow.duplicated`,
`template.created`, `template.updated`, `template.deleted`.

## 14. Known limitations

- **Registration enumeration**: `/api/auth/register` answers `409
  EMAIL_TAKEN`. Mitigate by setting `KLYZ_ALLOW_REGISTRATION=false`.
- **SSE access** is checked at connect time; membership is re-checked
  on every 15-second heartbeat, so a revoked subscriber is cut off
  within one beat rather than instantly.
- **Realtime cross-process relay** falls back to a 2-second database
  poll when Redis is unavailable, so the stream degrades instead of
  freezing.

## 15. Tests

`src/lib/server/security.test.ts` covers session authentication, role
enforcement, cross-tenant 404s, privilege escalation, brute-force
limits, CSRF origin checks, audit scoping, webhook payload caps, worker
tenant integrity and production error disclosure.

`src/lib/server/workflow-service.test.ts` covers the workflow authority
described in §7: draft revisions, the credential refusal, publish
permissions, version immutability (including the source scan for
`UPDATE workflow_versions`), execution pinning, the ignored client
definition, archiving, the trigger-table migration and
404-across-tenants on every route.

`src/lib/server/triggers.test.ts` covers §8: cron and timezone
validation, the enable switch on manual and webhook paths, publish
adopting the node's schedule, the scheduler's once-per-occurrence
claim, pinning to the published version, the never-publish rule, the
stale-row guard, cursor advancement, tenancy, role enforcement and the
audit trail.

`src/lib/workflow/portable.test.ts` covers §13 at the unit level: the
projection leaks no ids or timestamps, two exports of one definition
are byte-identical, credential ids and webhook secrets never survive an
export, the parser refuses a foreign or newer format and oversized
documents, import rewrites ids and connections together, and cycles,
malformed expressions and pasted secrets are refused while an unfilled
connection stays a requirement.

`src/lib/server/portability.test.ts` covers the same rules through the
real routes and a real database: export produces a download with no
workspace or credential id in the bytes, cross-tenant export answers
404, import creates an unpublished draft (or nothing at all on a dry
run), a copied schedule stays disabled, mapping by exact name and kind
succeeds while an unknown field is rejected, the body cap answers 413,
the rate limit answers 429, and both directions are audited.

`src/lib/server/templates.test.ts` covers §13's template half: the
built-ins are seeded once and live in every workspace, they refuse
edits and deletion, a workspace cannot see another's templates, viewers
read but cannot write, the 200-template ceiling holds, and a workflow
made from a template is an unpublished draft with its schedule off and
its outstanding connections reported.

`src/lib/server/workflow-service.test.ts` covers duplication: a copy
gets a fresh webhook path and starts unpublished with no versions, three
successive copies all end up on distinct paths, and the source keeps its
own identity.

`src/app/api/ai/workflows/generate/route.test.ts` asserts the builder's
own boundary: a successful generation writes no workflow, version,
trigger or execution row and emits no `workflow.*` audit action — the
plan is returned, and only the ordinary editor save can persist it.

All run against a real temporary SQLite database with real sessions —
no identity stubs.
