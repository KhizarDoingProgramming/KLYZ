# KLYZ integrations

KLYZ ships nine real integrations plus the credential store they rely on.
Everything below is implemented and covered by tests — nothing here is a
placeholder.

| Piece | Node types | Handler module |
| --- | --- | --- |
| HTTP request | `action.http` | `src/lib/integrations/http/` |
| PostgreSQL | `action.postgres`, `data.postgres` | `src/lib/integrations/postgres/` |
| Webhooks | `trigger.webhook` | `src/lib/integrations/webhook/` + `src/lib/server/webhooks.ts` |
| Data transform | `logic.transform`, `logic.operations` | `src/lib/integrations/transform/` |
| GitHub | `trigger.github`, `action.github_issue`, `action.github_comment` | `src/lib/integrations/github/` + `src/lib/server/provider-webhooks.ts` |
| Gmail | `trigger.gmail`, `action.gmail_send`, `action.gmail_reply`, `action.gmail_label`, `action.gmail_get` | `src/lib/integrations/gmail/` + `src/lib/server/oauth.ts` |
| Google Sheets | `action.sheets_append`, `action.sheets_read`, `action.sheets_write` | `src/lib/integrations/google_sheets/` |
| Notion | `action.notion_page`, `action.notion_search` | `src/lib/integrations/notion/` |
| Slack | `trigger.slack`, `action.slack_message`, `action.slack_channel` | `src/lib/integrations/slack/` + `src/lib/server/provider-webhooks.ts` |

All five providers — GitHub, Gmail, Google Sheets, Notion and Slack —
are **OAuth connections**: they are created on the Integrations page
(never through the generic credential form) and are shared by every node
that declares a `credential` of that kind. Google Sheets reuses the
Gmail Google OAuth client with its own redirect URI and spreadsheet-only
scopes, so a deployment that connects Gmail does not register a second
Google application.

Definitions shown in the editor come from `src/lib/integrations/definitions.ts`
(pure, client-safe); the handlers are loaded server-side through
`src/lib/integrations/registry.ts`, which the execution engine consults before
its built-in handlers.

---

## Credentials

Credentials are created and managed on the **Integrations** page
(`/integrations#credentials`) and picked inside steps that declare a
`credential` field.

* Keyed kinds: `postgres`, `http_basic`, `http_bearer`, `http_header`.
* OAuth-only kinds: `github`, `gmail`, `google_sheets`, `notion`, `slack`.
  `POST /api/credentials` answers `422 OAUTH_ONLY` for them — they come
  from the connect flow below and carry `status`, `account`, `scopes`,
  `expiresAt` and `lastError` on the credential row.
* Values are encrypted at rest with **AES-256-GCM**
  (`v1:<iv>:<tag>:<ciphertext>`). The key comes from `KLYZ_CREDENTIAL_KEY`
  (mandatory in production); in development a 0600 key file is generated at
  `.klyz/credentials.key`.
* The API (`GET/POST /api/credentials`, `PATCH/DELETE /api/credentials/[id]`)
  never returns secret values — only `id`, `name`, `kind` and timestamps.
* `POST /api/credentials/[id]/test` performs one real call server-side
  (`SELECT 1` for PostgreSQL, a guarded GET for HTTP kinds). The result is
  `{ ok, latencyMs, detail }`.
* Decryption happens only inside the worker for the duration of one node run;
  logs are redacted through `src/lib/server/redact.ts`.

---

## OAuth connections

| Route | What it does |
| --- | --- |
| `GET /api/providers` | Per-provider status: `configured`, `issues`, requested `scopes`, live `connections`, `watch`, `endpoint` |
| `POST /api/providers/<provider>/connect` | Returns `{ url, scopes, callbackUrl }` and stores a single-use `state` |
| `GET /api/providers/<provider>/callback` | Browser return leg: consumes the state, exchanges the code, upserts the credential, redirects to `?connected=`/`?error=` |
| `DELETE /api/providers/<provider>/connections/<id>` | Revokes a stored connection |
| `POST/DELETE /api/providers/gmail/watch` | `users.watch` / `users.stop` for push notifications |

* The `state` row holds workspace, user, redirect path and the PKCE
  verifier (Gmail only) for 10 minutes and is **claimed once**: a second
  use, an expired row or a state issued for another provider all answer
  `400 OAUTH_STATE_INVALID`.
* Missing environment never crashes the page — `providerOAuthStatus()`
  reports the offending variable (`GITHUB_CLIENT_ID is not set.`) and the
  Connect button turns into a remediation list.
* Redirect paths are sanitised server-side: only same-site paths survive
  (`//evil.example`, `https://evil.example`, `javascript:…` all collapse
  to `/integrations`).
* Scopes — GitHub asks for `public_repo` (override with `KLYZ_GITHUB_SCOPES`
  to add `repo` and `admin:repo_hook`); Gmail asks for `gmail.send`,
  `gmail.modify`, `gmail.readonly`, `openid`, `email`; Google Sheets asks
  for the `spreadsheets` scope plus `openid`/`email` (override with
  `KLYZ_GOOGLE_SHEETS_SCOPES` — never Drive: KLYZ never lists or creates
  files); Slack asks for bot scopes `chat:write`, `channels:read`,
  `groups:read`, `channels:history`, `groups:history` (override with
  `KLYZ_SLACK_SCOPES`); Notion sends **no scope parameter at all** — what
  the integration may touch is chosen in Notion's admin console.
* Google providers (Gmail, Google Sheets) use PKCE and request
  `access_type=offline&prompt=consent` so a refresh token is issued every
  time; Notion authenticates the token exchange with HTTP Basic + JSON
  rather than form-encoded body parameters.

### Local setup

1. Create a GitHub OAuth app with callback
   `http://localhost:3000/api/providers/github/callback`, or a Google
   web client with redirect URIs for both
   `…/api/providers/gmail/callback` and
   `…/api/providers/google_sheets/callback`, or a Notion internal
   integration, or a Slack app (Redirect URLs + Event Subscriptions URL).
2. Copy the client id/secret into `.env` (see `.env.example`). For Slack
   also copy the **Signing Secret** into `SLACK_SIGNING_SECRET` — without
   it a published Slack endpoint stays in an error state and refuses
   every delivery.
3. Reconnect from the Integrations page.

---

## GitHub

### Trigger (`trigger.github`)

Fields: **Connection**, **Event**, **Branch filter** (push only),
**Sample payload** (used only by a manual run). Eight events:
`issues.opened|edited|closed|reopened`, `pull_request.opened`,
`push`, `release.published`, `workflow_run.completed`.

Deliveries arrive at `POST /api/providers/github/hooks/<url_key>`:

* signature verified with HMAC-SHA256 over the raw body (`x-hub-signature-256`);
  a mismatch is `401 GITHUB_DELIVERY_REJECTED`;
* `ping` is acknowledged with `200` and starts nothing;
* the event must match the node's configured event **and** the branch
  filter, otherwise the delivery is recorded as `ignored` with `200`;
* a new delivery starts a run and answers `202 { executionId }`;
* GitHub's redeliveries are deduplicated on
  `(provider, workflow_id, delivery_id)` → `DuplicateDelivery`, one run.

Publishing (inspector → **Provider endpoint** card) calls
`PUT /api/workflows/[id]/provider-webhook` with the definition. The server
versions the definition, stores the row and — when `admin:repo_hook` was
granted — creates the hook on the repository. Without that scope
registration is refused, so the card shows a **warning** with the URL and
one-time secret to paste into GitHub's *Add webhook* form yourself. The
card also reports `deliveryCount`, `lastDeliveryStatus` and the target repo;
`DELETE` unpublishes and removes the remote hook.

Trigger output is the normalised event: `event`, `action`, `repository`,
`issueNumber`, `title`, `body`, `author`, `labels`, `url`, `branch`,
`commitMessage`, `receivedAt`, `raw`.

### Actions

| Node | Operations |
| --- | --- |
| `action.github_issue` | `create`, `update`, `get`, `search` (title, body, labels, assignees, state, query, max results) |
| `action.github_comment` | post `body` to an issue or PR |

Repository syntax is `owner/name`; issue numbers are positive integers.
API traffic goes only to the host allowlist `api.github.com` /
`uploads.github.com` (private networks and redirects refused).

---

## Gmail

### Trigger (`trigger.gmail`)

Fields: **Connection**, **Label**, **Search query**, **Only new messages**
(`cursor` / `any`), **Mark as read**.

The handler never invents mail: it calls `users.messages.list` with the
label, your query and `after:<cursor>` (`cursor` is the `internalDate` of
the last message this connection consumed), then fetches that one message
with `messages.get`. No match raises `GMAIL_MESSAGE_NOT_FOUND` with the
exact label/query/cursor in the detail and a hint to loosen the filter or
switch to “newest match”. `markRead` removes `UNREAD` after pickup.

Push: `POST/DELETE /api/providers/gmail/watch` calls `users.watch` against
`GOOGLE_PUBSUB_TOPIC`; the subscription row records `historyId`, `cursor`,
`expiresAt` and `lastError`, and the trigger renews it on the next run when
`watchNeedsRenewal()` says so. Deliveries reach
`POST /api/providers/gmail/hooks/<url_key>`, where the OIDC token in
`authorization` is verified against Google's JWKS (issuer, audience,
signature, `exp`/`iat`) — see `src/lib/server/google-oidc.ts`.

### Actions

| Node | What it does |
| --- | --- |
| `action.gmail_send` | `users.messages.send` — to/cc/bcc, subject, plain or HTML body |
| `action.gmail_reply` | replies on the thread of `messageId` (`In-References`/`In-Reply-To`) |
| `action.gmail_label` | `add` or `remove` a label on a message |
| `action.gmail_get` | `users.messages.get` — `full`, `metadata` or `raw` |

Addresses are validated by `parseEmail` (local part, multi-label domain —
`dana@ops.northwind.co.uk` is valid); one bad recipient fails the step with
`GMAIL_RECIPIENT_INVALID` rather than sending a partial message. Payloads
are base64url-encoded RFC 2822 built by `buildRawMessage` (subject RFC 2047
encoded, UTF-8 headers).

---

## Google Sheets

One Google OAuth client serves Gmail **and** Sheets: the Sheets
connection uses its own callback (`/api/providers/google_sheets/callback`)
and its own scopes, and is stored as kind `google_sheets`, so a Sheets
step can never be handed a Gmail credential.

The spreadsheet may be pasted as a URL or as an id —
`parseSpreadsheetId` accepts `docs.google.com/spreadsheets/d/<id>/edit`
and rejects anything else with `SHEETS_SPREADSHEET_INVALID`. Ranges are
A1 notation (`Leads!A:D`); the sheet name and range are joined by
`buildRange` and quoted only when A1 would misread the tab name.

| Node | Operations |
| --- | --- |
| `action.sheets_append` | append one row from the `values` key/value list, written in sheet order |
| `action.sheets_read` | `get` a range (optional header row, `limit` 1–5000) or `find` a row by `column` + `match` (`exact` / `contains` / `startsWith`) |
| `action.sheets_write` | `update` one row by row number, or `clear` a range — clearing is refused with `SHEETS_CLEAR_UNCONFIRMED` until **Confirm clear** is on |

Outputs are the `rowNumber` the step touched, `updatedRows` /
`updatedCells`, the resolved `range`, `spreadsheetUrl` and the values
written or read back. `action.sheets_read` also returns `columns` and
`rowCount`: a `find` with no match returns `rows: []`, `rowCount: 0` and
`rowNumber: 0` rather than an error, so a Condition decides what happens
next. A column that does not exist *does* fail — `SHEETS_CONFIG_INVALID`
lists the columns the sheet actually has.

API traffic goes to `sheets.googleapis.com` only, with the access token
from the connection; ranges are never built by interpolating user text
into a query string.

---

## Notion

Notion has no scope parameter: capabilities are granted to the
integration in Notion's admin console, and only pages/databases shared
with that integration are reachable. The token exchange uses HTTP Basic
(`tokenAuthStyle: "basic"`) with a JSON body, which is what
`/v1/oauth/token` requires.

Ids are accepted with or without dashes — `parseNotionId` normalises
`8f2a91c0-d17b-4c2e-a1b0-c4d5e6f7a8b9` and the 32-character form to the
dashed form the API expects, and rejects anything else with
`NOTION_PAGE_ID_INVALID`. A pasted Notion URL works too.

| Node | Operations |
| --- | --- |
| `action.notion_page` | `create` (parent `database` or `page`, title, optional plain-text content, properties), `update` (properties, optional archive), `get` |
| `action.notion_search` | query across pages and databases (`kind`: all/page/database), `limit` 1–50, default 20 |

On create under a database the handler reads the schema first
(`databases/<id>`) so `Status: Triage` is written as the select/status
value it really is — property types can be forced per step through
`propertyTypes` for page parents or schemas the reader cannot see. Types
outside the supported set fail with `NOTION_PROPERTY_UNSUPPORTED` naming
the property and its type; an empty update fails with
`NOTION_CONFIG_INVALID` instead of sending a no-op request.

Outputs are `page` (id, title, url, timestamps, archived, properties,
parent, raw), `pageId`, `url`, `title` and `operation`; search returns
`results`, `result` (the first hit) and `count`.

---

## Slack

A Slack **app** (not a workspace token): the connection is an OAuth bot
token stored as kind `slack`, and every node takes **Connection** plus
its own fields. Channel references accept `#engineering` or a channel id
(`C…`); ids are compared directly and names are resolved through a
60-second, 100-entry lookup cache so a workflow does not re-list channels
on every run.

### Trigger (`trigger.slack`)

Fields: **Connection**, **Channel** (optional — empty runs on any channel
the app can see), **Include bot messages** (off by default).

Publishing (inspector → **Provider endpoint** card) stores a *manual*
endpoint at `POST /api/providers/slack/hooks/<url_key>` and returns a
warning while `SLACK_SIGNING_SECRET` is unset — without it the endpoint
is published in an `error` state and every delivery is refused rather
than accepted unsigned. Set the secret and publish again.

Each delivery is handled in this order:

1. **Signature** — `x-slack-signature` is verified against the raw bytes
   (`v0=<hmac-sha256 of "v0:<timestamp>:<body>">`) with the secret stored
   on the endpoint row. A missing, malformed, stale (outside five
   minutes) or mismatched signature is `401 SLACK_SIGNATURE_REJECTED`.
2. **`url_verification`** — answered with `{ challenge }`, no run.
3. **Event shape** — only `event_callback` → `event.type === "message"`
   with no `subtype` counts; anything else is answered `200` and recorded
   as `ignored`, because Slack retries any other status. Bot messages
   (`bot_id`) are dropped unless the node turned on **Include bot
   messages**, so a workflow can never re-trigger on its own post.
4. **Workspace** — the delivery's `team_id` must match the `teamId` on
   the trigger's connection (one Events URL serves every workspace the
   app is installed in); a mismatch is `403 SLACK_TENANT_MISMATCH`.
5. **Channel** — the node's channel is compared by id, or resolved by
   name through the cache; a channel that cannot be resolved is *not* a
   match.

A run starts on `202 { executionId }`. `event_id` is the idempotency key,
so Slack's redeliveries land on the run that already exists
(`DuplicateDelivery` → `200`).

Trigger output is the normalised message: `channel`, `channelName`,
`userId`, `userName`, `text`, `ts`, `threadTs`, `teamId`, `botId`,
`receivedAt`, `raw`.

### Actions

| Node | Operations |
| --- | --- |
| `action.slack_message` | `send` to a channel (with `notify`: none / `@here` / `@channel`) or `reply` in a thread (`threadTs` is required and never starts a new top-level message) |
| `action.slack_channel` | `find` a channel by name or id, or read `info` about one |

Slack returns **HTTP 200 with `{ ok: false, error: … }`** for API
failures, so `src/lib/integrations/slack/api.ts` is the one place that
reads `ok` and converts the error into a normalised `ProviderError` —
handlers only ever see successes or errors in the shared vocabulary
(`SLACK_CHANNEL_INVALID`, `SLACK_MESSAGE_EMPTY`, `SLACK_THREAD_INVALID`,
`SLACK_CONFIG_INVALID`).

Outputs: `action.slack_message` returns `ts`, `threadTs`, `channel`,
`channelName`, `text`, `operation`; `action.slack_channel` returns a
`channel` object (id, name, privacy, membership, topic, purpose, member
count, archived) plus `found`, so a Condition can branch on a missing
channel.

---

## HTTP request (`action.http`)

* **SSRF policy** — every target is resolved through `dns.lookup` and the
  addresses are classified (loopback, private, link-local, CGNAT, metadata).
  Private/loopback targets are rejected unless `KLYZ_HTTP_ALLOW_PRIVATE=true`.
  `KLYZ_HTTP_ALLOW_HOSTS` is a comma-separated allowlist supporting exact
  hosts, `host:port`, `*` and `*.suffix` entries.
* **Redirects** are followed manually (max 5) and every hop is re-validated
  against the same policy.
* **Auth** — `none`, `bearer`, `basic`, `header` (inline values), or a stored
  credential which supplies the headers instead.
* **Limits** — 10 s default timeout (configurable per node, keep it below the
  15 s step timeout), response cap `KLYZ_HTTP_MAX_RESPONSE_BYTES`
  (default 1 MiB), sensitive response headers redacted from outputs.
* **Retries** — the node declares failures as *retryable* (timeouts, DNS,
  refused connections, 408/429/5xx) and lets the engine's attempt loop back
  off; permanent failures (bad URL, blocked target, other 4xx) fail
  immediately. `allowFailure` turns non-2xx responses into `ok: false`
  output instead of an error so a Condition can branch.

---

## PostgreSQL (`action.postgres`, `data.postgres`)

`action.postgres` offers four operations:

| Operation | Fields |
| --- | --- |
| `query` — raw SQL | `query`, `params`, `readMode` (`rows`/`count`/`none`) |
| `select` | `table`, `columns`, `where`, `orderBy`, `limit` |
| `insert` | `table`, `values`, `returning` |
| `update` | `table`, `set`, `where` (WHERE is mandatory) |

`data.postgres` is the read flavour: `query` (SELECT/WITH only), `params`,
`limit`.

Safety rules enforced in `src/lib/integrations/postgres/sql.ts`:

* one statement only — `;` beyond the statement ends the query;
* leading keyword must be `select|insert|update|delete|with`;
* identifiers must match `^[A-Za-z_][A-Za-z0-9_]*$` and table names are
  schema-qualified-checked (`schema.table` allowed);
* every value is bound through `$1, $2 …` — values are never interpolated;
* an `UPDATE`/`DELETE` without `WHERE` is refused;
* row limits are applied in the database by wrapping the statement.

Connections are short-lived (`max: 1`, 5 s connect timeout, 12 s query
timeout) using the stored credential or `connectionString`.

---

## Webhooks (`trigger.webhook`)

Workflow definitions live in the browser (localStorage) until published.
**Publishing** an endpoint:

1. Select the webhook trigger and fill in `path`, `method`, `auth` (+
   `secret` when auth is not `none`).
2. The **Endpoint** card in the inspector calls
   `PUT /api/workflows/[id]/webhook` with the full definition plus that
   config.
3. The server versions the definition with the secret stripped
   (`stripWebhookSecrets`, called inside `upsertWorkflowVersion`) and
   upserts the `webhooks` row, which is the runtime source of truth.
   Rotating a secret does not create a new workflow version.

After publishing the card shows the copyable URL, method, auth mode,
delivery count/last status and a redacted payload sample.
`DELETE /api/workflows/[id]/webhook` unpublishes.

### Calling an endpoint

```bash
# canonical URL (slug) — shown in the endpoint card
curl -X POST https://your-host/api/webhooks/wh_BASE64URL \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","source":"pricing-page"}'

# or by the configured path (e.g. path = /hooks/leads)
curl -X POST https://your-host/api/webhooks/hooks/leads -d '{...}'
```

The receiver (`src/app/api/webhooks/[...key]/route.ts`) accepts
`GET/POST/PUT/PATCH/DELETE` matching the endpoint method and answers
**202 Accepted** with `{ executionId, status, receivedAt }`.

### Authentication modes

| Mode | How the caller proves itself |
| --- | --- |
| `none` | Anyone who knows the URL can call it |
| `header` | Send the shared secret in `x-klyz-webhook-secret` |
| `hmac` | Send `x-klyz-signature` (or `x-hub-signature-256`) = `sha256=<hex>`, the HMAC-SHA256 of the **raw body** keyed with the secret |

Comparisons are timing-safe. Secrets live only in the encrypted
`webhooks.secret_enc` column; the versioned definition never contains them.

Failures: `404 WEBHOOK_NOT_FOUND` (no enabled endpoint),
`405 WEBHOOK_METHOD_NOT_ALLOWED`, `401 WEBHOOK_AUTH_FAILED`.

---

## Data transform

* **`logic.transform`** — JSON mapping with `{{references}}`; the result is
  available as `value`.
* **`logic.operations`** — one real operation per node: `filter`, `map`,
  `pick`, `rename`, `sort`, `dedupe`, `flatten`, `slice`, `first`, `last`,
  `aggregate` (`count`/`sum`/`avg`/`min`/`max`), `get`, `to_json`,
  `from_json`. Plain strings are paths (tried on the item first, then the
  run scope); strings containing `{{ … }}` are evaluated per item as
  expressions. No `eval` anywhere.

---

## Error codes

All integration errors carry a stable code, a safe message and an optional
remediation (`inspect` / `retry` / `reconnect`). `retryable` codes are
re-run by the engine's attempt loop with exponential backoff.

| Code | Meaning | Retryable |
| --- | --- | --- |
| `HTTP_URL_INVALID` | The URL cannot be parsed | no |
| `HTTP_BLOCKED_TARGET` | Private/blocked host or disallowed by policy | no |
| `HTTP_CREDENTIAL_INVALID` | Missing/unusable auth material | no |
| `HTTP_DNS_FAILURE` | Host did not resolve | yes |
| `HTTP_CONNECTION_FAILED` | Connection refused/reset | yes |
| `HTTP_TIMEOUT` | Request exceeded the timeout | yes |
| `HTTP_STATUS` | Non-2xx response (unless `allowFailure`) | 408/429/5xx yes, other 4xx no |
| `HTTP_RESPONSE_TOO_LARGE` | Body exceeded the cap | no |
| `POSTGRES_CREDENTIAL_INVALID` | Credential missing fields | no |
| `POSTGRES_CONNECTION_FAILED` | Could not connect | yes |
| `POSTGRES_TIMEOUT` | Query exceeded the timeout | yes |
| `POSTGRES_INVALID_QUERY` | Violates the SQL safety rules | no |
| `POSTGRES_QUERY_FAILED` | Database rejected the statement | no |
| `WEBHOOK_NOT_FOUND` | No enabled endpoint for this URL | no |
| `WEBHOOK_METHOD_NOT_ALLOWED` | Method does not match the endpoint | no |
| `WEBHOOK_AUTH_FAILED` | Secret/HMAC verification failed | no |
| `WEBHOOK_WORKFLOW_INACTIVE` | Published workflow is not runnable | no |
| `TRANSFORM_INVALID_CONFIG` | Operation misconfigured (e.g. unknown op) | no |
| `TRANSFORM_INVALID_EXPRESSION` | `{{…}}` expression could not be evaluated | no |
| `GITHUB_REPOSITORY_INVALID` | Repository is not `owner/name` | no |
| `GITHUB_ISSUE_NUMBER_INVALID` | Issue number is not a positive integer | no |
| `GITHUB_CONFIG_INVALID` | GitHub step missing/invalid config (incl. sample payload) | no |
| `GITHUB_DELIVERY_REJECTED` | Provider signature did not match the endpoint secret | no |
| `GMAIL_RECIPIENT_INVALID` | A to/cc/bcc address failed validation | no |
| `GMAIL_CONFIG_INVALID` | Gmail step missing/invalid config (label, body…) | no |
| `GMAIL_MESSAGE_NOT_FOUND` | No mail matched the trigger label/query/cursor | no |
| `SHEETS_CONFIG_INVALID` | Step missing config, or a column the sheet does not have | no |
| `SHEETS_SPREADSHEET_INVALID` | Spreadsheet id/URL could not be parsed | no |
| `SHEETS_RANGE_INVALID` | Range/A1 notation could not be parsed | no |
| `SHEETS_CLEAR_UNCONFIRMED` | Clear requested before **Confirm clear** was turned on | no |
| `NOTION_CONFIG_INVALID` | Step missing config, empty update, or an unsupported property value | no |
| `NOTION_PAGE_ID_INVALID` | Page id or URL could not be parsed | no |
| `NOTION_PARENT_INVALID` | Parent is neither a database nor a page | no |
| `NOTION_PROPERTY_UNSUPPORTED` | Property type outside the supported set (named in the message) | no |
| `SLACK_CONFIG_INVALID` | Slack step missing config | no |
| `SLACK_CHANNEL_INVALID` | Channel unknown to this app (not visible / not invited) | no |
| `SLACK_MESSAGE_EMPTY` | Nothing to post | no |
| `SLACK_THREAD_INVALID` | Reply with no thread timestamp | no |
| `SLACK_SIGNATURE_REJECTED` | Slack delivery unsigned, stale or signed with another secret | no |
| `SLACK_TENANT_MISMATCH` | Delivery belongs to another workspace than the connection | no |
| `<P>_AUTHENTICATION` | Token missing/expired — **reconnect** on Integrations | no |
| `<P>_AUTHORIZATION` | Granted scope does not allow this call — **reconnect** | no |
| `<P>_VALIDATION` | Provider rejected the request body | no |
| `<P>_NOT_FOUND` | Repository/issue/message does not exist | no |
| `<P>_RATE_LIMIT` | Provider rate limit (429) | yes |
| `<P>_TIMEOUT` | Provider timed out (408/504) | yes |
| `<P>_PROVIDER_UNAVAILABLE` | 5xx from the provider | yes |
| `<P>_NETWORK` | DNS/connection failure reaching the provider | yes |
| `<P>_UNKNOWN` | Unclassified provider failure | no |

`<P>` is `GITHUB`, `GMAIL`, `GOOGLE_SHEETS`, `NOTION` or `SLACK` — these
codes are generated by
`ProviderError.code` in `src/lib/integrations/provider/errors.ts`, which is
also what maps each category to a remediation (`reconnect` / `retry` /
`inspect`).

### Connect flow errors

| Code | Status | Meaning |
| --- | --- | --- |
| `PROVIDER_NOT_CONFIGURED` | 422 | Client id/secret missing — `details.issues` names the variable |
| `OAUTH_STATE_MISSING` / `OAUTH_CODE_MISSING` | 400 | Callback arrived without `state` or `code` |
| `OAUTH_STATE_INVALID` | 400 | State unknown, expired, already used, or issued for another provider |
| `NO_CONNECTION` | 422 | Gmail watch requested before an account is connected |
| `UNKNOWN_PROVIDER` | 404 | Not a supported provider (or watch on a non-Gmail provider) |

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `KLYZ_CREDENTIAL_KEY` | dev key file | AES-256-GCM key (required in production) |
| `KLYZ_PUBLIC_URL` | empty | Base URL for webhook **and** OAuth callback URLs |
| `KLYZ_HTTP_ALLOW_HOSTS` | empty | Egress allowlist (`host`, `host:port`, `*`, `*.suffix`) |
| `KLYZ_HTTP_ALLOW_PRIVATE` | `false` | Allow private/loopback targets (tests only) |
| `KLYZ_HTTP_MAX_RESPONSE_BYTES` | `1048576` | Response size cap |
| `KLYZ_PG_URL` | — | PostgreSQL target for tests/demo (`docker compose` service `postgres`) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | empty | GitHub OAuth app; unset disables GitHub connect |
| `GITHUB_CALLBACK_URL` | derived | GitHub authorization callback URL |
| `KLYZ_GITHUB_SCOPES` | `public_repo` | Add `repo` (private repos) and `admin:repo_hook` (auto hooks) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | empty | Google OAuth client; unset disables Gmail connect |
| `GOOGLE_CALLBACK_URL` | derived | Google redirect URI |
| `KLYZ_GOOGLE_SCOPES` | `gmail.send,gmail.modify,gmail.readonly,openid,email` | Scope override |
| `GOOGLE_PUBSUB_TOPIC` | empty | Pub/Sub topic for Gmail push; unset disables watch |
| `GOOGLE_SHEETS_CALLBACK_URL` | derived | Google Sheets redirect URI (same client as Gmail) |
| `KLYZ_GOOGLE_SHEETS_SCOPES` | `spreadsheets,openid,email` | Sheets scope override |
| `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` | empty | Notion internal integration; unset disables Notion connect |
| `NOTION_CALLBACK_URL` | derived | Notion redirect URI |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | empty | Slack app; unset disables Slack connect |
| `SLACK_CALLBACK_URL` | derived | Slack redirect URL |
| `SLACK_SIGNING_SECRET` | empty | Verifies Events API deliveries; unset → Slack endpoint publishes in `error` and refuses every delivery |
| `KLYZ_SLACK_SCOPES` | `chat:write,channels:read,groups:read,channels:history,groups:history` | Slack bot-scope override |

See `.env.example` for the full list including queue settings.

---

## Runnable demo workflows

Three demos only use node types with real handlers:

| Demo | Flow | Prerequisites |
| --- | --- | --- |
| **Lead Capture** (`wf_lead_capture`) | webhook → transform → PostgreSQL insert → log | stored `postgres` credential, a `leads` table |
| **Partner Event Relay** (`wf_partner_relay`) | webhook → HTTP POST → transform → log | outbound internet (postman-echo.com) |
| **Daily Lead Report** (`wf_daily_lead_report`) | manual → PostgreSQL read → aggregate → log | stored `postgres` credential, a `leads` table |

Three more ship as **drafts** that use only GitHub/Gmail nodes with real
handlers (published endpoints and an OAuth connection are still required
before a run):

| Draft | Flow |
| --- | --- |
| **Urgent Issue Alert** (`wf_urgent_issue_alert`) | GitHub `issues.opened` → condition (`title` contains `urgent`) → Gmail send / log |
| **Weekly Tracking Issue** (`wf_weekly_tracking_issue`) | schedule (09:00 weekdays) → create GitHub issue → log |
| **Push to Inbox** (`wf_push_to_inbox`) | GitHub push on `main` → Gmail send |

The remaining demos (`GitHub Issue Triage`, `Customer Intake`,
`Support Email Triage`, `Release Notes Draft`) mix providers — GitHub or
Gmail or a webhook into Slack, Notion and Google Sheets. Those steps have
real handlers now; they run as soon as the matching connection is picked
on the step (the demo ships them with an empty `credential` on purpose,
so nothing silently posts to a real account). `Nightly Metrics Sync` and
`CRM Account Sync` still end in a PostgreSQL step, which needs a stored
database credential and a table.

Create the credential first (Integrations page), then select it on the
PostgreSQL step — validation blocks a run until the required credential is
chosen. Example table for the demos:

```sql
create table public.leads (
  id serial primary key,
  email text not null,
  source text,
  created_at timestamptz default now()
);
```

Publish the webhook endpoint from the inspector's Endpoint card, then:

```bash
curl -X POST http://localhost:3000/api/webhooks/hooks/leads \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","source":"pricing-page"}'
```

---

## Tests

```bash
npm run infra:up     # redis + postgres in Docker (once)
npm test             # unit + infra suites
npm run test:unit    # unit only (memory queue driver)
```

For a full manual pass against a running dev stack
(`npm run infra:up` + `npm run dev:all`):

```bash
npx tsx scripts/e2e.ts
```

It drives the real HTTP surface — credential CRUD/test, webhook
publish/receive/auth, and all three demo workflows — and prints
PASS/FAIL per check.

Integration unit tests live next to the code
(`src/lib/integrations/**`); suites that need live Redis/PostgreSQL are
named `*.infra.test.ts` and fail with setup instructions when the
containers are not reachable — they never silently skip.
